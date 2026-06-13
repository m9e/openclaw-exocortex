import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateEntry } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it } from "vitest";
import { type Incident, recordIncident } from "./incidents.js";
import { createUntrustedContentRevealTool } from "./reveal-tool.js";

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
      return [...map.entries()].map(([key, value]) => ({ key, value, createdAt: (tick += 1) }));
    },
    async clear(): Promise<void> {
      map.clear();
    },
  };
}

type FakeStore = ReturnType<typeof createFakeStore>;

function createFakeApi(store: FakeStore): OpenClawPluginApi {
  return {
    config: {},
    runtime: { state: { openKeyedStore: () => store } },
  } as unknown as OpenClawPluginApi;
}

// The tool returns a jsonResult; pull the embedded JSON text back out so tests
// can assert on the structured payload regardless of the result envelope shape.
function parseToolResult(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const text = content?.find((block) => block.type === "text")?.text ?? "";
  return JSON.parse(text) as Record<string, unknown>;
}

describe("createUntrustedContentRevealTool", () => {
  it("reveals sanitized full text for a summarize-tier incident", async () => {
    const store = createFakeStore();
    const api = createFakeApi(store);
    const inc = await recordIncident(api, {
      tier: "summarize",
      tool: "web_fetch",
      score: 42,
      sanitizedContent: "the sanitized full body text",
      summary: "short summary",
    });

    const tool = createUntrustedContentRevealTool(api);
    const parsed = parseToolResult(await tool.execute("call-1", { code: inc.code }));

    expect(parsed.tier).toBe("summarize");
    expect(String(parsed.content)).toContain("the sanitized full body text");
    expect(String(parsed.content)).toContain("EXTERNAL_UNTRUSTED_CONTENT");
  });

  it("refuses a quarantine-tier incident", async () => {
    const store = createFakeStore();
    const api = createFakeApi(store);
    const inc = await recordIncident(api, {
      tier: "quarantine",
      tool: "web_fetch",
      score: 80,
      contentId: "cid-1",
    });

    const tool = createUntrustedContentRevealTool(api);
    const parsed = parseToolResult(await tool.execute("call-1", { code: inc.code }));

    expect(parsed.revealed).toBe(false);
    expect(String(parsed.message)).toContain("operator review");
  });

  it("refuses a breaker-tier incident", async () => {
    const store = createFakeStore();
    const api = createFakeApi(store);
    const inc = await recordIncident(api, {
      tier: "breaker",
      tool: "browser",
      score: 99,
      contentId: "cid-2",
    });

    const tool = createUntrustedContentRevealTool(api);
    const parsed = parseToolResult(await tool.execute("call-1", { code: inc.code }));

    expect(parsed.revealed).toBe(false);
    expect(String(parsed.message)).toContain("not revealable");
  });

  it("refuses a summarize-tier incident missing sanitized content", async () => {
    const store = createFakeStore();
    const api = createFakeApi(store);
    const inc = await recordIncident(api, {
      tier: "summarize",
      tool: "web_fetch",
      score: 30,
      summary: "only a summary, no full text retained",
    });

    const tool = createUntrustedContentRevealTool(api);
    const parsed = parseToolResult(await tool.execute("call-1", { code: inc.code }));

    expect(parsed.revealed).toBe(false);
  });

  it("refuses an unknown code", async () => {
    const store = createFakeStore();
    const api = createFakeApi(store);

    const tool = createUntrustedContentRevealTool(api);
    const parsed = parseToolResult(await tool.execute("call-1", { code: "ZZZZZZ" }));

    expect(parsed.revealed).toBe(false);
    expect(parsed.code).toBe("ZZZZZZ");
  });
});
