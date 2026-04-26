import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { Type } from "typebox";
import { runUntrustedContentPipeline } from "./client.js";
import { formatManualScanToolResult } from "./transform.js";

const SOURCE_VALUES = ["browser", "web_fetch", "web_search", "api", "unknown"] as const;
const TRUST_LEVEL_VALUES = ["untrusted", "semi-trusted", "trusted"] as const;

const UntrustedContentScanToolSchema = Type.Object(
  {
    content: Type.String({
      description: "Untrusted text to sanitize and scan before using it in agent context.",
    }),
    source: Type.Optional(
      Type.Unsafe<(typeof SOURCE_VALUES)[number]>({
        type: "string",
        enum: [...SOURCE_VALUES],
        description: "Source type for wrapping and provenance.",
      }),
    ),
    url: Type.Optional(
      Type.String({
        description: "Optional source URL associated with the content.",
      }),
    ),
    contentType: Type.Optional(
      Type.String({
        description: "Optional content type associated with the content.",
      }),
    ),
    trustLevel: Type.Optional(
      Type.Unsafe<(typeof TRUST_LEVEL_VALUES)[number]>({
        type: "string",
        enum: [...TRUST_LEVEL_VALUES],
        description: "Optional pipeline trust-level override.",
      }),
    ),
    sanitize: Type.Optional(Type.Boolean()),
    guardrail: Type.Optional(Type.Boolean()),
    scan: Type.Optional(Type.Boolean()),
    windowSize: Type.Optional(
      Type.Number({
        minimum: 32,
      }),
    ),
    windowOverlap: Type.Optional(
      Type.Number({
        minimum: 0,
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({
        minimum: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

export function createUntrustedContentScanTool(api: OpenClawPluginApi) {
  return {
    name: "untrusted_content_scan",
    label: "Untrusted Content Scan",
    description:
      "Sanitize and scan untrusted text through the local tool-untrusted-content pipeline before using it in agent context.",
    parameters: UntrustedContentScanToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const content = readStringParam(rawParams, "content", { required: true });
      const source = readStringParam(rawParams, "source") || "unknown";
      const response = await runUntrustedContentPipeline({
        cfg: api.config,
        content,
        source,
        url: readStringParam(rawParams, "url") || undefined,
        contentType: readStringParam(rawParams, "contentType") || undefined,
        trustLevel:
          readStringParam(rawParams, "trustLevel") === "semi-trusted" ||
          readStringParam(rawParams, "trustLevel") === "trusted"
            ? (readStringParam(rawParams, "trustLevel") as "semi-trusted" | "trusted")
            : readStringParam(rawParams, "trustLevel") === "untrusted"
              ? "untrusted"
              : undefined,
        sanitize: typeof rawParams.sanitize === "boolean" ? rawParams.sanitize : undefined,
        guardrail: typeof rawParams.guardrail === "boolean" ? rawParams.guardrail : undefined,
        scan: typeof rawParams.scan === "boolean" ? rawParams.scan : undefined,
        windowSize: readNumberParam(rawParams, "windowSize", { integer: true }),
        windowOverlap: readNumberParam(rawParams, "windowOverlap", { integer: true }),
        timeoutMs: (() => {
          const timeoutSeconds = readNumberParam(rawParams, "timeoutSeconds", { integer: true });
          return typeof timeoutSeconds === "number" ? timeoutSeconds * 1000 : undefined;
        })(),
      });
      return jsonResult(
        formatManualScanToolResult({
          toolName: "untrusted_content_scan",
          source:
            source === "browser" ||
            source === "web_fetch" ||
            source === "web_search" ||
            source === "api"
              ? source
              : "unknown",
          response,
        }),
      );
    },
  };
}
