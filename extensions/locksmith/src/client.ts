import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
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

function buildAuthHeaders(cfg?: OpenClawConfig): Headers {
  const headers = new Headers();
  const inboundToken = resolveLocksmithInboundToken(cfg);
  if (inboundToken) {
    headers.set("Authorization", `Bearer ${inboundToken}`);
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
  const response = await fetch(params.url, {
    headers: buildAuthHeaders(params.cfg),
    signal: AbortSignal.timeout(params.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `Locksmith request failed (${response.status} ${response.statusText}) for ${params.url}`,
    );
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
    return Array.isArray(payload.tools)
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

export async function callLocksmith(params: LocksmithCallParams): Promise<LocksmithCallResult> {
  const method = (params.method ?? "GET").toUpperCase();
  const relativePath = normalizeRelativePath(params.path);
  const baseUrl = normalizeBaseUrl(resolveLocksmithBaseUrl(params.cfg));
  const url = new URL(`/api/${params.tool}/${relativePath}`, `${baseUrl}/`);
  appendQuery(url, params.query);

  const headers = buildAuthHeaders(params.cfg);
  if (params.headers) {
    for (const [key, value] of Object.entries(params.headers)) {
      const normalizedKey = key.trim().toLowerCase();
      if (!normalizedKey || HIDDEN_REQUEST_HEADERS.has(normalizedKey)) {
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

  const response = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(resolveLocksmithTimeoutMs(params.cfg, params.timeoutSeconds)),
  });
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
