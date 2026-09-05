import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveUntrustedContentApiKey,
  resolveUntrustedContentBaseUrl,
  resolveUntrustedContentPipelineId,
  resolveUntrustedContentTlsRejectUnauthorized,
  resolveUntrustedContentTimeoutMs,
  type UntrustedContentTrustLevel,
} from "./config.js";

type ThreatSignal = {
  stage?: string;
  stage_id?: string;
  type?: string;
  severity?: "info" | "warn" | "critical";
  verdict?: "pass" | "flag" | "block";
  message?: string;
  confidence?: number | null;
  details?: Record<string, unknown>;
};

type PipelineMetadata = Record<string, unknown> & {
  storage?: Record<string, string | null | undefined>;
};

export type UntrustedContentPipelineResponse = {
  id: string;
  clean: boolean;
  quarantined: boolean;
  content: string | null;
  threats: ThreatSignal[];
  metadata: PipelineMetadata;
};

function isThreatSignal(value: unknown): value is ThreatSignal {
  if (!isRecord(value)) {
    return false;
  }
  return (
    ["stage", "stage_id", "type", "message"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    (value.severity === undefined ||
      value.severity === "info" ||
      value.severity === "warn" ||
      value.severity === "critical") &&
    (value.verdict === undefined ||
      value.verdict === "pass" ||
      value.verdict === "flag" ||
      value.verdict === "block") &&
    (value.confidence === undefined ||
      value.confidence === null ||
      (typeof value.confidence === "number" && Number.isFinite(value.confidence))) &&
    (value.details === undefined || isRecord(value.details))
  );
}

function isPipelineResponse(value: unknown): value is UntrustedContentPipelineResponse {
  if (!isRecord(value) || !isRecord(value.metadata)) {
    return false;
  }
  const storage = value.metadata.storage;
  return (
    typeof value.id === "string" &&
    typeof value.clean === "boolean" &&
    typeof value.quarantined === "boolean" &&
    (value.content === null || typeof value.content === "string") &&
    Array.isArray(value.threats) &&
    value.threats.every(isThreatSignal) &&
    (storage === undefined ||
      (isRecord(storage) &&
        Object.values(storage).every(
          (entry) => entry === null || entry === undefined || typeof entry === "string",
        )))
  );
}

type RunUntrustedContentPipelineParams = {
  cfg?: OpenClawConfig;
  content: string;
  source: string;
  url?: string;
  contentType?: string;
  contentId?: string;
  trustLevel?: UntrustedContentTrustLevel;
  sanitize?: boolean;
  guardrail?: boolean;
  scan?: boolean;
  windowSize?: number;
  windowOverlap?: number;
  timeoutMs?: number;
};

const SERVICE_FAILURE_COOLDOWN_MS = 30_000;
const LOCAL_SERVICE_FETCH_POLICY = { allowPrivateNetwork: true } as const;
const unavailableServices = new Map<string, { until: number; error: string }>();

class UntrustedContentHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UntrustedContentHttpError";
  }
}

function readCachedUnavailability(baseUrl: string): string | undefined {
  const current = unavailableServices.get(baseUrl);
  if (!current) {
    return undefined;
  }
  if (Date.now() >= current.until) {
    unavailableServices.delete(baseUrl);
    return undefined;
  }
  return current.error;
}

function markServiceUnavailable(baseUrl: string, error: string): void {
  unavailableServices.set(baseUrl, {
    until: Date.now() + SERVICE_FAILURE_COOLDOWN_MS,
    error,
  });
}

function clearServiceUnavailable(baseUrl: string): void {
  unavailableServices.delete(baseUrl);
}

function buildPipelineEndpoint(baseUrl: string, pipelineId: string): string {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(
    `v1/pipelines/${encodeURIComponent(pipelineId)}/run`,
    normalizedBaseUrl,
  ).toString();
}

async function readErrorResponse(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  const normalized = normalizeOptionalString(text);
  if (!normalized) {
    return `${response.status} ${response.statusText}`.trim();
  }
  return `${response.status} ${response.statusText}: ${normalized}`.trim();
}

type QuarantineRawRecord = {
  id: string;
  raw_content: string;
  source?: string | null;
  url?: string | null;
  content_type?: string | null;
  sha256?: string | null;
  timestamp?: string | null;
};

function isQuarantineRawRecord(value: unknown): value is QuarantineRawRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.raw_content === "string" &&
    ["source", "url", "content_type", "sha256", "timestamp"].every(
      (key) => value[key] === undefined || value[key] === null || typeof value[key] === "string",
    )
  );
}

export type FetchQuarantineRawResult =
  | { ok: true; raw: QuarantineRawRecord }
  | { ok: false; status: number; error: string };

function buildQuarantineEndpoint(baseUrl: string, contentId: string): string {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(`v1/quarantine/${encodeURIComponent(contentId)}`, normalizedBaseUrl).toString();
}

/**
 * OPERATOR-ONLY raw quarantine retrieval.
 *
 * Fetches the original, un-sanitized hostile content from the dep service so an
 * operator can inspect it at their terminal. This MUST stay reachable only from
 * the CLI `show` path; never wire it into an agent tool, hook, or transform, or
 * the breaker/quarantine isolation it protects is defeated. Never throws.
 */
export async function fetchQuarantineRaw(
  cfg: OpenClawConfig | undefined,
  contentId: string,
): Promise<FetchQuarantineRawResult> {
  const baseUrl = resolveUntrustedContentBaseUrl(cfg);
  const endpoint = buildQuarantineEndpoint(baseUrl, contentId);
  const apiKey = resolveUntrustedContentApiKey(cfg);
  let guarded: Awaited<ReturnType<typeof fetchWithSsrFGuard>> | undefined;
  try {
    guarded = await fetchWithSsrFGuard({
      url: endpoint,
      init: {
        method: "GET",
        headers: {
          accept: "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
      },
      timeoutMs: resolveUntrustedContentTimeoutMs(cfg),
      policy: LOCAL_SERVICE_FETCH_POLICY,
      ...(!resolveUntrustedContentTlsRejectUnauthorized(cfg)
        ? { dispatcherPolicy: { mode: "direct" as const, connect: { rejectUnauthorized: false } } }
        : {}),
      auditContext: "untrusted-content-quarantine-raw",
      capture: false,
    });
    const { response } = guarded;
    if (response.status === 404) {
      return { ok: false, status: 404, error: "not found" };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, error: await readErrorResponse(response) };
    }
    const raw: unknown = await response.json();
    if (!isQuarantineRawRecord(raw)) {
      throw new Error("quarantine response has an invalid shape");
    }
    return { ok: true, raw };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : `quarantine fetch failed: ${String(error)}`;
    return { ok: false, status: 0, error: message };
  } finally {
    await guarded?.release();
  }
}

function buildHoneypotEndpoint(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL("v1/honeypot/trigger", normalizedBaseUrl).toString();
}

/**
 * Best-effort honeypot trigger notification to the dep service.
 *
 * Fired when an agent calls a configured trap tool (likely lured by injection).
 * It is a fire-and-forget side notification: the breaker incident and block are
 * recorded locally regardless, so this MUST never throw and never gate the
 * containment decision on the service being reachable.
 */
export async function triggerHoneypot(
  cfg: OpenClawConfig | undefined,
  input: { toolName: string; sessionKey?: string; arguments?: unknown },
): Promise<void> {
  const baseUrl = resolveUntrustedContentBaseUrl(cfg);
  const endpoint = buildHoneypotEndpoint(baseUrl);
  const apiKey = resolveUntrustedContentApiKey(cfg);
  const body = JSON.stringify({
    tool_name: input.toolName,
    ...(input.sessionKey ? { session_key: input.sessionKey } : {}),
    ...(input.arguments !== undefined ? { arguments: input.arguments } : {}),
  });
  let guarded: Awaited<ReturnType<typeof fetchWithSsrFGuard>> | undefined;
  try {
    guarded = await fetchWithSsrFGuard({
      url: endpoint,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body,
      },
      timeoutMs: resolveUntrustedContentTimeoutMs(cfg),
      policy: LOCAL_SERVICE_FETCH_POLICY,
      ...(!resolveUntrustedContentTlsRejectUnauthorized(cfg)
        ? { dispatcherPolicy: { mode: "direct" as const, connect: { rejectUnauthorized: false } } }
        : {}),
      auditContext: "untrusted-content-honeypot",
      capture: false,
    });
  } catch {
    // Swallow: containment does not depend on the service receiving this.
  } finally {
    await guarded?.release();
  }
}

export async function runUntrustedContentPipeline(
  params: RunUntrustedContentPipelineParams,
): Promise<UntrustedContentPipelineResponse> {
  const baseUrl = resolveUntrustedContentBaseUrl(params.cfg);
  const cachedFailure = readCachedUnavailability(baseUrl);
  if (cachedFailure) {
    throw new Error(cachedFailure);
  }

  const timeoutMs =
    typeof params.timeoutMs === "number" &&
    Number.isFinite(params.timeoutMs) &&
    params.timeoutMs > 0
      ? Math.floor(params.timeoutMs)
      : resolveUntrustedContentTimeoutMs(params.cfg);
  // The deployed service owns pipeline policy in /v1/pipelines/{id}/run, so the
  // request carries only input fields; per-stage overrides are not sent.
  const requestBody = {
    input: {
      content: params.content,
      source: params.source,
      ...(params.url ? { url: params.url } : {}),
      ...(params.contentType ? { content_type: params.contentType } : {}),
      ...(params.contentId ? { content_id: params.contentId } : {}),
    },
    ...(params.contentId ? { request_id: params.contentId } : {}),
  };

  const endpoint = buildPipelineEndpoint(baseUrl, resolveUntrustedContentPipelineId(params.cfg));
  const apiKey = resolveUntrustedContentApiKey(params.cfg);
  let guarded: Awaited<ReturnType<typeof fetchWithSsrFGuard>> | undefined;
  try {
    guarded = await fetchWithSsrFGuard({
      url: endpoint,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(requestBody),
      },
      timeoutMs,
      policy: LOCAL_SERVICE_FETCH_POLICY,
      ...(!resolveUntrustedContentTlsRejectUnauthorized(params.cfg)
        ? { dispatcherPolicy: { mode: "direct" as const, connect: { rejectUnauthorized: false } } }
        : {}),
      auditContext: "untrusted-content-pipeline",
      capture: false,
    });
    const { response } = guarded;
    if (!response.ok) {
      const errorText = await readErrorResponse(response);
      if (response.status >= 500) {
        markServiceUnavailable(baseUrl, errorText);
      } else {
        clearServiceUnavailable(baseUrl);
      }
      throw new UntrustedContentHttpError(response.status, errorText);
    }
    const data: unknown = await response.json();
    if (!isPipelineResponse(data)) {
      throw new Error("pipeline response has an invalid shape");
    }
    clearServiceUnavailable(baseUrl);
    return data;
  } catch (error) {
    if (error instanceof UntrustedContentHttpError) {
      throw error;
    }
    const message =
      error instanceof Error ? error.message : `untrusted-content request failed: ${String(error)}`;
    markServiceUnavailable(baseUrl, message);
    throw error instanceof Error ? error : new Error(message);
  } finally {
    await guarded?.release();
  }
}
