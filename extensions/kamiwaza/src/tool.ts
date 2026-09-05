import { readNumberParam, readStringParam } from "openclaw/plugin-sdk/param-readers";
import type {
  OpenClawPluginToolContext,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { callKamiwazaTool, discoverKamiwazaTools } from "./client.js";

const KamiwazaCallToolSchema = Type.Object(
  {
    tool: Type.String({
      description:
        "Kamiwaza tool slug from the current catalog, for example kamiwaza_tool_z_19607be6_search.",
    }),
    arguments: Type.Optional(
      Type.Record(Type.String(), Type.Any(), {
        description: "JSON arguments forwarded to the selected Kamiwaza MCP tool.",
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({
        minimum: 1,
        description: "Optional per-request timeout override in seconds.",
      }),
    ),
  },
  { additionalProperties: false },
);

function readArguments(rawParams: Record<string, unknown>): Record<string, unknown> {
  const raw = rawParams.arguments;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  // SAFETY: The preceding guard rejects null, arrays, and non-object argument values.
  return raw as Record<string, unknown>;
}

export function createKamiwazaCallTool(api: OpenClawPluginApi, ctx?: OpenClawPluginToolContext) {
  return {
    name: "kamiwaza_call",
    label: "Kamiwaza Call",
    description:
      "Call a live Kamiwaza MCP tool directly. OpenClaw supplies the configured Kamiwaza PAT and never accepts credentials in tool arguments.",
    parameters: KamiwazaCallToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const runtimeConfig = ctx?.getRuntimeConfig?.() ?? ctx?.runtimeConfig ?? api.config;
      const tool = readStringParam(rawParams, "tool", { required: true });
      const activeTools = await discoverKamiwazaTools(runtimeConfig);
      if (!activeTools.some((entry) => entry.name === tool)) {
        throw new Error(
          `Unknown Kamiwaza tool "${tool}". Active tools: ${
            activeTools.map((entry) => entry.name).join(", ") || "(none)"
          }`,
        );
      }
      return jsonResult(
        await callKamiwazaTool({
          cfg: runtimeConfig,
          tool,
          arguments: readArguments(rawParams),
          agentId: ctx?.agentId,
          sessionId: ctx?.sessionId,
          timeoutSeconds: readNumberParam(rawParams, "timeoutSeconds", { integer: true }),
        }),
      );
    },
  };
}
