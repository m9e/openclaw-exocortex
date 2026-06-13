import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginHookToolResultTransformResult } from "openclaw/plugin-sdk/plugin-runtime";
import { CONVERSATIONAL_CLEAR_RE } from "./src/clear-pattern.js";
import { registerUntrustedContentCli } from "./src/cli.js";
import { isUntrustedContentGuardConfigured, resolveUntrustedContentEnabled } from "./src/config.js";
import { clearIncident, findActiveBlockForSession } from "./src/incidents.js";
import { createUntrustedContentRevealTool } from "./src/reveal-tool.js";
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
    api.registerTool(createUntrustedContentRevealTool(api) as AnyAgentTool, { optional: true });

    api.registerCli(({ program }) => registerUntrustedContentCli(program, api), {
      descriptors: [
        {
          name: "untrusted-content",
          description: "Inspect and clear untrusted-content guard blocks",
          hasSubcommands: true,
        },
      ],
    });

    // Enforcement gate: refuse to run an agent turn while the session is held by
    // an active breaker block. Fires after before_dispatch, so a conversational
    // `clear <code>` can still release the block first.
    api.on("before_agent_run", async (_event, ctx) => {
      if (!resolveUntrustedContentEnabled(api.config)) {
        return undefined;
      }
      const sessionKey = ctx?.sessionKey;
      if (!sessionKey) {
        return undefined;
      }
      const block = await findActiveBlockForSession(api, sessionKey);
      if (!block) {
        return undefined;
      }
      return {
        outcome: "block",
        reason: `untrusted-content active block ${block.code}`,
        message: `This agent is halted: a hostile prompt was detected (code ${block.code}). Run "clear ${block.code}" to release it.`,
      };
    });

    // Conversational release: a bare `clear <code>` in a DM clears the block and
    // short-circuits the agent run. Group messages are ignored (owner-only,
    // phase 1) so a non-owner participant cannot release another's block.
    api.on("before_dispatch", async (event) => {
      if (!resolveUntrustedContentEnabled(api.config)) {
        return undefined;
      }
      const match = CONVERSATIONAL_CLEAR_RE.exec(event.content ?? "");
      if (!match) {
        return undefined;
      }
      if (event.isGroup) {
        return undefined;
      }
      const cleared = await clearIncident(api, match[1], event.senderId ?? "conversation");
      return {
        handled: true,
        text: cleared
          ? `Block ${cleared.code} cleared.`
          : `No active block ${match[1].toUpperCase()}.`,
      };
    });

    api.on("tool_result_transform", async (event, ctx) => {
      if (!resolveUntrustedContentEnabled(api.config)) {
        return undefined;
      }
      const result = await maybeTransformToolResult({
        api,
        cfg: api.config,
        toolName: event.toolName,
        params: event.params,
        toolCallId: event.toolCallId,
        result: event.result,
        sessionKey: ctx?.sessionKey,
        agentId: ctx?.agentId,
      });
      return {
        result: result as PluginHookToolResultTransformResult["result"],
      };
    });
  },
});
