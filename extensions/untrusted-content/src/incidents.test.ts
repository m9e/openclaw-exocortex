import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateEntry } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it } from "vitest";
import {
  type Incident,
  clearIncident,
  findActiveBlockForSession,
  generateIncidentCode,
  getIncident,
  listActiveIncidents,
  recordIncident,
} from "./incidents.js";

/**
 * Minimal Map-backed store implementing the subset of PluginStateKeyedStore the
 * incident helpers use. `createdAt` is monotonically increased per insert so the
 * most-recent active-block query has deterministic ordering.
 */
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

function createFakeApi(store: FakeStore): OpenClawPluginApi {
  return {
    runtime: {
      state: {
        openKeyedStore: () => store,
      },
    },
  } as unknown as OpenClawPluginApi;
}

const BASE_INPUT: Omit<Incident, "code" | "createdAt" | "active"> = {
  tier: "breaker",
  tool: "web_fetch",
  score: 99,
};

describe("generateIncidentCode", () => {
  it("returns 6 chars from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateIncidentCode();
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    }
  });

  it("is effectively unique across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(generateIncidentCode());
    }
    // Birthday-paradox collisions are vanishingly unlikely over 31^6 space.
    expect(seen.size).toBe(1000);
  });
});

describe("recordIncident / getIncident", () => {
  it("stores a breaker incident as active with a stamped createdAt", async () => {
    const store = createFakeStore();
    const api = createFakeApi(store);

    const incident = await recordIncident(api, {
      ...BASE_INPUT,
      sessionKey: "sess-1",
      breakerReason: "honeypot",
    });

    expect(incident.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(incident.active).toBe(true);
    expect(typeof incident.createdAt).toBe("number");

    const fetched = await getIncident(api, incident.code);
    expect(fetched).toEqual(incident);
  });

  it("defaults non-breaker tiers to inactive but honors an explicit active flag", async () => {
    const store = createFakeStore();
    const api = createFakeApi(store);

    const summarize = await recordIncident(api, {
      tier: "summarize",
      tool: "browser",
      score: 5,
      summary: "redacted",
    });
    expect(summarize.active).toBe(false);

    const forcedActive = await recordIncident(api, {
      tier: "quarantine",
      tool: "browser",
      score: 8,
      active: true,
    });
    expect(forcedActive.active).toBe(true);
  });

  it("normalizes a lowercase code on lookup", async () => {
    const store = createFakeStore();
    const api = createFakeApi(store);

    const incident = await recordIncident(api, BASE_INPUT);
    const fetched = await getIncident(api, `  ${incident.code.toLowerCase()}  `);
    expect(fetched?.code).toBe(incident.code);
  });
});

describe("findActiveBlockForSession", () => {
  it("returns only an active incident matching the session", async () => {
    const store = createFakeStore();
    const api = createFakeApi(store);

    await recordIncident(api, { ...BASE_INPUT, sessionKey: "sess-A" });
    const cleared = await recordIncident(api, { ...BASE_INPUT, sessionKey: "sess-B" });
    await clearIncident(api, cleared.code, "user");
    // Inactive summarize for sess-A must be ignored.
    await recordIncident(api, {
      tier: "summarize",
      tool: "browser",
      score: 5,
      sessionKey: "sess-A",
    });

    const blockA = await findActiveBlockForSession(api, "sess-A");
    expect(blockA?.sessionKey).toBe("sess-A");
    expect(blockA?.active).toBe(true);

    // sess-B's only incident was cleared, so no active block remains.
    expect(await findActiveBlockForSession(api, "sess-B")).toBeUndefined();
    expect(await findActiveBlockForSession(api, "sess-none")).toBeUndefined();
  });

  it("returns the most recent active incident for a session by createdAt", async () => {
    const store = createFakeStore();
    const api = createFakeApi(store);

    // recordIncident stamps Date.now(), which can tie within a tight loop, so
    // overwrite createdAt directly to assert the max-createdAt selection.
    const first = await recordIncident(api, { ...BASE_INPUT, sessionKey: "sess-X" });
    const second = await recordIncident(api, { ...BASE_INPUT, sessionKey: "sess-X" });
    store.map.set(first.code, { ...first, createdAt: 100 });
    store.map.set(second.code, { ...second, createdAt: 200 });

    const latest = await findActiveBlockForSession(api, "sess-X");
    expect(latest?.code).toBe(second.code);

    // Lower the second's createdAt below the first and the first now wins.
    store.map.set(second.code, { ...second, createdAt: 50 });
    const latestAfter = await findActiveBlockForSession(api, "sess-X");
    expect(latestAfter?.code).toBe(first.code);
  });
});

describe("listActiveIncidents", () => {
  it("returns only active incidents, newest-first by createdAt", async () => {
    const store = createFakeStore();
    const api = createFakeApi(store);

    const first = await recordIncident(api, { ...BASE_INPUT, sessionKey: "sess-A" });
    const second = await recordIncident(api, { ...BASE_INPUT, sessionKey: "sess-B" });
    const third = await recordIncident(api, { ...BASE_INPUT, sessionKey: "sess-C" });
    // An inactive (cleared) block and an inactive summarize must be excluded.
    await clearIncident(api, second.code, "user");
    await recordIncident(api, { tier: "summarize", tool: "browser", score: 5 });

    store.map.set(first.code, { ...store.map.get(first.code)!, createdAt: 100 });
    store.map.set(third.code, { ...store.map.get(third.code)!, createdAt: 300 });

    const active = await listActiveIncidents(api);
    expect(active.map((entry) => entry.code)).toEqual([third.code, first.code]);
    expect(active.every((entry) => entry.active === true)).toBe(true);
  });

  it("returns an empty list when nothing is active", async () => {
    const store = createFakeStore();
    const api = createFakeApi(store);
    const inc = await recordIncident(api, { ...BASE_INPUT, sessionKey: "sess-A" });
    await clearIncident(api, inc.code, "user");
    expect(await listActiveIncidents(api)).toEqual([]);
  });
});

describe("clearIncident", () => {
  it("flips active to false and stamps clearedBy/clearedAt", async () => {
    const store = createFakeStore();
    const api = createFakeApi(store);

    const incident = await recordIncident(api, { ...BASE_INPUT, sessionKey: "sess-1" });
    const cleared = await clearIncident(api, incident.code, "yod");

    expect(cleared?.active).toBe(false);
    expect(cleared?.clearedBy).toBe("yod");
    expect(cleared?.clearedAt).toBeGreaterThanOrEqual(incident.createdAt);

    const fetched = await getIncident(api, incident.code);
    expect(fetched?.active).toBe(false);
  });

  it("clears via a lowercased code", async () => {
    const store = createFakeStore();
    const api = createFakeApi(store);

    const incident = await recordIncident(api, BASE_INPUT);
    const cleared = await clearIncident(api, incident.code.toLowerCase(), "yod");
    expect(cleared?.code).toBe(incident.code);
    expect(cleared?.active).toBe(false);
  });

  it("returns undefined for an unknown code", async () => {
    const store = createFakeStore();
    const api = createFakeApi(store);
    expect(await clearIncident(api, "ZZZZZZ", "yod")).toBeUndefined();
  });
});
