import crypto from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  kamiwazaExtensionNameMatches,
  resolveKamiwazaApiToken,
  resolveKamiwazaApiUrlCandidates,
  resolveKamiwazaCatalogTtlMs,
  resolveKamiwazaDelegationConfig,
  resolveKamiwazaDiscoveryConcurrency,
  resolveKamiwazaExtensionNamePatterns,
  resolveKamiwazaIncludeTypes,
  resolveKamiwazaTimeoutMs,
  resolveKamiwazaToolPrefix,
  resolveKamiwazaVerifyTls,
} from "./config.js";

const MCP_PROTOCOL_VERSION = "2025-03-26";
const LOCAL_PLATFORM_FETCH_POLICY = { allowPrivateNetwork: true } as const;

export type KamiwazaDiscoveredTool = {
  name: string;
  extensionName: string;
  mcpUrl: string;
  mcpTool: string;
  description?: string;
  inputSchema?: unknown;
};

type ExtensionResponse = {
  name?: unknown;
  type?: unknown;
  phase?: unknown;
  services?: unknown;
  endpoints?: unknown;
};

type ExtensionServiceStatus = {
  ready?: unknown;
  available_replicas?: unknown;
};

type ExtensionEndpoints = {
  external?: unknown;
  internal?: unknown;
};

type CacheEntry = {
  expiresAt: number;
  promise: Promise<KamiwazaDiscoveredTool[]>;
};

type KamiwazaCallParams = {
  cfg?: OpenClawConfig;
  tool: string;
  arguments: Record<string, unknown>;
  agentId?: string;
  sessionId?: string;
  timeoutSeconds?: number;
};

type McpJsonResult = {
  sessionId?: string;
  payload: unknown;
};

export type KamiwazaCallResult = {
  tool: string;
  result: unknown;
};

export class KamiwazaError extends Error {
  readonly code:
    | "missing-token"
    | "service-unreachable"
    | "tool-absent"
    | "delegation-unavailable"
    | "request-failed"
    | "protocol-error";

  constructor(params: { code: KamiwazaError["code"]; message: string; cause?: unknown }) {
    super(params.message, params.cause === undefined ? undefined : { cause: params.cause });
    this.name = "KamiwazaError";
    this.code = params.code;
  }
}

const discoveryCache = new Map<string, CacheEntry>();

function normalizeNonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compareToolNames(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortKamiwazaTools<T extends { name: string }>(tools: T[]): T[] {
  return [...tools].toSorted((a, b) => compareToolNames(a.name, b.name));
}

function sanitizeComponent(value: string): string {
  let out = "";
  let lastWasSeparator = false;
  for (const ch of value.toLowerCase()) {
    if (/^[a-z0-9]$/u.test(ch)) {
      out += ch;
      lastWasSeparator = false;
      continue;
    }
    if (!lastWasSeparator && out.length > 0) {
      out += "_";
      lastWasSeparator = true;
    }
  }
  out = out.replace(/_+$/u, "");
  return out || "x";
}

function toolSlug(prefix: string, extensionName: string, toolName: string): string {
  return `${sanitizeComponent(prefix)}_${sanitizeComponent(extensionName)}_${sanitizeComponent(toolName)}`;
}

function extensionServices(value: unknown): ExtensionServiceStatus[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is ExtensionServiceStatus =>
        Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
      )
    : [];
}

function extensionEndpoints(value: unknown): ExtensionEndpoints | undefined {
  return isRecord(value) ? value : undefined;
}

function extensionIsAllowed(
  cfg: OpenClawConfig | undefined,
  extension: ExtensionResponse,
): boolean {
  if (extension.phase !== "Running") {
    return false;
  }
  const includeTypes = resolveKamiwazaIncludeTypes(cfg);
  if (includeTypes.length > 0) {
    const extensionType = normalizeNonemptyString(extension.type) ?? "";
    if (!includeTypes.some((entry) => entry.toLowerCase() === extensionType.toLowerCase())) {
      return false;
    }
  }
  const namePatterns = resolveKamiwazaExtensionNamePatterns(cfg);
  if (namePatterns.length > 0) {
    const extensionName = normalizeNonemptyString(extension.name) ?? "";
    if (!kamiwazaExtensionNameMatches(extensionName, namePatterns)) {
      return false;
    }
  }
  const services = extensionServices(extension.services);
  if (
    services.length > 0 &&
    !services.some(
      (service) =>
        service.ready === true ||
        (typeof service.available_replicas === "number" && service.available_replicas > 0),
    )
  ) {
    return false;
  }
  return true;
}

function mcpUrlForExtension(extension: ExtensionResponse): string | undefined {
  const endpoints = extensionEndpoints(extension.endpoints);
  const endpoint =
    normalizeNonemptyString(endpoints?.external) ?? normalizeNonemptyString(endpoints?.internal);
  if (!endpoint) {
    return undefined;
  }
  return `${endpoint.replace(/\/+$/u, "")}/mcp`;
}

function isUnreachableNetworkError(error: unknown): boolean {
  if (error instanceof KamiwazaError) {
    return false;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error) {
    // SAFETY: Error is an object; code remains unknown until the string check below.
    const code = (error as { code?: unknown }).code;
    if (
      typeof code === "string" &&
      new Set([
        "ECONNREFUSED",
        "ECONNRESET",
        "ETIMEDOUT",
        "EAI_AGAIN",
        "ENOTFOUND",
        "EHOSTUNREACH",
        "ENETUNREACH",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_SOCKET",
      ]).has(code)
    ) {
      return true;
    }
    return error.name === "TypeError" && /fetch failed/i.test(error.message);
  }
  return false;
}

function authHeaders(token: string, delegation?: DelegationHeader): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  if (delegation) {
    headers.set(delegation.header, `Bearer ${delegation.jwt}`);
  }
  return headers;
}

function tlsDispatcherPolicy(verifyTls: boolean) {
  return verifyTls
    ? undefined
    : ({ mode: "direct", connect: { rejectUnauthorized: false } } as const);
}

async function fetchJson<T>(params: {
  url: string;
  token: string;
  timeoutMs: number;
  verifyTls: boolean;
}): Promise<T> {
  let guarded: Awaited<ReturnType<typeof fetchWithSsrFGuard>>;
  try {
    guarded = await fetchWithSsrFGuard({
      url: params.url,
      init: { headers: authHeaders(params.token) },
      timeoutMs: params.timeoutMs,
      policy: LOCAL_PLATFORM_FETCH_POLICY,
      dispatcherPolicy: tlsDispatcherPolicy(params.verifyTls),
      auditContext: "kamiwaza-client",
      capture: false,
    });
  } catch (error) {
    if (isUnreachableNetworkError(error)) {
      throw new KamiwazaError({
        code: "service-unreachable",
        message: `Kamiwaza service unreachable at ${params.url}`,
        cause: error,
      });
    }
    throw error;
  }
  const { response } = guarded;
  try {
    if (!response.ok) {
      throw new KamiwazaError({
        code: "request-failed",
        message: `Kamiwaza request failed (${response.status} ${response.statusText}) for ${params.url}`,
      });
    }
    // SAFETY: The generic describes the selected endpoint; discovery uses unknown and validates fields.
    return (await response.json()) as T;
  } finally {
    await guarded.release();
  }
}

async function fetchExtensions(params: {
  cfg?: OpenClawConfig;
  token: string;
  timeoutMs: number;
}): Promise<ExtensionResponse[]> {
  let lastError: unknown;
  for (const candidate of resolveKamiwazaApiUrlCandidates(params.cfg)) {
    const url = `${candidate.replace(/\/+$/u, "")}/extensions`;
    try {
      const payload = await fetchJson<unknown>({
        url,
        token: params.token,
        timeoutMs: params.timeoutMs,
        verifyTls: resolveKamiwazaVerifyTls(params.cfg),
      });
      return Array.isArray(payload)
        ? payload.filter((entry): entry is ExtensionResponse =>
            Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
          )
        : [];
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new KamiwazaError({
        code: "request-failed",
        message: "No Kamiwaza API URL candidates are reachable.",
      });
}

function parseMcpPayload(contentType: string, text: string): unknown {
  if (contentType.split(";")[0]?.trim().toLowerCase() !== "text/event-stream") {
    return text ? JSON.parse(text) : null;
  }
  let data = "";
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith("data:")) {
      if (data) {
        data += "\n";
      }
      data += line.slice(5).trimStart();
    } else if (!line.trim() && data) {
      break;
    }
  }
  if (!data) {
    throw new KamiwazaError({
      code: "protocol-error",
      message: "Kamiwaza MCP endpoint returned an empty event stream.",
    });
  }
  return JSON.parse(data);
}

async function sendMcpJson(params: {
  mcpUrl: string;
  token: string;
  sessionId?: string;
  payload: unknown;
  timeoutMs: number;
  delegation?: DelegationHeader;
  verifyTls: boolean;
}): Promise<McpJsonResult> {
  const headers = authHeaders(params.token, params.delegation);
  headers.set("Accept", "application/json, text/event-stream");
  headers.set("Content-Type", "application/json");
  if (params.sessionId) {
    headers.set("mcp-session-id", params.sessionId);
  }
  let guarded: Awaited<ReturnType<typeof fetchWithSsrFGuard>>;
  try {
    guarded = await fetchWithSsrFGuard({
      url: params.mcpUrl,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(params.payload),
      },
      timeoutMs: params.timeoutMs,
      policy: LOCAL_PLATFORM_FETCH_POLICY,
      dispatcherPolicy: tlsDispatcherPolicy(params.verifyTls),
      auditContext: "kamiwaza-mcp",
      capture: false,
    });
  } catch (error) {
    if (isUnreachableNetworkError(error)) {
      throw new KamiwazaError({
        code: "service-unreachable",
        message: `Kamiwaza MCP endpoint unreachable at ${params.mcpUrl}`,
        cause: error,
      });
    }
    throw error;
  }
  const { response } = guarded;
  try {
    const sessionId = response.headers.get("mcp-session-id") ?? undefined;
    if (response.status === 202) {
      return { sessionId, payload: null };
    }
    if (!response.ok) {
      throw new KamiwazaError({
        code: "request-failed",
        message: `Kamiwaza MCP request failed (${response.status} ${response.statusText})`,
      });
    }
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    return { sessionId, payload: parseMcpPayload(contentType, text) };
  } finally {
    await guarded.release();
  }
}

async function closeMcpSession(params: {
  mcpUrl: string;
  token: string;
  sessionId?: string;
  timeoutMs: number;
  delegation?: DelegationHeader;
  verifyTls: boolean;
}): Promise<void> {
  if (!params.sessionId) {
    return;
  }
  const headers = authHeaders(params.token, params.delegation);
  headers.set("mcp-session-id", params.sessionId);
  try {
    const guarded = await fetchWithSsrFGuard({
      url: params.mcpUrl,
      init: { method: "DELETE", headers },
      timeoutMs: params.timeoutMs,
      policy: LOCAL_PLATFORM_FETCH_POLICY,
      dispatcherPolicy: tlsDispatcherPolicy(params.verifyTls),
      auditContext: "kamiwaza-mcp-close",
      capture: false,
    });
    await guarded.release();
  } catch {
    // Best-effort close; tool call result already completed.
  }
}

async function initializeMcpSession(params: {
  mcpUrl: string;
  token: string;
  timeoutMs: number;
  delegation?: DelegationHeader;
  verifyTls: boolean;
}): Promise<string | undefined> {
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "openclaw-kamiwaza", version: "1.0.0" },
    },
  };
  const initialized = {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  };
  const { sessionId, payload } = await sendMcpJson({ ...params, payload: initialize });
  if (hasMcpError(payload)) {
    throw new KamiwazaError({
      code: "protocol-error",
      message: "Kamiwaza MCP initialize returned an error.",
      cause: payload,
    });
  }
  await sendMcpJson({ ...params, sessionId, payload: initialized });
  return sessionId;
}

function hasMcpError(payload: unknown): boolean {
  return Boolean(
    payload && typeof payload === "object" && !Array.isArray(payload) && "error" in payload,
  );
}

function readMcpResult(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  // SAFETY: The object check above permits property lookup; the result remains unknown.
  return (payload as { result?: unknown }).result;
}

function readMcpTools(payload: unknown): unknown[] {
  const result = readMcpResult(payload);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return [];
  }
  // SAFETY: The object check above permits property lookup; Array.isArray validates tools below.
  const tools = (result as { tools?: unknown }).tools;
  return Array.isArray(tools) ? tools : [];
}

async function listMcpTools(params: {
  mcpUrl: string;
  token: string;
  timeoutMs: number;
  verifyTls: boolean;
  detachClose?: boolean;
}): Promise<unknown[]> {
  const sessionId = await initializeMcpSession(params);
  try {
    const listPayload = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    };
    const { payload } = await sendMcpJson({ ...params, sessionId, payload: listPayload });
    if (hasMcpError(payload)) {
      throw new KamiwazaError({
        code: "protocol-error",
        message: "Kamiwaza MCP tools/list returned an error.",
        cause: payload,
      });
    }
    return readMcpTools(payload);
  } finally {
    // Each MCP round-trip through the platform ingress is slow (seconds), so
    // during discovery the session-close DELETE is fired without blocking the
    // result; closeMcpSession already swallows its own errors.
    const close = closeMcpSession({ ...params, sessionId });
    if (params.detachClose) {
      void close;
    } else {
      await close;
    }
  }
}

function cacheKey(cfg?: OpenClawConfig): string {
  return [
    resolveKamiwazaApiUrlCandidates(cfg).join("|"),
    resolveKamiwazaToolPrefix(cfg),
    resolveKamiwazaIncludeTypes(cfg).join("|"),
    resolveKamiwazaExtensionNamePatterns(cfg).join("|"),
    String(resolveKamiwazaVerifyTls(cfg)),
  ].join("::");
}

export function resetKamiwazaDiscoveryCacheForTest(): void {
  discoveryCache.clear();
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  const pending = items.entries();
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const item = pending.next();
      if (item.done) {
        return;
      }
      const [index, value] = item.value;
      results[index] = await worker(value);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function discoverKamiwazaTools(
  cfg?: OpenClawConfig,
): Promise<KamiwazaDiscoveredTool[]> {
  const token = resolveKamiwazaApiToken(cfg);
  if (!token) {
    throw new KamiwazaError({
      code: "missing-token",
      message:
        "Kamiwaza PAT is not configured. Set plugins.entries.kamiwaza.config.apiToken, KAMIWAZA_API_KEY, or sync ~/.openclaw/credentials/kamiwaza-pat-store.json.",
    });
  }
  const key = cacheKey(cfg);
  const now = Date.now();
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }
  const promise = (async () => {
    const timeoutMs = resolveKamiwazaTimeoutMs(cfg);
    const verifyTls = resolveKamiwazaVerifyTls(cfg);
    const extensions = await fetchExtensions({ cfg, token, timeoutMs });
    const toolPrefix = resolveKamiwazaToolPrefix(cfg);
    // Each extension costs four serial MCP round-trips (initialize ->
    // initialized -> tools/list -> close); a shared cluster can host dozens of
    // them, so discovering serially turns a single tool call into a 40s+ stall.
    // Fan out the per-extension probes with bounded concurrency instead.
    const targets = extensions.filter(
      (extension) => normalizeNonemptyString(extension.name) && extensionIsAllowed(cfg, extension),
    );
    const probeExtension = async (
      extension: (typeof targets)[number],
    ): Promise<KamiwazaDiscoveredTool[]> => {
      const extensionName = normalizeNonemptyString(extension.name);
      const mcpUrl = extensionName ? mcpUrlForExtension(extension) : undefined;
      if (!extensionName || !mcpUrl) {
        return [];
      }
      let tools: unknown[];
      try {
        tools = await listMcpTools({ mcpUrl, token, timeoutMs, verifyTls, detachClose: true });
      } catch {
        return [];
      }
      const results: KamiwazaDiscoveredTool[] = [];
      for (const tool of tools) {
        if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
          continue;
        }
        // SAFETY: The object check above permits lookup; each optional field remains unknown.
        const toolRecord = tool as { name?: unknown; description?: unknown; inputSchema?: unknown };
        const mcpTool = normalizeNonemptyString(toolRecord.name);
        if (!mcpTool) {
          continue;
        }
        results.push({
          name: toolSlug(toolPrefix, extensionName, mcpTool),
          extensionName,
          mcpUrl,
          mcpTool,
          description: normalizeNonemptyString(toolRecord.description),
          inputSchema: toolRecord.inputSchema,
        });
      }
      return results;
    };
    const batches = await mapWithConcurrency(
      targets,
      resolveKamiwazaDiscoveryConcurrency(cfg),
      probeExtension,
    );
    return sortKamiwazaTools(batches.flat());
  })();
  discoveryCache.set(key, { expiresAt: now + resolveKamiwazaCatalogTtlMs(cfg), promise });
  try {
    return await promise;
  } catch (error) {
    discoveryCache.delete(key);
    throw error;
  }
}

type DelegationHeader = {
  header: string;
  jwt: string;
};

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function buildDelegationHeader(params: {
  cfg?: OpenClawConfig;
  tool: KamiwazaDiscoveredTool;
  agentId?: string;
  sessionId?: string;
}): DelegationHeader | undefined {
  const delegation = resolveKamiwazaDelegationConfig(params.cfg);
  if (!delegation.enabled && !delegation.required) {
    return undefined;
  }
  if (!params.agentId) {
    if (delegation.required) {
      throw new KamiwazaError({
        code: "delegation-unavailable",
        message: "Kamiwaza delegated identity is required but no agent id is available.",
      });
    }
    return undefined;
  }
  if (!delegation.signingSecret) {
    throw new KamiwazaError({
      code: "delegation-unavailable",
      message: "Kamiwaza delegated identity is enabled but no signing secret is configured.",
    });
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const claims = {
    iss: delegation.issuer,
    aud: delegation.audience,
    sub: params.agentId,
    session_id: params.sessionId,
    iat: nowSeconds,
    exp: nowSeconds + delegation.ttlSeconds,
    scope: "kamiwaza.tool.invoke",
    tool: params.tool.name,
    extension: params.tool.extensionName,
    mcp_tool: params.tool.mcpTool,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = crypto
    .createHmac("sha256", delegation.signingSecret)
    .update(signingInput)
    .digest("base64url");
  return { header: delegation.header, jwt: `${signingInput}.${signature}` };
}

export async function callKamiwazaTool(params: KamiwazaCallParams): Promise<KamiwazaCallResult> {
  const tools = await discoverKamiwazaTools(params.cfg);
  const tool = tools.find((entry) => entry.name === params.tool);
  if (!tool) {
    throw new KamiwazaError({
      code: "tool-absent",
      message: `Kamiwaza tool "${params.tool}" is not active. Active tools: ${
        tools.map((entry) => entry.name).join(", ") || "(none)"
      }`,
    });
  }
  const token = resolveKamiwazaApiToken(params.cfg);
  if (!token) {
    throw new KamiwazaError({
      code: "missing-token",
      message: "Kamiwaza PAT is not configured.",
    });
  }
  const timeoutMs = resolveKamiwazaTimeoutMs(params.cfg, params.timeoutSeconds);
  const verifyTls = resolveKamiwazaVerifyTls(params.cfg);
  const delegation = buildDelegationHeader({
    cfg: params.cfg,
    tool,
    agentId: params.agentId,
    sessionId: params.sessionId,
  });
  const sessionId = await initializeMcpSession({
    mcpUrl: tool.mcpUrl,
    token,
    timeoutMs,
    verifyTls,
    delegation,
  });
  try {
    const { payload } = await sendMcpJson({
      mcpUrl: tool.mcpUrl,
      token,
      timeoutMs,
      sessionId,
      verifyTls,
      delegation,
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: tool.mcpTool,
          arguments: params.arguments,
        },
      },
    });
    if (hasMcpError(payload)) {
      throw new KamiwazaError({
        code: "protocol-error",
        message: "Kamiwaza MCP tools/call returned an error.",
        cause: payload,
      });
    }
    return { tool: tool.name, result: readMcpResult(payload) ?? null };
  } finally {
    await closeMcpSession({
      mcpUrl: tool.mcpUrl,
      token,
      timeoutMs,
      sessionId,
      verifyTls,
      delegation,
    });
  }
}
