import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { callLocksmith, listLocksmithTools } from "./client.js";

const QueryValueSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
]);

const LocksmithCallToolSchema = Type.Object(
  {
    tool: Type.String({
      description: "Locksmith tool slug from GET /tools, for example github or tavily.",
    }),
    path: Type.Optional(
      Type.String({
        description:
          "Relative path under the selected Locksmith tool. Do not include /api/<tool>/.",
      }),
    ),
    method: Type.Optional(
      Type.Union([
        Type.Literal("GET"),
        Type.Literal("POST"),
        Type.Literal("PUT"),
        Type.Literal("PATCH"),
        Type.Literal("DELETE"),
        Type.Literal("HEAD"),
      ]),
    ),
    query: Type.Optional(
      Type.Record(Type.String(), QueryValueSchema, {
        description: "Optional query-string parameters.",
      }),
    ),
    headers: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: "Optional non-auth request headers. Authorization-style headers are ignored.",
      }),
    ),
    json: Type.Optional(Type.Any({ description: "Optional JSON request body." })),
    body: Type.Optional(
      Type.String({ description: "Optional plain-text request body. Do not use with json." }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({
        minimum: 1,
        description: "Optional per-request timeout override in seconds.",
      }),
    ),
    maxResponseBytes: Type.Optional(
      Type.Number({
        minimum: 1024,
        description: "Optional max response size override in bytes.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createLocksmithCallTool(api: OpenClawPluginApi) {
  return {
    name: "locksmith_call",
    label: "Locksmith Call",
    description:
      "Call an API exposed through Agent Locksmith without exposing upstream credentials to the agent.",
    parameters: LocksmithCallToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const tool = readStringParam(rawParams, "tool", { required: true });
      const discoveredTools = await listLocksmithTools(api.config);
      const activeToolNames = new Set(discoveredTools.map((entry) => entry.name));
      if (!activeToolNames.has(tool)) {
        throw new Error(
          `Unknown Locksmith tool "${tool}". Active tools: ${[...activeToolNames].toSorted().join(", ") || "(none)"}`,
        );
      }

      return jsonResult(
        await callLocksmith({
          cfg: api.config,
          tool,
          method: readStringParam(rawParams, "method") || "GET",
          path: readStringParam(rawParams, "path") || undefined,
          query:
            rawParams.query &&
            typeof rawParams.query === "object" &&
            !Array.isArray(rawParams.query)
              ? (rawParams.query as Record<string, unknown>)
              : undefined,
          headers:
            rawParams.headers &&
            typeof rawParams.headers === "object" &&
            !Array.isArray(rawParams.headers)
              ? (rawParams.headers as Record<string, unknown>)
              : undefined,
          json: rawParams.json,
          body: readStringParam(rawParams, "body") || undefined,
          timeoutSeconds: readNumberParam(rawParams, "timeoutSeconds", { integer: true }),
          maxResponseBytes: readNumberParam(rawParams, "maxResponseBytes", { integer: true }),
        }),
      );
    },
  };
}
