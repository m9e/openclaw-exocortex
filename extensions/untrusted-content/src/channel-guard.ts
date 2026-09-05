/**
 * before_dispatch channel-ingest guarding (phase 2, opt-in, default OFF).
 *
 * When `risk.guardChannels` is enabled, untrusted inbound channel messages are
 * scored through the same pipeline + risk model used for tool results. A
 * breaker/quarantine verdict DROPS the message (agent never sees it, sender gets
 * no reply); summarize/pass let it through unchanged.
 *
 * Trust heuristic is intentionally coarse for phase 2: a group message, or a DM
 * with no resolvable owner/sender, is "untrusted" and guarded; a plain non-group
 * DM is assumed owner/paired and skipped. Real per-sender trust resolution is
 * future work.
 *
 * Failure coupling: with guardChannels on, a pipeline error fails CLOSED and
 * drops the message. That means guard-service downtime suppresses untrusted
 * inbound delivery — an intentional availability-for-safety tradeoff that only
 * applies when an operator has opted into channel guarding.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { runUntrustedContentPipeline } from "./client.js";
import { recordIncident } from "./incidents.js";
import {
  classifyRisk,
  deriveMessageClass,
  resolveChannelSourceTrust,
  resolveGuardChannels,
  resolveRiskWeights,
} from "./risk.js";
import { resolveBlockSessionId } from "./session-identity.js";

export type ChannelDispatchEvent = {
  content: string;
  channel?: string;
  sessionKey?: string;
  senderId?: string;
  isGroup?: boolean;
};

// `{ handled: true }` with no text drops the message; undefined lets it through.
export type ChannelGuardResult = { handled: true } | undefined;

/**
 * Coarse phase-2 trust gate: guard groups and owner-less DMs, skip plain DMs.
 * A non-group message with a resolvable sender is assumed owner/paired.
 */
export function isUntrustedChannelMessage(event: ChannelDispatchEvent): boolean {
  if (event.isGroup === true) {
    return true;
  }
  // Non-group DM with no resolvable sender: treat as untrusted (cannot vouch
  // for an owner). A named DM sender is assumed paired/owner for phase 2.
  return !event.senderId || event.senderId.trim().length === 0;
}

export async function evaluateChannelDispatch(
  api: OpenClawPluginApi,
  event: ChannelDispatchEvent,
  cfgOverride?: OpenClawConfig,
): Promise<ChannelGuardResult> {
  const cfg = cfgOverride ?? api.config;
  if (!resolveGuardChannels(cfg)) {
    return undefined;
  }
  if (!isUntrustedChannelMessage(event)) {
    return undefined;
  }
  const content = event.content ?? "";
  if (!content.trim()) {
    return undefined;
  }

  let response: Awaited<ReturnType<typeof runUntrustedContentPipeline>>;
  try {
    response = await runUntrustedContentPipeline({
      cfg,
      content,
      source: "api",
      ...(event.sessionKey ? { contentId: event.sessionKey } : {}),
    });
  } catch {
    // Fail-closed: drop untrusted inbound when the guard service errors.
    return { handled: true };
  }

  const confidences = response.threats.map((threat) =>
    typeof threat.confidence === "number" ? threat.confidence : 0,
  );
  const maxThreatConfidence = confidences.length ? Math.max(...confidences) : 0;
  const guardrailVerdict = response.threats.find((threat) => threat.stage === "guardrail")?.verdict;
  const honeypot = response.threats.some((threat) => threat.stage === "honeypot");
  // A critical-severity scanner/guardrail threat forces a confirmed jailbreak so
  // blatant injections reach the breaker even below the 0.95 confidence band.
  const hasCriticalThreat = response.threats.some((threat) => threat.severity === "critical");
  const { messageClass, confirmedJailbreak } = deriveMessageClass({
    quarantined: response.quarantined,
    maxThreatConfidence,
    verdict: guardrailVerdict,
    hasCriticalThreat,
  });
  const risk = classifyRisk(
    {
      sourceTrust: resolveChannelSourceTrust(cfg, event.channel),
      messageClass,
      // Inbound channel content is aimed at the user; weight it accordingly.
      targeting: "inbound_to_user",
      honeypot,
      confirmedJailbreak,
    },
    resolveRiskWeights(cfg),
  );

  if (risk.tier === "breaker" || risk.tier === "quarantine") {
    await recordIncident(api, {
      tier: risk.tier,
      ...(risk.breakerReason ? { breakerReason: risk.breakerReason } : {}),
      tool: `channel:${event.channel ?? "?"}`,
      score: risk.score,
      // before_dispatch events carry no sessionId, only sessionKey; route through
      // the same resolver as the tool/agent gates so any block we record here is
      // keyed uniformly. (No-op today: the drop below short-circuits the run so no
      // later run relies on this lock — but keeps the keying contract consistent.)
      sessionKey: resolveBlockSessionId({ sessionKey: event.sessionKey }),
      contentId: response.id,
      // Only the breaker tier installs an active session lock.
      active: risk.tier === "breaker",
    });
    return { handled: true };
  }

  // summarize/pass: let the message through. True inbound summarization needs a
  // core content-transform hook on the dispatch path, which is deferred; for now
  // an elevated-but-not-blocking score passes unchanged.
  return undefined;
}
