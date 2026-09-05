import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import {
  BREAKER_NOTIFY_PREFIX,
  buildBreakerAdvisory,
  notifyBreaker,
  resolveBreakerNotifyChannels,
  resolveBreakerNotifyEnabled,
  resolveOwnerTarget,
} from "./breaker-notify.js";

type SentMessage = { channel: string; to: string; text: string };

type AdapterOverrides = {
  loadAdapter?: (channelId: string) => Promise<unknown>;
};

function buildApi(
  config: OpenClawConfig,
  capture: SentMessage[],
  overrides: AdapterOverrides = {},
): { api: OpenClawPluginApi; warnings: string[] } {
  const warnings: string[] = [];
  const loadAdapter =
    overrides.loadAdapter ??
    (async (channelId: string) => ({
      sendText: async (args: { to: string; text: string }) => {
        capture.push({ channel: channelId, to: args.to, text: args.text });
        return { messageId: "1" };
      },
    }));
  const api = {
    config,
    runtime: { channel: { outbound: { loadAdapter } } },
    logger: { warn: (msg: string) => warnings.push(msg) },
  } as unknown as OpenClawPluginApi;
  return { api, warnings };
}

function cfgWithChannels(
  channels: Record<string, unknown>,
  risk?: Record<string, unknown>,
): OpenClawConfig {
  return {
    channels,
    ...(risk ? { plugins: { entries: { "untrusted-content": { config: { risk } } } } } : {}),
  } as unknown as OpenClawConfig;
}

describe("buildBreakerAdvisory", () => {
  it("starts with the prefix on line 1 and includes the code when includeCode", () => {
    const text = buildBreakerAdvisory({
      code: "FQ35PZ",
      tool: "web_fetch",
      breakerReason: "confirmed_jailbreak",
      agentName: "Moss",
      includeCode: true,
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe(BREAKER_NOTIFY_PREFIX);
    expect(text).toContain("FQ35PZ");
    expect(text).toContain("clear FQ35PZ");
    expect(text).toContain('"Moss"');
    expect(text).toContain("a confirmed prompt-injection/jailbreak");
  });

  it("omits the code and points to the operator CLI when includeCode is false", () => {
    const text = buildBreakerAdvisory({ code: "ABC123", tool: "browser", includeCode: false });
    expect(text.split("\n")[0]).toBe(BREAKER_NOTIFY_PREFIX);
    expect(text).not.toContain("clear ABC123");
    expect(text).toContain("operator CLI");
  });

  it("maps each breaker reason to its phrasing", () => {
    expect(
      buildBreakerAdvisory({ code: "C", tool: "t", breakerReason: "honeypot", includeCode: true }),
    ).toContain("a honeypot tool was triggered");
    expect(
      buildBreakerAdvisory({
        code: "C",
        tool: "t",
        breakerReason: "confirmed_jailbreak",
        includeCode: true,
      }),
    ).toContain("a confirmed prompt-injection/jailbreak");
    expect(buildBreakerAdvisory({ code: "C", tool: "t", includeCode: true })).toContain(
      "high-risk hostile content",
    );
  });
});

describe("resolveBreakerNotifyEnabled", () => {
  it("defaults to true and only an explicit false disables it", () => {
    expect(resolveBreakerNotifyEnabled(undefined)).toBe(true);
    expect(resolveBreakerNotifyEnabled(cfgWithChannels({}))).toBe(true);
    expect(resolveBreakerNotifyEnabled(cfgWithChannels({}, { breakerNotify: false }))).toBe(false);
    expect(resolveBreakerNotifyEnabled(cfgWithChannels({}, { breakerNotify: true }))).toBe(true);
  });
});

describe("resolveBreakerNotifyChannels", () => {
  it("returns enabled channels and skips disabled and non-channel sections", () => {
    const cfg = cfgWithChannels({
      defaults: { foo: 1 },
      modelByChannel: {},
      telegram: { defaultTo: "111" },
      slack: { enabled: false, defaultTo: "222" },
      imessage: { enabled: true, allowFrom: ["+1555"] },
    });
    expect(resolveBreakerNotifyChannels(cfg).toSorted()).toEqual(["imessage", "telegram"]);
  });

  it("restricts to the breakerNotifyChannels allow list when present", () => {
    const cfg = cfgWithChannels(
      { telegram: { defaultTo: "111" }, slack: { defaultTo: "222" } },
      { breakerNotifyChannels: ["telegram"] },
    );
    expect(resolveBreakerNotifyChannels(cfg)).toEqual(["telegram"]);
  });

  it("returns [] when no channels are configured", () => {
    expect(resolveBreakerNotifyChannels(undefined)).toEqual([]);
    expect(resolveBreakerNotifyChannels({} as OpenClawConfig)).toEqual([]);
  });
});

describe("resolveOwnerTarget", () => {
  it("prefers defaultTo, falls back to allowFrom[0], else undefined", () => {
    const cfg = cfgWithChannels({
      telegram: { defaultTo: 999, allowFrom: ["aaa"] },
      slack: { allowFrom: ["bbb", "ccc"] },
      irc: {},
    });
    expect(resolveOwnerTarget(cfg, "telegram")).toBe("999");
    expect(resolveOwnerTarget(cfg, "slack")).toBe("bbb");
    expect(resolveOwnerTarget(cfg, "irc")).toBeUndefined();
    expect(resolveOwnerTarget(cfg, "missing")).toBeUndefined();
  });
});

describe("notifyBreaker", () => {
  it("sends the advisory to both resolved owner targets", async () => {
    const capture: SentMessage[] = [];
    const cfg = cfgWithChannels({
      telegram: { defaultTo: "111" },
      imessage: { allowFrom: ["+1555", "+1666"] },
    });
    const { api } = buildApi(cfg, capture);
    await notifyBreaker(api, {
      code: "FQ35PZ",
      tool: "web_fetch",
      breakerReason: "confirmed_jailbreak",
    });

    expect(capture.map((m) => `${m.channel}:${m.to}`).toSorted()).toEqual([
      "imessage:+1555",
      "telegram:111",
    ]);
    for (const sent of capture) {
      expect(sent.text.split("\n")[0]).toBe(BREAKER_NOTIFY_PREFIX);
      expect(sent.text).toContain("FQ35PZ");
    }
  });

  it("is a no-op when breakerNotify is false", async () => {
    const capture: SentMessage[] = [];
    const cfg = cfgWithChannels({ telegram: { defaultTo: "111" } }, { breakerNotify: false });
    const { api } = buildApi(cfg, capture);
    await notifyBreaker(api, { code: "C", tool: "web_fetch" });
    expect(capture).toHaveLength(0);
  });

  it("is a no-op and does not throw when no channels are configured", async () => {
    const capture: SentMessage[] = [];
    const { api } = buildApi(cfgWithChannels({}), capture);
    await expect(notifyBreaker(api, { code: "C", tool: "web_fetch" })).resolves.toBeUndefined();
    expect(capture).toHaveLength(0);
  });

  it("restricts to telegram when breakerNotifyChannels names only telegram", async () => {
    const capture: SentMessage[] = [];
    const cfg = cfgWithChannels(
      { telegram: { defaultTo: "111" }, slack: { defaultTo: "222" } },
      { breakerNotifyChannels: ["telegram"] },
    );
    const { api } = buildApi(cfg, capture);
    await notifyBreaker(api, { code: "C", tool: "web_fetch" });
    expect(capture.map((m) => m.channel)).toEqual(["telegram"]);
  });

  it("never throws and still attempts other channels when one adapter/send fails", async () => {
    const capture: SentMessage[] = [];
    const cfg = cfgWithChannels({
      telegram: { defaultTo: "111" },
      slack: { defaultTo: "222" },
    });
    const loadAdapter = vi.fn(async (channelId: string) => {
      if (channelId === "telegram") {
        throw new Error("adapter boom");
      }
      return {
        sendText: async (args: { to: string; text: string }) => {
          if (channelId === "slack") {
            // slack adapter loads but its send throws.
            throw new Error("send boom");
          }
          capture.push({ channel: channelId, to: args.to, text: args.text });
          return { messageId: "1" };
        },
      };
    });
    const { api, warnings } = buildApi(cfg, capture, { loadAdapter });
    await expect(notifyBreaker(api, { code: "C", tool: "web_fetch" })).resolves.toBeUndefined();
    // telegram adapter threw (swallowed), slack send threw (warned); both channels attempted.
    expect(loadAdapter).toHaveBeenCalledWith("telegram");
    expect(loadAdapter).toHaveBeenCalledWith("slack");
    expect(warnings.some((w) => w.includes("slack send failed"))).toBe(true);
  });
});
