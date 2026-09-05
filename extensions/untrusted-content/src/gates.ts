/**
 * before_tool_call gate logic for the untrusted-content guard.
 *
 * Two concerns, in order:
 *  1. Containment: once a session holds an active breaker block, every further
 *     tool call from that run is denied until an operator clears the code. This
 *     stops a tripped/hostile run from continuing to act through tools.
 *  2. Honeypot: a configured trap tool call is treated as injection-driven; it
 *     records a fresh breaker incident, fires a best-effort service notification,
 *     and then blocks the call (and all subsequent ones via containment).
 *
 * Active-block is checked first so a re-call on an already-blocked session just
 * blocks instead of recording a second honeypot incident.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { notifyBreaker } from "./breaker-notify.js";
import { triggerHoneypot } from "./client.js";
import { findActiveBlockForSession, recordIncident } from "./incidents.js";
import { isHoneypotTool, resolveRiskWeights } from "./risk.js";
import { resolveBlockSessionId } from "./session-identity.js";

export type BeforeToolCallEvaluation = { block: true; reason: string } | undefined;

type BeforeToolCallInput = {
  toolName: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  arguments?: unknown;
  cfg?: OpenClawConfig;
};

function containmentReason(code: string): string {
  return `This agent is halted by the untrusted-content guard (code ${code}). Tool calls are blocked until an operator runs 'clear ${code}'.`;
}

function honeypotReason(code: string): string {
  return `Honeypot tool triggered (code ${code}). This agent has been shut down for a suspected hostile prompt; tool calls are blocked until an operator runs 'clear ${code}'.`;
}

export async function evaluateBeforeToolCall(
  api: OpenClawPluginApi,
  input: BeforeToolCallInput,
): Promise<BeforeToolCallEvaluation> {
  const cfg = input.cfg ?? api.config;
  // Canonical session id (sessionId -> sessionKey -> agentId) so record/lookup
  // match regardless of sandbox session keying.
  const sessionId = resolveBlockSessionId(input);

  // Containment first: an already-blocked session re-calling a honeypot tool
  // should just block, not record a duplicate incident.
  if (sessionId) {
    const block = await findActiveBlockForSession(api, sessionId);
    if (block) {
      return { block: true, reason: containmentReason(block.code) };
    }
  }

  if (!isHoneypotTool(input.toolName, cfg)) {
    return undefined;
  }

  // Fresh honeypot hit: notify the service (best-effort, never throws) and
  // record an active breaker block that contains the rest of the run.
  await triggerHoneypot(cfg, {
    toolName: input.toolName,
    sessionKey: input.sessionKey,
    arguments: input.arguments,
  });
  const incident = await recordIncident(api, {
    tier: "breaker",
    breakerReason: "honeypot",
    tool: input.toolName,
    // Track config so the honeypot score follows the configured weight.
    score: resolveRiskWeights(cfg).honeypotBonus,
    // Store the canonical session id so the containment lookup matches.
    ...(sessionId ? { sessionKey: sessionId } : {}),
    agentId: input.agentId,
    active: true,
  });
  // Out-of-band operator advisory for the honeypot trip: fire once here, after
  // the breaker incident is recorded. Best-effort and never throws.
  const agentName = cfg?.agents?.list?.find((agent) => agent.id === input.agentId)?.name;
  await notifyBreaker(api, {
    code: incident.code,
    tool: input.toolName,
    breakerReason: "honeypot",
    ...(agentName ? { agentName } : {}),
  });
  return { block: true, reason: honeypotReason(incident.code) };
}
