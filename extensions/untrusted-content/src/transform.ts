import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { wrapExternalContent, wrapWebContent } from "openclaw/plugin-sdk/security-runtime";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { runUntrustedContentPipeline, type UntrustedContentPipelineResponse } from "./client.js";
import {
  resolveUntrustedContentMaxContentChars,
  resolveUntrustedContentOnErrorMode,
  shouldGuardToolResult,
} from "./config.js";

type ExternalSource = "browser" | "web_fetch" | "web_search" | "api" | "unknown";

type TransformParams = {
  cfg?: OpenClawConfig;
  toolName: string;
  params: Record<string, unknown>;
  toolCallId?: string;
  result: unknown;
};

type GuardBlockResult = {
  clean: boolean;
  quarantined: boolean;
  rewrittenText: string;
  response: UntrustedContentPipelineResponse;
};

type UnwrappedExternalContent = {
  content: string;
  source: ExternalSource;
  includeWarning: boolean;
};

const WRAPPED_EXTERNAL_CONTENT_RE =
  /^(?<prefix>[\s\S]*?)<<<EXTERNAL_UNTRUSTED_CONTENT id="[^"]+">>>\n(?<meta>[\s\S]*?)\n---\n(?<content>[\s\S]*?)\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[^"]+">>>$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value };
}

function resolveFallbackSource(toolName: string): ExternalSource {
  return normalizeOptionalLowercaseString(toolName) === "browser" ? "browser" : "web_fetch";
}

function mapSourceLabelToSource(
  value: string | undefined,
  fallback: ExternalSource,
): ExternalSource {
  const normalized = normalizeOptionalLowercaseString(value);
  switch (normalized) {
    case "browser":
      return "browser";
    case "web fetch":
      return "web_fetch";
    case "web search":
      return "web_search";
    case "api":
      return "api";
    default:
      return fallback;
  }
}

function unwrapExternalContentValue(
  value: string,
  fallbackSource: ExternalSource,
): UnwrappedExternalContent | null {
  const match = WRAPPED_EXTERNAL_CONTENT_RE.exec(value);
  if (!match?.groups) {
    return null;
  }
  const prefix = match.groups.prefix ?? "";
  const meta = match.groups.meta ?? "";
  const content = match.groups.content ?? "";
  const sourceLine = meta
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("Source: "));
  return {
    content,
    source: mapSourceLabelToSource(sourceLine?.slice("Source: ".length), fallbackSource),
    includeWarning: prefix.includes("SECURITY NOTICE:"),
  };
}

function wrapLikeOriginal(params: {
  content: string;
  originalText: string;
  fallbackSource: ExternalSource;
}): string {
  const unwrapped = unwrapExternalContentValue(params.originalText, params.fallbackSource);
  if (unwrapped) {
    if (unwrapped.source === "web_fetch") {
      return params.fallbackSource === "web_fetch" && unwrapped.includeWarning
        ? wrapWebContent(params.content, "web_fetch")
        : wrapExternalContent(params.content, {
            source: unwrapped.source,
            includeWarning: unwrapped.includeWarning,
          });
    }
    return wrapExternalContent(params.content, {
      source: unwrapped.source,
      includeWarning: unwrapped.includeWarning,
    });
  }
  if (params.fallbackSource === "web_fetch") {
    return wrapWebContent(params.content, "web_fetch");
  }
  return wrapExternalContent(params.content, {
    source: params.fallbackSource,
    includeWarning: true,
  });
}

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
      return `${threat.stage}/${threat.severity}: ${threat.message}${confidence}`;
    })
    .join("\n");
}

function buildQuarantineSummary(params: {
  toolName: string;
  response?: UntrustedContentPipelineResponse;
  error?: string;
}): string {
  const lines = [
    `[untrusted-content] ${params.toolName} output was quarantined before agent ingest.`,
  ];
  if (params.response) {
    lines.push(`Threats:\n${summarizeThreats(params.response)}`);
    const incidentPath = normalizeOptionalString(params.response.metadata?.storage?.incident);
    if (incidentPath) {
      lines.push(`Incident: ${incidentPath}`);
    }
  }
  if (params.error) {
    lines.push(`Reason: ${params.error}`);
  }
  lines.push("Original untrusted content was omitted.");
  return lines.join("\n\n");
}

function buildGuardMetadata(params: {
  toolName: string;
  blockIndex?: number;
  response: UntrustedContentPipelineResponse;
}): Record<string, unknown> {
  return {
    guard: "untrusted-content",
    toolName: params.toolName,
    ...(params.blockIndex !== undefined ? { blockIndex: params.blockIndex } : {}),
    clean: params.response.clean,
    quarantined: params.response.quarantined,
    contentId: params.response.id,
    threatCount: params.response.threats.length,
    threats: params.response.threats.map((threat) => ({
      stage: threat.stage,
      severity: threat.severity,
      message: threat.message,
      ...(typeof threat.confidence === "number" ? { confidence: threat.confidence } : {}),
    })),
    metadata: params.response.metadata,
  };
}

function resolveCandidateUrl(result: Record<string, unknown>): string | undefined {
  const direct = normalizeOptionalString(result.finalUrl) || normalizeOptionalString(result.url);
  if (direct) {
    return direct;
  }
  if (isRecord(result.details)) {
    return normalizeOptionalString(result.details.url);
  }
  return undefined;
}

function resolveCandidateContentType(result: Record<string, unknown>): string | undefined {
  return normalizeOptionalString(result.contentType);
}

async function guardTextBlock(params: {
  cfg?: OpenClawConfig;
  toolName: string;
  toolCallId?: string;
  blockIndex?: number;
  originalText: string;
  fallbackSource: ExternalSource;
  url?: string;
  contentType?: string;
}): Promise<GuardBlockResult> {
  const maxChars = resolveUntrustedContentMaxContentChars(params.cfg);
  const unwrapped = unwrapExternalContentValue(params.originalText, params.fallbackSource);
  const content = (unwrapped?.content ?? params.originalText).slice(0, maxChars);
  const response = await runUntrustedContentPipeline({
    cfg: params.cfg,
    content,
    source: unwrapped?.source ?? params.fallbackSource,
    ...(params.url ? { url: params.url } : {}),
    ...(params.contentType ? { contentType: params.contentType } : {}),
    ...(params.toolCallId
      ? {
          contentId:
            params.blockIndex !== undefined
              ? `${params.toolCallId}:${params.blockIndex}`
              : params.toolCallId,
        }
      : {}),
  });
  return {
    clean: response.clean,
    quarantined: response.quarantined,
    rewrittenText:
      response.clean && typeof response.content === "string"
        ? wrapLikeOriginal({
            content: response.content,
            originalText: params.originalText,
            fallbackSource: unwrapped?.source ?? params.fallbackSource,
          })
        : buildQuarantineSummary({
            toolName: params.toolName,
            response,
          }),
    response,
  };
}

async function guardRecordWithTextField(params: {
  cfg?: OpenClawConfig;
  toolName: string;
  toolCallId?: string;
  result: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const originalText = typeof params.result.text === "string" ? params.result.text : "";
  if (!originalText.trim()) {
    return params.result;
  }
  const block = await guardTextBlock({
    cfg: params.cfg,
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    originalText,
    fallbackSource: resolveFallbackSource(params.toolName),
    url: resolveCandidateUrl(params.result),
    contentType: resolveCandidateContentType(params.result),
  });
  const nextResult = cloneRecord(params.result);
  nextResult.text = block.rewrittenText;
  nextResult.untrustedContentGuard = buildGuardMetadata({
    toolName: params.toolName,
    response: block.response,
  });
  if (isRecord(nextResult.details)) {
    nextResult.details = {
      ...nextResult.details,
      untrustedContentGuard: nextResult.untrustedContentGuard,
    };
  }
  return nextResult;
}

async function guardRecordWithContentBlocks(params: {
  cfg?: OpenClawConfig;
  toolName: string;
  toolCallId?: string;
  result: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const content = Array.isArray(params.result.content) ? params.result.content : [];
  const textBlockIndexes = content.flatMap((block, index) => {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      return [];
    }
    return [{ index, text: block.text }];
  });
  if (textBlockIndexes.length === 0) {
    return params.result;
  }

  const nextContent = [...content];
  const guardMetadata: Record<string, unknown>[] = [];
  for (const textBlock of textBlockIndexes) {
    const guarded = await guardTextBlock({
      cfg: params.cfg,
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      blockIndex: textBlock.index,
      originalText: textBlock.text,
      fallbackSource: resolveFallbackSource(params.toolName),
      url: resolveCandidateUrl(params.result),
    });
    guardMetadata.push(
      buildGuardMetadata({
        toolName: params.toolName,
        blockIndex: textBlock.index,
        response: guarded.response,
      }),
    );
    if (guarded.quarantined) {
      const nextResult = cloneRecord(params.result);
      nextResult.content = [{ type: "text", text: guarded.rewrittenText }];
      nextResult.untrustedContentGuard = {
        guard: "untrusted-content",
        toolName: params.toolName,
        quarantined: true,
        blocks: guardMetadata,
      };
      if (isRecord(nextResult.details)) {
        nextResult.details = {
          ...nextResult.details,
          untrustedContentGuard: nextResult.untrustedContentGuard,
        };
      }
      return nextResult;
    }
    nextContent[textBlock.index] = {
      ...(isRecord(nextContent[textBlock.index]) ? nextContent[textBlock.index] : {}),
      type: "text",
      text: guarded.rewrittenText,
    };
  }

  const nextResult = cloneRecord(params.result);
  nextResult.content = nextContent;
  nextResult.untrustedContentGuard = {
    guard: "untrusted-content",
    toolName: params.toolName,
    quarantined: false,
    blocks: guardMetadata,
  };
  if (isRecord(nextResult.details)) {
    nextResult.details = {
      ...nextResult.details,
      untrustedContentGuard: nextResult.untrustedContentGuard,
    };
  }
  return nextResult;
}

function buildFallbackQuarantineResult(params: {
  result: unknown;
  toolName: string;
  error: string;
}): unknown {
  if (!isRecord(params.result)) {
    return params.result;
  }
  if (Array.isArray(params.result.content)) {
    const details = isRecord(params.result.details) ? params.result.details : undefined;
    const untrustedContentGuard = {
      guard: "untrusted-content",
      toolName: params.toolName,
      quarantined: true,
      error: params.error,
    };
    return {
      ...params.result,
      content: [
        {
          type: "text",
          text: buildQuarantineSummary({
            toolName: params.toolName,
            error: params.error,
          }),
        },
      ],
      ...(details ? { details: { ...details, untrustedContentGuard } } : {}),
      untrustedContentGuard,
    };
  }
  if (typeof params.result.text === "string") {
    const details = isRecord(params.result.details) ? params.result.details : undefined;
    const untrustedContentGuard = {
      guard: "untrusted-content",
      toolName: params.toolName,
      quarantined: true,
      error: params.error,
    };
    return {
      ...params.result,
      text: buildQuarantineSummary({
        toolName: params.toolName,
        error: params.error,
      }),
      ...(details ? { details: { ...details, untrustedContentGuard } } : {}),
      untrustedContentGuard,
    };
  }
  return params.result;
}

export async function maybeTransformToolResult(params: TransformParams): Promise<unknown> {
  if (!shouldGuardToolResult(params.cfg, params.toolName) || !isRecord(params.result)) {
    return params.result;
  }

  try {
    if (typeof params.result.text === "string") {
      return await guardRecordWithTextField({
        cfg: params.cfg,
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        result: params.result,
      });
    }
    if (Array.isArray(params.result.content)) {
      return await guardRecordWithContentBlocks({
        cfg: params.cfg,
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        result: params.result,
      });
    }
    return params.result;
  } catch (error) {
    if (resolveUntrustedContentOnErrorMode(params.cfg) !== "quarantine") {
      return params.result;
    }
    return buildFallbackQuarantineResult({
      result: params.result,
      toolName: params.toolName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function formatManualScanToolResult(params: {
  toolName: string;
  source: ExternalSource;
  response: UntrustedContentPipelineResponse;
}): Record<string, unknown> {
  const wrappedContent =
    params.response.clean && typeof params.response.content === "string"
      ? params.source === "web_fetch"
        ? wrapWebContent(params.response.content, "web_fetch")
        : wrapExternalContent(params.response.content, {
            source: params.source,
            includeWarning: true,
          })
      : null;
  return {
    clean: params.response.clean,
    quarantined: params.response.quarantined,
    content: wrappedContent,
    threats: params.response.threats,
    metadata: params.response.metadata,
    ...(params.response.quarantined
      ? {
          summary: buildQuarantineSummary({
            toolName: params.toolName,
            response: params.response,
          }),
        }
      : {}),
  };
}
