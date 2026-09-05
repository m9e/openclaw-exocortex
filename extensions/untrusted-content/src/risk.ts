import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type SourceTrust = "user" | "low" | "med" | "high";
export type MessageClass = "low" | "med" | "high";
export type Targeting = "general" | "inbound_to_user";
export type RiskTier = "pass" | "summarize" | "quarantine" | "breaker";

export type RiskInput = {
  sourceTrust: SourceTrust;
  messageClass: MessageClass;
  targeting: Targeting;
  honeypot: boolean;
  confirmedJailbreak: boolean;
};

export type RiskWeights = {
  source: Record<SourceTrust, number>;
  message: Record<MessageClass, number>;
  targeting: Record<Targeting, number>;
  honeypotBonus: number;
  summarizeAt: number;
  quarantineAt: number;
};

export type RiskResult = {
  score: number;
  tier: RiskTier;
  breakerReason?: "honeypot" | "confirmed_jailbreak";
};

export const DEFAULT_RISK_WEIGHTS: RiskWeights = {
  source: { user: 0, low: 1, med: 2, high: 3 },
  message: { low: 1, med: 2, high: 4 },
  targeting: { general: 0, inbound_to_user: 3 },
  honeypotBonus: 99,
  summarizeAt: 5,
  quarantineAt: 8,
};

/**
 * Confidence at or above which a scanner hit is treated as a confirmed
 * jailbreak attempt, forcing the breaker tier regardless of numeric score.
 */
export const CONFIRMED_JAILBREAK_CONFIDENCE = 0.95;

// Default tool tables. Trailing "*" entries match by prefix so dynamically
// projected tools stay classified without per-tool config edits.
const DEFAULT_INBOUND_TO_USER_TOOLS = ["email_*", "calendar_*", "gmail_*", "imessage_*"] as const;

export function classifyRisk(
  input: RiskInput,
  weights: RiskWeights = DEFAULT_RISK_WEIGHTS,
): RiskResult {
  const score =
    weights.source[input.sourceTrust] +
    weights.message[input.messageClass] +
    weights.targeting[input.targeting] +
    (input.honeypot ? weights.honeypotBonus : 0);

  // Breaker is special: honeypot or a confirmed jailbreak forces it even when
  // the numeric score would otherwise land in a lower tier.
  if (input.honeypot) {
    return { score, tier: "breaker", breakerReason: "honeypot" };
  }
  if (input.confirmedJailbreak) {
    return { score, tier: "breaker", breakerReason: "confirmed_jailbreak" };
  }
  if (score >= weights.quarantineAt) {
    return { score, tier: "quarantine" };
  }
  if (score >= weights.summarizeAt) {
    return { score, tier: "summarize" };
  }
  return { score, tier: "pass" };
}

export function deriveMessageClass(params: {
  quarantined: boolean;
  maxThreatConfidence: number;
  verdict?: "pass" | "flag" | "block";
  hasCriticalThreat?: boolean;
}): { messageClass: MessageClass; confirmedJailbreak: boolean } {
  const confidence = params.maxThreatConfidence;
  // Confirmed jailbreak (forces the breaker tier) when any of: a high-confidence
  // scanner hit, an explicit guardrail "block" verdict, or a critical-severity
  // threat. This lets blatant injections (which the heuristic scanner marks
  // critical/block) reach the breaker even when numeric confidence is < 0.95,
  // while the 8-9 multifactor band stays at quarantine.
  const confirmedJailbreak =
    confidence >= CONFIRMED_JAILBREAK_CONFIDENCE ||
    params.verdict === "block" ||
    params.hasCriticalThreat === true;

  let messageClass: MessageClass;
  if (params.verdict === "block" || confidence >= 0.9) {
    messageClass = "high";
  } else if (params.verdict === "flag" || confidence >= 0.7) {
    messageClass = "med";
  } else {
    messageClass = "low";
  }

  // Quarantined content is never trusted below "med", even if the verdict and
  // confidence alone would have classified it as "low".
  if (params.quarantined && messageClass === "low") {
    messageClass = "med";
  }

  return { messageClass, confirmedJailbreak };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function resolveRiskConfig(cfg?: OpenClawConfig): Record<string, unknown> | undefined {
  const pluginConfig = cfg?.plugins?.entries?.["untrusted-content"]?.config;
  if (!isRecord(pluginConfig)) {
    return undefined;
  }
  const risk = pluginConfig.risk;
  if (!isRecord(risk)) {
    return undefined;
  }
  return risk;
}

function mergeNumberMap<K extends string>(
  defaults: Record<K, number>,
  override: unknown,
): Record<K, number> {
  const merged = { ...defaults };
  if (!isRecord(override)) {
    return merged;
  }
  for (const key in defaults) {
    if (!Object.hasOwn(defaults, key)) {
      continue;
    }
    const value = override[key];
    if (isFiniteNumber(value)) {
      merged[key] = value;
    }
  }
  return merged;
}

export function resolveRiskWeights(cfg?: OpenClawConfig): RiskWeights {
  const risk = resolveRiskConfig(cfg);
  if (!risk) {
    return DEFAULT_RISK_WEIGHTS;
  }
  return {
    source: mergeNumberMap(DEFAULT_RISK_WEIGHTS.source, risk.source),
    message: mergeNumberMap(DEFAULT_RISK_WEIGHTS.message, risk.message),
    targeting: mergeNumberMap(DEFAULT_RISK_WEIGHTS.targeting, risk.targeting),
    honeypotBonus: isFiniteNumber(risk.honeypotBonus)
      ? risk.honeypotBonus
      : DEFAULT_RISK_WEIGHTS.honeypotBonus,
    summarizeAt: isFiniteNumber(risk.summarizeAt)
      ? risk.summarizeAt
      : DEFAULT_RISK_WEIGHTS.summarizeAt,
    quarantineAt: isFiniteNumber(risk.quarantineAt)
      ? risk.quarantineAt
      : DEFAULT_RISK_WEIGHTS.quarantineAt,
  };
}

// Entries ending in "*" match every tool sharing the prefix; otherwise an exact
// (case-insensitive) match. Mirrors the glob idiom in config.ts shouldGuardToolResult.
function matchesGlob(entry: string, toolName: string): boolean {
  if (entry.endsWith("*") && entry.length > 1) {
    return toolName.startsWith(entry.slice(0, -1));
  }
  return toolName === entry;
}

function normalizeGlobList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      normalized.push(entry.trim().toLowerCase());
    }
  }
  return normalized;
}

export function sourceTrustForTool(toolName: string, cfg?: OpenClawConfig): SourceTrust {
  const normalized = toolName.trim().toLowerCase();
  const risk = resolveRiskConfig(cfg);
  const overrides = risk?.toolSourceTrust;
  if (isRecord(overrides)) {
    for (const [entry, level] of Object.entries(overrides)) {
      if (!isSourceTrust(level)) {
        continue;
      }
      if (matchesGlob(entry.trim().toLowerCase(), normalized)) {
        return level;
      }
    }
  }
  // General outbound tools default to "med"; targeting is the separate axis.
  return "med";
}

export function targetingForTool(toolName: string, cfg?: OpenClawConfig): Targeting {
  const normalized = toolName.trim().toLowerCase();
  const risk = resolveRiskConfig(cfg);
  const configured = normalizeGlobList(risk?.inboundToUserTools);
  const tables = configured ?? [...DEFAULT_INBOUND_TO_USER_TOOLS];
  return tables.some((entry) => matchesGlob(entry, normalized)) ? "inbound_to_user" : "general";
}

function isSourceTrust(value: unknown): value is SourceTrust {
  return value === "user" || value === "low" || value === "med" || value === "high";
}

/**
 * Tool names (or trailing-`*` prefix globs) that act as honeypot traps. An agent
 * calling one is treated as lured by injection. Default empty: no tool is a trap
 * until an operator opts in.
 */
function resolveHoneypotTools(cfg?: OpenClawConfig): string[] {
  return normalizeGlobList(resolveRiskConfig(cfg)?.honeypotTools) ?? [];
}

/** True if a tool name matches any configured honeypot entry. */
export function isHoneypotTool(toolName: string, cfg?: OpenClawConfig): boolean {
  const normalized = toolName.trim().toLowerCase();
  return resolveHoneypotTools(cfg).some((entry) => matchesGlob(entry, normalized));
}

/**
 * Opt-in master switch for guarding untrusted channel-ingest messages in
 * before_dispatch. Default false so the existing channel behavior (only the
 * conversational `clear` short-circuit) is preserved until an operator turns it
 * on. Enabling it couples untrusted inbound delivery to guard-service health.
 */
export function resolveGuardChannels(cfg?: OpenClawConfig): boolean {
  return resolveRiskConfig(cfg)?.guardChannels === true;
}

/**
 * Source-trust level applied to inbound messages from a given channel. Unknown
 * channels default to "med" (untrusted-but-not-hostile). Operators can raise or
 * lower per channel via `risk.channelSourceTrust` (e.g. a paired DM channel).
 */
export function resolveChannelSourceTrust(
  cfg: OpenClawConfig | undefined,
  channel: string | undefined,
): SourceTrust {
  const normalized = channel?.trim().toLowerCase();
  if (!normalized) {
    return "med";
  }
  const map = resolveRiskConfig(cfg)?.channelSourceTrust;
  if (!isRecord(map)) {
    return "med";
  }
  const level = map[normalized];
  return isSourceTrust(level) ? level : "med";
}
