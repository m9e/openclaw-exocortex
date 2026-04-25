import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  callLocksmith,
  fetchLocksmithHealth,
  listLocksmithTools,
  LocksmithError,
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
  resolveLocksmithProjectedTools,
  resolveLocksmithPromptCatalogEnabled,
  resolveLocksmithTimeoutMs,
} from "./config.js";
import {
  buildLocksmithDynamicCatalogGuidance,
  buildLocksmithStaticPromptGuidance,
} from "./prompt-guidance.js";
import { createLocksmithCallTool, createLocksmithProjectedToolFactory } from "./tool.js";

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
    await expect(buildLocksmithDynamicCatalogGuidance(cfg)).resolves.toContain(
      "github: GitHub REST API",
    );
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

function buildConfigWithProjectedTools(
  toolsBlock: Record<string, unknown>,
  promptCatalog?: boolean,
): OpenClawConfig {
  return {
    plugins: {
      entries: {
        locksmith: {
          config: {
            baseUrl: "http://127.0.0.1:9200",
            ...(promptCatalog === undefined ? {} : { promptCatalog }),
            tools: toolsBlock,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function fakeApi(cfg: OpenClawConfig): OpenClawPluginApi {
  return { config: cfg } as unknown as OpenClawPluginApi;
}

function fakeCtx(agentId = "agent-test"): OpenClawPluginToolContext {
  return { agentId } as OpenClawPluginToolContext;
}

describe("locksmith projection / prompt-cache stability", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetLocksmithDiscoveryCacheForTest();
  });

  it("resolves projected tools deterministically across object insertion order", () => {
    const a = buildConfigWithProjectedTools({
      tavily: { enabled: true },
      github: { enabled: true },
      brave: { enabled: true },
    });
    const b = buildConfigWithProjectedTools({
      brave: { enabled: true },
      github: { enabled: true },
      tavily: { enabled: true },
    });
    const namesA = resolveLocksmithProjectedTools(a).map((t) => t.toolName);
    const namesB = resolveLocksmithProjectedTools(b).map((t) => t.toolName);
    expect(namesA).toEqual(["locksmith_brave", "locksmith_github", "locksmith_tavily"]);
    expect(namesB).toEqual(namesA);
  });

  it("filters out disabled, malformed, and duplicate slugs", () => {
    const cfg = buildConfigWithProjectedTools({
      github: { enabled: true },
      tavily: { enabled: false },
      "Bad Slug!": { enabled: true },
      "": { enabled: true },
      DUPLICATE: { enabled: true },
      duplicate: { enabled: true, label: "later wins" },
    });
    const slugs = resolveLocksmithProjectedTools(cfg).map((t) => t.slug);
    expect(slugs).toEqual(["duplicate", "github"]);
  });

  it("synthetic factory registers one AnyAgentTool per enabled slug, sorted", () => {
    const cfg = buildConfigWithProjectedTools({
      tavily: { enabled: true, description: "Search" },
      github: { enabled: true },
    });
    const factory = createLocksmithProjectedToolFactory(fakeApi(cfg));
    const result = factory(fakeCtx());
    expect(Array.isArray(result)).toBe(true);
    const tools = result as AnyAgentTool[];
    expect(tools.map((tool) => tool.name)).toEqual(["locksmith_github", "locksmith_tavily"]);
  });

  it("synthetic factory does not call the Locksmith service during registration", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const cfg = buildConfigWithProjectedTools({
      github: { enabled: true },
      tavily: { enabled: true },
    });
    const factory = createLocksmithProjectedToolFactory(fakeApi(cfg));
    factory(fakeCtx());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("static prompt guidance is byte-stable across object insertion order", () => {
    const cfg1 = buildConfigWithProjectedTools({
      tavily: { enabled: true },
      github: { enabled: true, description: "GitHub REST" },
    });
    const cfg2 = buildConfigWithProjectedTools({
      github: { enabled: true, description: "GitHub REST" },
      tavily: { enabled: true },
    });
    expect(buildLocksmithStaticPromptGuidance(cfg1)).toBe(buildLocksmithStaticPromptGuidance(cfg2));
  });

  it("static prompt guidance does not depend on Locksmith service state", async () => {
    const cfg = buildConfigWithProjectedTools({ github: { enabled: true } });
    const baseline = buildLocksmithStaticPromptGuidance(cfg);

    // Service offline (fetch rejects with a connect error) — still byte-stable.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" }),
    );
    expect(buildLocksmithStaticPromptGuidance(cfg)).toBe(baseline);

    // Service returns a different catalog — static guidance still byte-stable.
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tools: [{ name: "github" }, { name: "tavily" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(buildLocksmithStaticPromptGuidance(cfg)).toBe(baseline);
  });

  it("dynamic catalog renders deterministically regardless of /tools order", async () => {
    const cfg: OpenClawConfig = {
      plugins: {
        entries: { locksmith: { config: { baseUrl: "http://127.0.0.1:9200" } } },
      },
    } as OpenClawConfig;

    const orderA = [{ name: "tavily" }, { name: "github" }, { name: "brave" }];
    const orderB = [{ name: "brave" }, { name: "tavily" }, { name: "github" }];

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ tools: orderA }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const renderedA = await buildLocksmithDynamicCatalogGuidance(cfg);

    resetLocksmithDiscoveryCacheForTest();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ tools: orderB }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const renderedB = await buildLocksmithDynamicCatalogGuidance(cfg);

    expect(renderedA).toBe(renderedB);
  });

  it("dynamic catalog is skipped when projected tools are configured", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const cfg = buildConfigWithProjectedTools({ github: { enabled: true } });
    await expect(buildLocksmithDynamicCatalogGuidance(cfg)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("locksmith client error mapping", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetLocksmithDiscoveryCacheForTest();
  });

  const cfg = {
    plugins: {
      entries: { locksmith: { config: { baseUrl: "http://127.0.0.1:9200" } } },
    },
  } as OpenClawConfig;

  it("sends X-Locksmith-User on call when provided", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await callLocksmith({
      cfg,
      tool: "github",
      user: "agent-7",
    });
    const headers = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("X-Locksmith-User")).toBe("agent-7");
  });

  it("ignores caller-provided X-Locksmith-User overrides in headers map", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await callLocksmith({
      cfg,
      tool: "github",
      user: "agent-7",
      headers: { "X-Locksmith-User": "spoofed" },
    });
    const headers = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("X-Locksmith-User")).toBe("agent-7");
  });

  it("maps a connect refused fetch failure to service-unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" }),
    );
    await expect(callLocksmith({ cfg, tool: "github" })).rejects.toMatchObject({
      code: "service-unreachable",
      tool: "github",
    });
    await expect(callLocksmith({ cfg, tool: "github" })).rejects.toBeInstanceOf(LocksmithError);
  });

  it("maps a 404 to tool-absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(callLocksmith({ cfg, tool: "github" })).rejects.toMatchObject({
      code: "tool-absent",
      status: 404,
    });
  });

  it("maps a 403 service-disabled error.type to service-disabled", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "Tool disabled by admin", type: "service-disabled" } }),
        {
          status: 403,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    await expect(callLocksmith({ cfg, tool: "github" })).rejects.toMatchObject({
      code: "service-disabled",
      status: 403,
    });
  });
});
