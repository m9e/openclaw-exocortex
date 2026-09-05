import type { AgentToolResultMiddlewareResult } from "openclaw/plugin-sdk/agent-harness-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { evaluateChannelDispatch } from "./src/channel-guard.js";
import { CONVERSATIONAL_CLEAR_RE } from "./src/clear-pattern.js";
import { registerUntrustedContentCli } from "./src/cli.js";
import {
  isUntrustedContentGuardConfigured,
  resolveUntrustedContentEnabled,
  shouldGuardToolResult,
} from "./src/config.js";
import { evaluateBeforeToolCall } from "./src/gates.js";
import { clearIncident, findActiveBlockForSession } from "./src/incidents.js";
import { createUntrustedContentRevealTool } from "./src/reveal-tool.js";
import { resolveBlockSessionId } from "./src/session-identity.js";
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

    api.registerTool(createUntrustedContentScanTool(api));
    api.registerTool(createUntrustedContentRevealTool(api), { optional: true });

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
      const sessionId = resolveBlockSessionId(ctx);
      if (!sessionId) {
        return undefined;
      }
      const block = await findActiveBlockForSession(api, sessionId);
      if (!block) {
        return undefined;
      }
      return {
        outcome: "block",
        reason: `untrusted-content active block ${block.code}`,
        message: `This agent is halted: a hostile prompt was detected (code ${block.code}). Run "clear ${block.code}" to release it.`,
      };
    });

    // Current-run containment + honeypot: deny tool calls once a session is
    // held by an active breaker block, and shut down + record any agent lured
    // into calling a configured honeypot trap tool.
    api.on("before_tool_call", async (event, ctx) => {
      if (!resolveUntrustedContentEnabled(api.config)) {
        return undefined;
      }
      const evaluation = await evaluateBeforeToolCall(api, {
        toolName: event.toolName,
        sessionId: ctx?.sessionId,
        sessionKey: ctx?.sessionKey,
        agentId: ctx?.agentId,
        arguments: event.params,
      });
      if (!evaluation) {
        return undefined;
      }
      return { block: true, blockReason: evaluation.reason };
    });

    // Conversational release first, then opt-in channel-ingest guarding. The
    // `clear <code>` short-circuit must stay ahead of guarding so an operator
    // can always release a block; guarding only runs when no clear matched.
    api.on("before_dispatch", async (event) => {
      if (!resolveUntrustedContentEnabled(api.config)) {
        return undefined;
      }
      const match = CONVERSATIONAL_CLEAR_RE.exec(event.content ?? "");
      const clearCode = match?.[1];
      if (clearCode) {
        // Group messages are ignored for clears (owner-only, phase 1) so a
        // non-owner participant cannot release another's block.
        if (event.isGroup) {
          return undefined;
        }
        const cleared = await clearIncident(api, clearCode, event.senderId ?? "conversation");
        return {
          handled: true,
          text: cleared
            ? `Block ${cleared.code} cleared.`
            : `No active block ${clearCode.toUpperCase()}.`,
        };
      }

      // Channel-ingest guard (default OFF via risk.guardChannels). Drops an
      // untrusted inbound message on a breaker/quarantine verdict and never
      // replies to the sender; otherwise lets it through.
      return await evaluateChannelDispatch(api, {
        content: event.content ?? "",
        ...(event.channel !== undefined ? { channel: event.channel } : {}),
        ...(event.sessionKey !== undefined ? { sessionKey: event.sessionKey } : {}),
        ...(event.senderId !== undefined ? { senderId: event.senderId } : {}),
        ...(event.isGroup !== undefined ? { isGroup: event.isGroup } : {}),
      });
    });

    api.registerAgentToolResultMiddleware(
      async (event, ctx) => {
        if (!resolveUntrustedContentEnabled(api.config)) {
          return undefined;
        }
        const result = await maybeTransformToolResult({
          api,
          cfg: api.config,
          toolName: event.toolName,
          params: event.args,
          toolCallId: event.toolCallId,
          result: event.result,
          sessionId: ctx?.sessionId,
          sessionKey: ctx?.sessionKey,
          agentId: ctx?.agentId,
        });
        return {
          // SAFETY: The transformer preserves typed input blocks/details and creates only text blocks.
          result: result as AgentToolResultMiddlewareResult["result"],
        };
      },
      {
        requiresResultReplacement: (toolName) => shouldGuardToolResult(api.config, toolName),
      },
    );
  },
});
