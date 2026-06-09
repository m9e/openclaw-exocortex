import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  resolveUntrustedContentApiKey,
  resolveUntrustedContentBaseUrl,
  resolveUntrustedContentPipelineOverrides,
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
  // The deployed service owns pipeline policy in /v1/pipelines/{id}/run. Resolve
  // overrides for forward compatibility, but do not send unsupported fields.
  resolveUntrustedContentPipelineOverrides(params.cfg);
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
    const data = (await response.json()) as UntrustedContentPipelineResponse;
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
