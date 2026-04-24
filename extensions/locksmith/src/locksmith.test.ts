import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  callLocksmith,
  fetchLocksmithHealth,
  listLocksmithTools,
  resetLocksmithDiscoveryCacheForTest,
} from "./client.js";
import {
  DEFAULT_LOCKSMITH_BASE_URL,
  DEFAULT_LOCKSMITH_CATALOG_TTL_SECONDS,
  DEFAULT_LOCKSMITH_MAX_RESPONSE_BYTES,
  DEFAULT_LOCKSMITH_TIMEOUT_SECONDS,
  resolveLocksmithBaseUrl,
  resolveLocksmithCatalogTtlMs,
  resolveLocksmithInboundToken,
  resolveLocksmithMaxResponseBytes,
  resolveLocksmithPromptCatalogEnabled,
  resolveLocksmithTimeoutMs,
} from "./config.js";
import { buildLocksmithPromptGuidance } from "./prompt-guidance.js";
import { createLocksmithCallTool } from "./tool.js";

describe("locksmith config", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads plugin config with env fallbacks", () => {
    vi.stubEnv("LOCKSMITH_BASE_URL", "http://env-locksmith:9300");
    vi.stubEnv("LOCKSMITH_INBOUND_TOKEN", "env-token");
    const cfg = {
      plugins: {
        entries: {
          locksmith: {
            config: {
              baseUrl: "http://plugin-locksmith:9200",
              inboundToken: "plugin-token",
              catalogTtlSeconds: 12,
              timeoutSeconds: 25,
              maxResponseBytes: 4096,
              promptCatalog: false,
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveLocksmithBaseUrl(cfg)).toBe("http://plugin-locksmith:9200");
    expect(resolveLocksmithInboundToken(cfg)).toBe("plugin-token");
    expect(resolveLocksmithCatalogTtlMs(cfg)).toBe(12_000);
    expect(resolveLocksmithTimeoutMs(cfg)).toBe(25_000);
    expect(resolveLocksmithMaxResponseBytes(cfg)).toBe(4096);
    expect(resolveLocksmithPromptCatalogEnabled(cfg)).toBe(false);
  });

  it("uses sane defaults when config is absent", () => {
    expect(resolveLocksmithBaseUrl({} as OpenClawConfig)).toBe(DEFAULT_LOCKSMITH_BASE_URL);
    expect(resolveLocksmithInboundToken({} as OpenClawConfig)).toBeUndefined();
    expect(resolveLocksmithCatalogTtlMs({} as OpenClawConfig)).toBe(
      DEFAULT_LOCKSMITH_CATALOG_TTL_SECONDS * 1000,
    );
    expect(resolveLocksmithTimeoutMs({} as OpenClawConfig)).toBe(
      DEFAULT_LOCKSMITH_TIMEOUT_SECONDS * 1000,
    );
    expect(resolveLocksmithMaxResponseBytes({} as OpenClawConfig)).toBe(
      DEFAULT_LOCKSMITH_MAX_RESPONSE_BYTES,
    );
    expect(resolveLocksmithPromptCatalogEnabled({} as OpenClawConfig)).toBe(true);
  });
});

describe("locksmith client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetLocksmithDiscoveryCacheForTest();
  });

  it("discovers tools and caches the catalog", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tools: [{ name: "github" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const cfg = {
      plugins: {
        entries: {
          locksmith: {
            config: {
              baseUrl: "http://127.0.0.1:9200",
              catalogTtlSeconds: 60,
            },
          },
        },
      },
    } as OpenClawConfig;

    await expect(listLocksmithTools(cfg)).resolves.toEqual([{ name: "github" }]);
    await expect(listLocksmithTools(cfg)).resolves.toEqual([{ name: "github" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("calls Locksmith with injected inbound auth and parses JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: 1, ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "99",
        },
      }),
    );

    const cfg = {
      plugins: {
        entries: {
          locksmith: {
            config: {
              baseUrl: "http://127.0.0.1:9200",
              inboundToken: "secret-token",
            },
          },
        },
      },
    } as OpenClawConfig;

    const result = await callLocksmith({
      cfg,
      tool: "github",
      method: "POST",
      path: "repos/openclaw/openclaw/issues",
      query: { state: "open" },
      headers: {
        "X-Custom": "1",
        Authorization: "should-be-ignored",
      },
      json: { hello: "world" },
    });

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      bodyType: "json",
      data: { id: 1, ok: true },
      headers: {
        "x-ratelimit-remaining": "99",
      },
    });

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const requestUrl = fetchCall?.[0];
    expect(requestUrl).toBeInstanceOf(URL);
    expect((requestUrl as URL).toString()).toBe(
      "http://127.0.0.1:9200/api/github/repos/openclaw/openclaw/issues?state=open",
    );
    expect(fetchCall?.[1]?.method).toBe("POST");
    expect(fetchCall?.[1]?.headers).toBeInstanceOf(Headers);
    const headers = fetchCall?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer secret-token");
    expect(headers.get("X-Custom")).toBe("1");
  });

  it("fetches health and builds prompt guidance", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "ok", version: "0.1.0", tools: ["github"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tools: [{ name: "github", description: "GitHub REST API" }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    const cfg = {
      plugins: {
        entries: {
          locksmith: {
            config: {
              baseUrl: "http://127.0.0.1:9200",
            },
          },
        },
      },
    } as OpenClawConfig;

    await expect(fetchLocksmithHealth(cfg)).resolves.toMatchObject({
      status: "ok",
      version: "0.1.0",
      tools: ["github"],
    });
    await expect(buildLocksmithPromptGuidance(cfg)).resolves.toContain("github: GitHub REST API");
  });
});

describe("locksmith tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetLocksmithDiscoveryCacheForTest();
  });

  it("rejects unknown tools before executing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tools: [{ name: "github" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const tool = createLocksmithCallTool({
      config: {
        plugins: {
          entries: {
            locksmith: {
              config: {
                baseUrl: "http://127.0.0.1:9200",
                catalogTtlSeconds: 1,
              },
            },
          },
        },
      },
    } as never);

    await expect(
      tool.execute("call-1", {
        tool: "tavily",
        path: "v1/search",
      }),
    ).rejects.toThrow('Unknown Locksmith tool "tavily"');
  });
});
