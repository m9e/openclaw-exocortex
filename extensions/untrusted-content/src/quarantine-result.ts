import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { UntrustedContentPipelineResponse } from "./client.js";

function summarizeThreats(response: UntrustedContentPipelineResponse): string {
  if (!Array.isArray(response.threats) || response.threats.length === 0) {
    return "No specific threat details were returned.";
  }
  return response.threats
    .slice(0, 3)
    .map((threat) => {
      const confidence =
        typeof threat.confidence === "number" && Number.isFinite(threat.confidence)
          ? ` (${Math.round(threat.confidence * 100)}%)`
          : "";
      return `${threat.stage}/${threat.severity}${confidence}`;
    })
    .join("\n");
}

export function buildQuarantineSummary(params: {
  toolName: string;
  response?: UntrustedContentPipelineResponse;
  error?: string;
}): string {
  const lines = [
    `[untrusted-content] ${params.toolName} output was quarantined before agent ingest.`,
  ];
  if (params.response) {
    // Only enum/numeric threat fields; raw service strings and storage paths are
    // withheld from model context.
    lines.push(`Threats:\n${summarizeThreats(params.response)}`);
  }
  if (params.error) {
    lines.push(`Reason: ${params.error}`);
  }
  lines.push("Original untrusted content was omitted.");
  return lines.join("\n\n");
}

export function withholdToolResult(
  original: Record<string, unknown>,
  notice: string,
  untrustedContentGuard: Record<string, unknown>,
): Record<string, unknown> {
  // A terminal quarantine must not retain another payload field or raw details.
  const guard = { ...untrustedContentGuard, quarantined: true };
  return {
    ...(typeof original.text === "string" ? { text: notice } : {}),
    ...(Array.isArray(original.content) ? { content: [{ type: "text", text: notice }] } : {}),
    ...(original.isError === true ? { isError: true } : {}),
    details: { untrustedContentGuard: guard },
    untrustedContentGuard: guard,
  };
}

export function buildFallbackQuarantineResult(params: {
  result: unknown;
  toolName: string;
}): unknown {
  if (!isRecord(params.result)) {
    return params.result;
  }
  if (Array.isArray(params.result.content) || typeof params.result.text === "string") {
    // Service error bodies may echo untrusted input; expose only a fixed notice.
    const error = "Scanner unavailable or returned an invalid response.";
    return withholdToolResult(
      params.result,
      buildQuarantineSummary({
        toolName: params.toolName,
        error,
      }),
      {
        guard: "untrusted-content",
        toolName: params.toolName,
        quarantined: true,
        error,
      },
    );
  }
  return params.result;
}
