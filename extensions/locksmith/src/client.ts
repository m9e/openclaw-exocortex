import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  resolveLocksmithAdminToken,
  resolveLocksmithBaseUrl,
  resolveLocksmithCatalogTtlMs,
  resolveLocksmithInboundToken,
  resolveLocksmithMaxResponseBytes,
  resolveLocksmithTimeoutMs,
} from "./config.js";

export type LocksmithDiscoveredTool = {
  name: string;
  type?: string;
  path?: string;
  description?: string;
};

type LocksmithDiscoveryResponse = {
  tools?: LocksmithDiscoveredTool[];
};

export type LocksmithHealth = {
  status?: string;
  uptime_seconds?: number;
  tools?: string[];
  version?: string;
};

export type LocksmithCallParams = {
  cfg?: OpenClawConfig;
  tool: string;
  user?: string;
  method?: string;
  path?: string;
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  json?: unknown;
  body?: string;
  timeoutSeconds?: number;
  maxResponseBytes?: number;
};

export type LocksmithCallResult = {
  ok: boolean;
  url: string;
  status: number;
  statusText: string;
  contentType: string;
  headers: Record<string, string>;
  bodyType: "json" | "text" | "base64";
  data?: unknown;
  text?: string;
  bodyBase64?: string;
};

/**
 * Closed-union error code for distinguishing service-state outcomes that the
 * agent and CLI render differently. See plan §2 (client) and §5 (offline).
 */
export type LocksmithErrorCode =
  | "service-unreachable"
  | "tool-absent"
  | "service-disabled"
  | "request-failed";

export class LocksmithError extends Error {
  readonly code: LocksmithErrorCode;
  readonly status?: number;
  readonly tool?: string;

  constructor(params: {
    code: LocksmithErrorCode;
    message: string;
    status?: number;
    tool?: string;
    cause?: unknown;
  }) {
    super(params.message, params.cause === undefined ? undefined : { cause: params.cause });
    this.name = "LocksmithError";
    this.code = params.code;
    this.status = params.status;
    this.tool = params.tool;
  }
}

function isUnreachableNetworkError(error: unknown): boolean {
  if (error instanceof LocksmithError) {
    return false;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      const codes = new Set([
        "ECONNREFUSED",
        "ECONNRESET",
        "ETIMEDOUT",
        "EAI_AGAIN",
        "ENOTFOUND",
        "EHOSTUNREACH",
        "ENETUNREACH",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_SOCKET",
      ]);
      if (codes.has(code)) {
        return true;
      }
    }
    // fetch() in Node wraps low-level connect/timeout errors as TypeError("fetch failed").
    if (error.name === "TypeError" && /fetch failed/i.test(error.message)) {
      return true;
    }
  }
  return false;
}

function compareToolNames(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortLocksmithTools<T extends { name: string }>(tools: T[]): T[] {
  return [...tools].toSorted((a, b) => compareToolNames(a.name, b.name));
}

type CacheEntry = {
  expiresAt: number;
  promise: Promise<LocksmithDiscoveredTool[]>;
};

const discoveryCache = new Map<string, CacheEntry>();
const HIDDEN_REQUEST_HEADERS = new Set(["authorization", "proxy-authorization", "x-api-key"]);
const EXPOSED_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "etag",
  "last-modified",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]);

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "");
}

function buildAuthHeaders(cfg?: OpenClawConfig, user?: string): Headers {
  const headers = new Headers();
  const inboundToken = resolveLocksmithInboundToken(cfg);
  if (inboundToken) {
    headers.set("Authorization", `Bearer ${inboundToken}`);
  }
  const trimmedUser = typeof user === "string" ? user.trim() : "";
  if (trimmedUser) {
    headers.set("X-Locksmith-User", trimmedUser);
  }
  return headers;
}

function appendQuery(url: URL, query: Record<string, unknown> | undefined): void {
  if (!query) {
    return;
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || key.trim() === "") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
          url.searchParams.append(key, String(item));
        }
      }
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      url.searchParams.set(key, String(value));
    }
  }
}

function normalizeRelativePath(input: string | undefined): string {
  if (!input) {
    return "";
  }
  return input.replace(/^\/+/u, "");
}

function isJsonContentType(contentType: string): boolean {
  return /\bjson\b/iu.test(contentType);
}

function isTextualContentType(contentType: string): boolean {
  return (
    isJsonContentType(contentType) ||
    /^text\//iu.test(contentType) ||
    /\b(xml|yaml|x-www-form-urlencoded|javascript)\b/iu.test(contentType)
  );
}

function filterResponseHeaders(headers: Headers): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    const normalizedKey = key.toLowerCase();
    if (EXPOSED_RESPONSE_HEADERS.has(normalizedKey)) {
      filtered[normalizedKey] = value;
    }
  }
  return filtered;
}

async function readBodyWithLimit(
  response: Response,
  maxResponseBytes: number,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed) && parsed > maxResponseBytes) {
      throw new Error(
        `Locksmith response too large: ${parsed} bytes exceeds configured max of ${maxResponseBytes} bytes.`,
      );
    }
  }

  const body = response.body;
  if (!body) {
    return new Uint8Array();
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maxResponseBytes) {
      throw new Error(
        `Locksmith response exceeded configured max of ${maxResponseBytes} bytes while streaming.`,
      );
    }
    chunks.push(value);
  }

  if (chunks.length === 0) {
    return new Uint8Array();
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function cacheKey(cfg?: OpenClawConfig): string {
  return [resolveLocksmithBaseUrl(cfg), resolveLocksmithInboundToken(cfg) ?? ""].join("::");
}

export function resetLocksmithDiscoveryCacheForTest(): void {
  discoveryCache.clear();
}

async function fetchJson<T>(params: {
  cfg?: OpenClawConfig;
  url: string;
  timeoutMs: number;
}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(params.url, {
      headers: buildAuthHeaders(params.cfg),
      signal: AbortSignal.timeout(params.timeoutMs),
    });
  } catch (error) {
    if (isUnreachableNetworkError(error)) {
      throw new LocksmithError({
        code: "service-unreachable",
        message: `Locksmith service unreachable at ${params.url}`,
        cause: error,
      });
    }
    throw error;
  }
  if (!response.ok) {
    throw new LocksmithError({
      code: "request-failed",
      status: response.status,
      message: `Locksmith request failed (${response.status} ${response.statusText}) for ${params.url}`,
    });
  }
  return (await response.json()) as T;
}

export async function listLocksmithTools(cfg?: OpenClawConfig): Promise<LocksmithDiscoveredTool[]> {
  const key = cacheKey(cfg);
  const now = Date.now();
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  const promise = (async () => {
    const payload = await fetchJson<LocksmithDiscoveryResponse>({
      cfg,
      url: `${normalizeBaseUrl(resolveLocksmithBaseUrl(cfg))}/tools`,
      timeoutMs: resolveLocksmithTimeoutMs(cfg),
    });
    const raw = Array.isArray(payload.tools)
      ? payload.tools
          .filter(
            (tool): tool is LocksmithDiscoveredTool => !!tool && typeof tool.name === "string",
          )
          .map((tool) => ({
            name: tool.name,
            type: tool.type,
            path: tool.path,
            description: tool.description,
          }))
      : [];
    // Sort by normalized lowercase name so CLI/prompt ordering is deterministic
    // regardless of upstream /tools response order. See plan §5.
    return sortLocksmithTools(raw);
  })();

  discoveryCache.set(key, {
    expiresAt: now + resolveLocksmithCatalogTtlMs(cfg),
    promise,
  });

  try {
    return await promise;
  } catch (error) {
    discoveryCache.delete(key);
    throw error;
  }
}

export async function fetchLocksmithHealth(cfg?: OpenClawConfig): Promise<LocksmithHealth> {
  return await fetchJson<LocksmithHealth>({
    cfg,
    url: `${normalizeBaseUrl(resolveLocksmithBaseUrl(cfg))}/health`,
    timeoutMs: resolveLocksmithTimeoutMs(cfg),
  });
}

async function readResponseErrorBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) {
      return undefined;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (isJsonContentType(contentType)) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  } catch {
    return undefined;
  }
}

function extractServiceErrorType(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return undefined;
  }
  const type = (error as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

export async function callLocksmith(params: LocksmithCallParams): Promise<LocksmithCallResult> {
  const method = (params.method ?? "GET").toUpperCase();
  const relativePath = normalizeRelativePath(params.path);
  const baseUrl = normalizeBaseUrl(resolveLocksmithBaseUrl(params.cfg));
  const url = new URL(`/api/${params.tool}/${relativePath}`, `${baseUrl}/`);
  appendQuery(url, params.query);

  const headers = buildAuthHeaders(params.cfg, params.user);
  if (params.headers) {
    for (const [key, value] of Object.entries(params.headers)) {
      const normalizedKey = key.trim().toLowerCase();
      if (
        !normalizedKey ||
        HIDDEN_REQUEST_HEADERS.has(normalizedKey) ||
        normalizedKey === "x-locksmith-user"
      ) {
        continue;
      }
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        headers.set(key, String(value));
      }
    }
  }

  let body: string | undefined;
  if (params.json !== undefined && params.body !== undefined) {
    throw new Error("locksmith_call accepts either json or body, but not both.");
  }
  if (params.json !== undefined) {
    body = JSON.stringify(params.json);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
  } else if (params.body !== undefined) {
    body = params.body;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(resolveLocksmithTimeoutMs(params.cfg, params.timeoutSeconds)),
    });
  } catch (error) {
    if (isUnreachableNetworkError(error)) {
      throw new LocksmithError({
        code: "service-unreachable",
        tool: params.tool,
        message: `Locksmith service unreachable for tool "${params.tool}" at ${url.toString()}`,
        cause: error,
      });
    }
    throw error;
  }

  if (response.status === 404) {
    const payload = await readResponseErrorBody(response);
    throw new LocksmithError({
      code: "tool-absent",
      status: 404,
      tool: params.tool,
      message: `Locksmith tool "${params.tool}" is not active on the service`,
      cause: payload,
    });
  }
  if (response.status === 403) {
    const payload = await peekJsonBody(response);
    if (extractServiceErrorType(payload) === "service-disabled") {
      throw new LocksmithError({
        code: "service-disabled",
        status: 403,
        tool: params.tool,
        message: `Locksmith tool "${params.tool}" is disabled upstream`,
        cause: payload,
      });
    }
  }

  const maxResponseBytes = resolveLocksmithMaxResponseBytes(params.cfg, params.maxResponseBytes);
  const rawBody = await readBodyWithLimit(response, maxResponseBytes);
  const contentType = response.headers.get("content-type") ?? "";
  const filteredHeaders = filterResponseHeaders(response.headers);

  if (isJsonContentType(contentType)) {
    const text = new TextDecoder().decode(rawBody);
    return {
      ok: response.ok,
      url: url.toString(),
      status: response.status,
      statusText: response.statusText,
      contentType,
      headers: filteredHeaders,
      bodyType: "json",
      data: text === "" ? null : JSON.parse(text),
    };
  }

  if (isTextualContentType(contentType) || rawBody.length === 0) {
    return {
      ok: response.ok,
      url: url.toString(),
      status: response.status,
      statusText: response.statusText,
      contentType,
      headers: filteredHeaders,
      bodyType: "text",
      text: new TextDecoder().decode(rawBody),
    };
  }

  return {
    ok: response.ok,
    url: url.toString(),
    status: response.status,
    statusText: response.statusText,
    contentType,
    headers: filteredHeaders,
    bodyType: "base64",
    bodyBase64: Buffer.from(rawBody).toString("base64"),
  };
}

export type LocksmithAdminFetchParams = {
  cfg?: OpenClawConfig;
  path: string;
  query?: Record<string, string>;
};

/**
 * Issue a GET against the Locksmith admin surface. Returns parsed JSON.
 *
 * Throws {@link LocksmithError} for unreachable services and request failures
 * (including 401/403 missing/invalid admin token).
 */
export async function fetchLocksmithAdmin<T = unknown>(
  params: LocksmithAdminFetchParams,
): Promise<T> {
  const baseUrl = normalizeBaseUrl(resolveLocksmithBaseUrl(params.cfg));
  const url = new URL(`/admin/${params.path.replace(/^\/+/u, "")}`, `${baseUrl}/`);
  if (params.query) {
    for (const [key, value] of Object.entries(params.query)) {
      if (typeof value === "string" && value !== "") {
        url.searchParams.set(key, value);
      }
    }
  }
  const headers = buildAuthHeaders(params.cfg);
  const adminToken = resolveLocksmithAdminToken(params.cfg);
  if (adminToken) {
    headers.set("Authorization", `Bearer ${adminToken}`);
  }
  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(resolveLocksmithTimeoutMs(params.cfg)),
    });
  } catch (error) {
    if (isUnreachableNetworkError(error)) {
      throw new LocksmithError({
        code: "service-unreachable",
        message: `Locksmith service unreachable at ${url.toString()}`,
        cause: error,
      });
    }
    throw error;
  }
  if (!response.ok) {
    throw new LocksmithError({
      code: "request-failed",
      status: response.status,
      message: `Locksmith admin request failed (${response.status} ${response.statusText}) for ${url.toString()}`,
    });
  }
  return (await response.json()) as T;
}

async function peekJsonBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!isJsonContentType(contentType)) {
    return undefined;
  }
  try {
    const cloned = response.clone();
    const text = await cloned.text();
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}
