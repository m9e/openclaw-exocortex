import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginHookToolResultTransformResult } from "openclaw/plugin-sdk/plugin-runtime";
import { isUntrustedContentGuardConfigured, resolveUntrustedContentEnabled } from "./src/config.js";
import { createUntrustedContentScanTool } from "./src/tool.js";
import { maybeTransformToolResult } from "./src/transform.js";

export default definePluginEntry({
  id: "untrusted-content",
  name: "Untrusted Content",
  description: "Guard untrusted tool output through a local tool-untrusted-content service.",
  register(api) {
    api.registerAutoEnableProbe(({ config, env }) => {
      return isUntrustedContentGuardConfigured(config, env)
        ? "untrusted content guard configured"
        : null;
    });

    api.registerTool(createUntrustedContentScanTool(api) as AnyAgentTool);

    api.on("tool_result_transform", async (event) => {
      if (!resolveUntrustedContentEnabled(api.config)) {
        return undefined;
      }
      const result = await maybeTransformToolResult({
        cfg: api.config,
        toolName: event.toolName,
        params: event.params,
        toolCallId: event.toolCallId,
        result: event.result,
      });
      return {
        result: result as PluginHookToolResultTransformResult["result"],
      };
    });
  },
});
