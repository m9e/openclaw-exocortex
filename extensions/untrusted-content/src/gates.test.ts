import assert from "node:assert/strict";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateEntry } from "openclaw/plugin-sdk/plugin-state-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Incident, recordIncident } from "./incidents.js";

const triggerHoneypot = vi.fn<
  (
    cfg: unknown,
    input: { toolName: string; sessionKey?: string; arguments?: unknown },
  ) => Promise<void>
>(async () => {});
vi.mock("./client.js", () => ({
  triggerHoneypot: (cfg: unknown, input: { toolName: string }) => triggerHoneypot(cfg, input),
}));

// Imported after the mock so the gate uses the stubbed triggerHoneypot.
const { evaluateBeforeToolCall } = await import("./gates.js");

/** Map-backed store covering the subset of PluginStateKeyedStore used here. */
function createFakeStore() {
  const map = new Map<string, Incident>();
  let tick = 0;
  return {
    map,
    async register(key: string, value: Incident): Promise<void> {
      map.set(key, value);
    },
    async registerIfAbsent(key: string, value: Incident): Promise<boolean> {
      if (map.has(key)) {
        return false;
      }
      map.set(key, value);
      return true;
    },
    async lookup(key: string): Promise<Incident | undefined> {
      return map.get(key);
    },
    async consume(key: string): Promise<Incident | undefined> {
      const value = map.get(key);
      map.delete(key);
      return value;
    },
    async delete(key: string): Promise<boolean> {
      return map.delete(key);
    },
    async entries(): Promise<PluginStateEntry<Incident>[]> {
      return [...map.entries()].map(([key, value]) => ({
        key,
        value,
        createdAt: (tick += 1),
      }));
    },
    async clear(): Promise<void> {
      map.clear();
    },
  };
}

type FakeStore = ReturnType<typeof createFakeStore>;

function createFakeApi(store: FakeStore, config?: OpenClawConfig): OpenClawPluginApi {
  // Route the internal active-blocks index to its own store so store.map stays
  // incidents-only for size assertions.
  const activeBlocks = createFakeStore();
  return {
    config,
    runtime: {
      state: {
        openKeyedStore: (opts: { namespace: string }) =>
          opts.namespace === "untrusted-content-active-blocks" ? activeBlocks : store,
      },
    },
  } as unknown as OpenClawPluginApi;
}

function configWithHoneypot(tools: string[]): OpenClawConfig {
  return {
    plugins: { entries: { "untrusted-content": { config: { risk: { honeypotTools: tools } } } } },
  } as unknown as OpenClawConfig;
}

beforeEach(() => {
  triggerHoneypot.mockClear();
});

describe("evaluateBeforeToolCall", () => {
  it("blocks every tool call once the session holds an active block", async () => {
    const store = createFakeStore();
    const api = createFakeApi(store);
    const block = await recordIncident(api, {
      tier: "breaker",
      breakerReason: "confirmed_jailbreak",
      tool: "web_fetch",
      score: 12,
      sessionKey: "sess-1",
      active: true,
    });

    const result = await evaluateBeforeToolCall(api, {
      toolName: "some_other_tool",
      sessionKey: "sess-1",
    });

    expect(result).toEqual({ block: true, reason: expect.stringContaining(block.code) });
    expect(result?.reason).toContain(`clear ${block.code}`);
    // Containment alone does not trigger the honeypot service call.
    expect(triggerHoneypot).not.toHaveBeenCalled();
  });

  it("records a breaker incident and blocks when a honeypot tool is called", async () => {
    const store = createFakeStore();
    const cfg = configWithHoneypot(["trap_*", "danger_tool"]);
    const api = createFakeApi(store, cfg);

    const result = await evaluateBeforeToolCall(api, {
      toolName: "trap_exfiltrate",
      sessionKey: "sess-2",
      agentId: "agent-9",
      arguments: { to: "evil@example.com" },
    });

    expect(result?.block).toBe(true);
    expect(triggerHoneypot).toHaveBeenCalledTimes(1);
    expect(triggerHoneypot).toHaveBeenCalledWith(cfg, {
      toolName: "trap_exfiltrate",
      sessionKey: "sess-2",
      arguments: { to: "evil@example.com" },
    });

    const incidents = [...store.map.values()];
    expect(incidents).toHaveLength(1);
    const incident = incidents[0];
    assert(incident);
    expect(incident.tier).toBe("breaker");
    expect(incident.breakerReason).toBe("honeypot");
    expect(incident.active).toBe(true);
    expect(incident.sessionKey).toBe("sess-2");
    expect(incident.agentId).toBe("agent-9");
    expect(incident.score).toBe(99);
    // The block reason carries the freshly minted incident code.
    expect(result?.reason).toContain(incident.code);
  });

  it("blocks an already-contained session without recording a second incident", async () => {
    const store = createFakeStore();
    const cfg = configWithHoneypot(["trap_*"]);
    const api = createFakeApi(store, cfg);
    const block = await recordIncident(api, {
      tier: "breaker",
      breakerReason: "honeypot",
      tool: "trap_x",
      score: 99,
      sessionKey: "sess-3",
      active: true,
    });

    const result = await evaluateBeforeToolCall(api, {
      toolName: "trap_x",
      sessionKey: "sess-3",
    });

    expect(result).toEqual({ block: true, reason: expect.stringContaining(block.code) });
    // Active-block check runs before honeypot, so no new incident or call.
    expect(store.map.size).toBe(1);
    expect(triggerHoneypot).not.toHaveBeenCalled();
  });

  it("returns undefined for a benign tool on a clean session", async () => {
    const store = createFakeStore();
    const api = createFakeApi(store, configWithHoneypot(["trap_*"]));

    const result = await evaluateBeforeToolCall(api, {
      toolName: "web_fetch",
      sessionKey: "sess-4",
    });

    expect(result).toBeUndefined();
    expect(store.map.size).toBe(0);
    expect(triggerHoneypot).not.toHaveBeenCalled();
  });

  it("does not block when no honeypot tools are configured", async () => {
    const store = createFakeStore();
    const api = createFakeApi(store, {} as unknown as OpenClawConfig);

    const result = await evaluateBeforeToolCall(api, {
      toolName: "anything",
      sessionKey: "sess-5",
    });

    expect(result).toBeUndefined();
    expect(triggerHoneypot).not.toHaveBeenCalled();
  });
});
