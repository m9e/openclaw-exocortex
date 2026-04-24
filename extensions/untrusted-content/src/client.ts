import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  resolveUntrustedContentBaseUrl,
  resolveUntrustedContentPipelineOverrides,
  resolveUntrustedContentTimeoutMs,
  type UntrustedContentTrustLevel,
} from "./config.js";

type ThreatSignal = {
  stage: string;
  severity: "info" | "warn" | "critical";
  message: string;
  confidence?: number | null;
  details?: Record<string, unknown>;
};

type PipelineMetadata = {
  original_length: number;
  sanitized_length: number;
  truncated: boolean;
  sanitizer_actions: string[];
  windows_scanned: number;
  scan_time_ms: number;
  pipeline_version: string;
  trust_level: UntrustedContentTrustLevel;
  storage: Record<string, string | null | undefined>;
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

function buildAbortSignal(timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(
    () => {
      controller.abort(new Error(`untrusted-content timeout after ${timeoutMs}ms`));
    },
    Math.max(1, timeoutMs),
  );
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
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
  const { trustLevel, sanitize, guardrail, scan, windowSize, windowOverlap } =
    resolveUntrustedContentPipelineOverrides(params.cfg);
  const requestBody = {
    input: {
      content: params.content,
      source: params.source,
      ...(params.url ? { url: params.url } : {}),
      ...(params.contentType ? { content_type: params.contentType } : {}),
      ...(params.contentId ? { content_id: params.contentId } : {}),
    },
    pipeline: {
      trust_level: params.trustLevel ?? trustLevel,
      ...((params.sanitize ?? sanitize) !== undefined
        ? { sanitize: params.sanitize ?? sanitize }
        : {}),
      ...((params.guardrail ?? guardrail) !== undefined
        ? { guardrail: params.guardrail ?? guardrail }
        : {}),
      ...((params.scan ?? scan) !== undefined ? { scan: params.scan ?? scan } : {}),
      ...((params.windowSize ?? windowSize) !== undefined
        ? { window_size: params.windowSize ?? windowSize }
        : {}),
      ...((params.windowOverlap ?? windowOverlap) !== undefined
        ? { window_overlap: params.windowOverlap ?? windowOverlap }
        : {}),
    },
  };

  const endpoint = new URL("/v1/pipeline", baseUrl).toString();
  const { signal, cleanup } = buildAbortSignal(timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal,
    });
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
    cleanup();
  }
}
