import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  CONFIRMED_JAILBREAK_CONFIDENCE,
  DEFAULT_RISK_WEIGHTS,
  classifyRisk,
  deriveMessageClass,
  resolveRiskWeights,
  sourceTrustForTool,
  targetingForTool,
  type MessageClass,
  type RiskInput,
  type RiskTier,
  type SourceTrust,
  type Targeting,
} from "./risk.js";

function buildInput(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    sourceTrust: "user",
    messageClass: "low",
    targeting: "general",
    honeypot: false,
    confirmedJailbreak: false,
    ...overrides,
  };
}

function buildRiskConfig(risk: unknown): OpenClawConfig {
  return {
    plugins: { entries: { "untrusted-content": { enabled: true, config: { risk } } } },
  } as OpenClawConfig;
}

describe("classifyRisk", () => {
  const cases: Array<{
    name: string;
    input: RiskInput;
    score: number;
    tier: RiskTier;
    breakerReason?: "honeypot" | "confirmed_jailbreak";
  }> = [
    // Tier boundaries on the numeric axis.
    {
      name: "pass below summarizeAt",
      input: buildInput({ messageClass: "high" }),
      score: 4,
      tier: "pass",
    },
    {
      name: "summarize at lower boundary (5)",
      input: buildInput({ sourceTrust: "low", messageClass: "high" }),
      score: 5,
      tier: "summarize",
    },
    {
      name: "summarize just below quarantineAt (7)",
      input: buildInput({ sourceTrust: "med", messageClass: "med", targeting: "inbound_to_user" }),
      score: 7,
      tier: "summarize",
    },
    {
      name: "quarantine at lower boundary (8): high+med+inbound",
      input: buildInput({ sourceTrust: "high", messageClass: "med", targeting: "inbound_to_user" }),
      score: 8,
      tier: "quarantine",
    },
    {
      name: "quarantine high+high+inbound (10)",
      input: buildInput({
        sourceTrust: "high",
        messageClass: "high",
        targeting: "inbound_to_user",
      }),
      score: 10,
      tier: "quarantine",
    },
    {
      name: "pass user+low+general (1)",
      input: buildInput({ sourceTrust: "user", messageClass: "low", targeting: "general" }),
      score: 1,
      tier: "pass",
    },
    {
      name: "summarize med+med+inbound (7)",
      input: buildInput({ sourceTrust: "med", messageClass: "med", targeting: "inbound_to_user" }),
      score: 7,
      tier: "summarize",
    },
    // Breaker is special: it wins even when the numeric score is low.
    {
      name: "breaker on honeypot adds bonus",
      input: buildInput({ honeypot: true }),
      score: 1 + DEFAULT_RISK_WEIGHTS.honeypotBonus,
      tier: "breaker",
      breakerReason: "honeypot",
    },
    {
      name: "breaker on confirmedJailbreak with low numeric score",
      input: buildInput({ confirmedJailbreak: true }),
      score: 1,
      tier: "breaker",
      breakerReason: "confirmed_jailbreak",
    },
    {
      name: "honeypot takes precedence over confirmedJailbreak",
      input: buildInput({ honeypot: true, confirmedJailbreak: true }),
      score: 1 + DEFAULT_RISK_WEIGHTS.honeypotBonus,
      tier: "breaker",
      breakerReason: "honeypot",
    },
  ];

  for (const { name, input, score, tier, breakerReason } of cases) {
    it(name, () => {
      const result = classifyRisk(input);
      expect(result.score).toBe(score);
      expect(result.tier).toBe(tier);
      expect(result.breakerReason).toBe(breakerReason);
    });
  }

  it("reaches exactly quarantineAt (8) via custom weights", () => {
    const result = classifyRisk(
      buildInput({ sourceTrust: "high", messageClass: "high", targeting: "inbound_to_user" }),
      { ...DEFAULT_RISK_WEIGHTS, quarantineAt: 10 },
    );
    expect(result.score).toBe(10);
    expect(result.tier).toBe("quarantine");
  });

  it("honors tunable thresholds", () => {
    const weights = { ...DEFAULT_RISK_WEIGHTS, summarizeAt: 2, quarantineAt: 3 };
    expect(classifyRisk(buildInput({ messageClass: "low" }), weights).tier).toBe("pass");
    expect(classifyRisk(buildInput({ messageClass: "med" }), weights).tier).toBe("summarize");
    expect(classifyRisk(buildInput({ messageClass: "high" }), weights).tier).toBe("quarantine");
  });
});

describe("deriveMessageClass", () => {
  const cases: Array<{
    name: string;
    params: Parameters<typeof deriveMessageClass>[0];
    messageClass: MessageClass;
    confirmedJailbreak: boolean;
  }> = [
    {
      name: "block verdict -> high + confirmedJailbreak (reaches breaker)",
      params: { quarantined: false, maxThreatConfidence: 0, verdict: "block" },
      messageClass: "high",
      confirmedJailbreak: true,
    },
    {
      name: "critical severity threat -> confirmedJailbreak (reaches breaker)",
      params: { quarantined: false, maxThreatConfidence: 0, hasCriticalThreat: true },
      messageClass: "low",
      confirmedJailbreak: true,
    },
    {
      name: "confidence 0.96 -> high + confirmedJailbreak",
      params: { quarantined: false, maxThreatConfidence: 0.96 },
      messageClass: "high",
      confirmedJailbreak: true,
    },
    {
      name: "confidence 0.9 -> high without confirmedJailbreak",
      params: { quarantined: false, maxThreatConfidence: 0.9 },
      messageClass: "high",
      confirmedJailbreak: false,
    },
    {
      name: "conf 0.90 with flag verdict and no critical -> not confirmed (stays high/quarantine)",
      params: {
        quarantined: false,
        maxThreatConfidence: 0.9,
        verdict: "flag",
        hasCriticalThreat: false,
      },
      messageClass: "high",
      confirmedJailbreak: false,
    },
    {
      name: "flag verdict -> med",
      params: { quarantined: false, maxThreatConfidence: 0, verdict: "flag" },
      messageClass: "med",
      confirmedJailbreak: false,
    },
    {
      name: "confidence 0.7 -> med",
      params: { quarantined: false, maxThreatConfidence: 0.7 },
      messageClass: "med",
      confirmedJailbreak: false,
    },
    {
      name: "clean low confidence -> low",
      params: { quarantined: false, maxThreatConfidence: 0.1, verdict: "pass" },
      messageClass: "low",
      confirmedJailbreak: false,
    },
    {
      name: "quarantined clean content floors at med",
      params: { quarantined: true, maxThreatConfidence: 0, verdict: "pass" },
      messageClass: "med",
      confirmedJailbreak: false,
    },
    {
      name: "exactly the confirmed-jailbreak threshold",
      params: { quarantined: false, maxThreatConfidence: CONFIRMED_JAILBREAK_CONFIDENCE },
      messageClass: "high",
      confirmedJailbreak: true,
    },
  ];

  for (const { name, params, messageClass, confirmedJailbreak } of cases) {
    it(name, () => {
      const result = deriveMessageClass(params);
      expect(result.messageClass).toBe(messageClass);
      expect(result.confirmedJailbreak).toBe(confirmedJailbreak);
    });
  }
});

describe("resolveRiskWeights", () => {
  it("returns defaults when no config is present", () => {
    expect(resolveRiskWeights()).toEqual(DEFAULT_RISK_WEIGHTS);
    expect(resolveRiskWeights({} as OpenClawConfig)).toEqual(DEFAULT_RISK_WEIGHTS);
  });

  it("deep-merges partial map overrides and scalar thresholds", () => {
    const cfg = buildRiskConfig({
      source: { high: 5 },
      message: { high: 6 },
      targeting: { inbound_to_user: 4 },
      honeypotBonus: 50,
      summarizeAt: 3,
      quarantineAt: 9,
    });
    const weights = resolveRiskWeights(cfg);
    expect(weights.source).toEqual({ user: 0, low: 1, med: 2, high: 5 });
    expect(weights.message).toEqual({ low: 1, med: 2, high: 6 });
    expect(weights.targeting).toEqual({ general: 0, inbound_to_user: 4 });
    expect(weights.honeypotBonus).toBe(50);
    expect(weights.summarizeAt).toBe(3);
    expect(weights.quarantineAt).toBe(9);
  });

  it("ignores malformed (non-number) overrides and falls back to defaults", () => {
    const cfg = buildRiskConfig({
      source: { high: "oops", low: Number.NaN },
      honeypotBonus: "big",
      summarizeAt: null,
      quarantineAt: [],
    });
    const weights = resolveRiskWeights(cfg);
    expect(weights.source).toEqual(DEFAULT_RISK_WEIGHTS.source);
    expect(weights.honeypotBonus).toBe(DEFAULT_RISK_WEIGHTS.honeypotBonus);
    expect(weights.summarizeAt).toBe(DEFAULT_RISK_WEIGHTS.summarizeAt);
    expect(weights.quarantineAt).toBe(DEFAULT_RISK_WEIGHTS.quarantineAt);
  });

  it("ignores a non-object risk block", () => {
    expect(resolveRiskWeights(buildRiskConfig("nope"))).toEqual(DEFAULT_RISK_WEIGHTS);
    expect(resolveRiskWeights(buildRiskConfig([1, 2, 3]))).toEqual(DEFAULT_RISK_WEIGHTS);
  });
});

describe("sourceTrustForTool", () => {
  it("defaults all tools to med", () => {
    expect(sourceTrustForTool("web_fetch")).toBe<SourceTrust>("med");
    expect(sourceTrustForTool("browser")).toBe<SourceTrust>("med");
  });

  it("applies exact and glob overrides from config", () => {
    const cfg = buildRiskConfig({
      toolSourceTrust: { browser: "high", "internal_*": "user" },
    });
    expect(sourceTrustForTool("browser", cfg)).toBe<SourceTrust>("high");
    expect(sourceTrustForTool("internal_status", cfg)).toBe<SourceTrust>("user");
    expect(sourceTrustForTool("web_fetch", cfg)).toBe<SourceTrust>("med");
  });

  it("ignores override entries with invalid levels", () => {
    const cfg = buildRiskConfig({ toolSourceTrust: { browser: "extreme" } });
    expect(sourceTrustForTool("browser", cfg)).toBe<SourceTrust>("med");
  });
});

describe("targetingForTool", () => {
  it("defaults general web tools to general", () => {
    expect(targetingForTool("web_fetch")).toBe<Targeting>("general");
    expect(targetingForTool("browser")).toBe<Targeting>("general");
    expect(targetingForTool("web_search")).toBe<Targeting>("general");
  });

  it("classifies default inbound-to-user tool prefixes", () => {
    expect(targetingForTool("email_read")).toBe<Targeting>("inbound_to_user");
    expect(targetingForTool("calendar_list")).toBe<Targeting>("inbound_to_user");
    expect(targetingForTool("gmail_search_threads")).toBe<Targeting>("inbound_to_user");
    expect(targetingForTool("imessage_chat_messages")).toBe<Targeting>("inbound_to_user");
  });

  it("honors a config override list", () => {
    const cfg = buildRiskConfig({ inboundToUserTools: ["slack_*"] });
    expect(targetingForTool("slack_read_channel", cfg)).toBe<Targeting>("inbound_to_user");
    // Override replaces defaults, so email is no longer inbound here.
    expect(targetingForTool("email_read", cfg)).toBe<Targeting>("general");
  });
});
