import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  callKamiwazaTool,
  discoverKamiwazaTools,
  resetKamiwazaDiscoveryCacheForTest,
} from "./client.js";
import {
  kamiwazaExtensionNameMatches,
  resetKamiwazaCredentialStoreCacheForTest,
  resolveKamiwazaApiToken,
} from "./config.js";
import { buildKamiwazaDynamicCatalogGuidance } from "./prompt-guidance.js";

const EXTENSION_PATH = "/runtime/tools/tool-z-19607be6/mcp";

function cfg(config: Record<string, unknown>): OpenClawConfig {
  return {
    plugins: {
      entries: {
        kamiwaza: {
          config,
        },
      },
    },
  } as OpenClawConfig;
}

function getHeader(init: RequestInit | undefined, name: string): string | null {
  const headers = new Headers(init?.headers);
  return headers.get(name);
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function requestBody(init: RequestInit | undefined): string {
  return typeof init?.body === "string" ? init.body : "{}";
}

function mcpResponse(value: unknown, id: string): Response {
  return jsonResponse(value, {
    status: 200,
    headers: { "mcp-session-id": id },
  });
}

function decodeJwt(jwt: string, secret: string): Record<string, unknown> {
  const parts = jwt.split(".");
  expect(parts).toHaveLength(3);
  const signingInput = `${parts[0]}.${parts[1]}`;
  const signature = crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");
  expect(parts[2]).toBe(signature);
  return JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

function mockKamiwazaFetch(options: { expectedToken: string; expectDelegation?: boolean }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(requestUrl(input));
    expect(getHeader(init, "authorization")).toBe(`Bearer ${options.expectedToken}`);

    if (url.pathname === "/api/extensions") {
      return jsonResponse([
        {
          name: "tool-z-19607be6",
          type: "tool",
          phase: "Running",
          services: [{ ready: true, available_replicas: 1 }],
          endpoints: { external: "http://kamiwaza.local/runtime/tools/tool-z-19607be6" },
        },
        {
          name: "stopped",
          type: "tool",
          phase: "Failed",
          services: [{ ready: true, available_replicas: 1 }],
          endpoints: { external: "http://kamiwaza.local/runtime/tools/stopped" },
        },
      ]);
    }

    if (url.pathname !== EXTENSION_PATH) {
      return jsonResponse({ error: "unexpected path" }, { status: 404 });
    }

    const payload = JSON.parse(requestBody(init)) as { method?: string };
    switch (payload.method) {
      case "initialize":
        return mcpResponse(
          {
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "tool-z", version: "1.0.0" },
            },
          },
          "test-session",
        );
      case "notifications/initialized":
        return jsonResponse({}, { status: 202, headers: { "mcp-session-id": "test-session" } });
      case "tools/list":
        return mcpResponse(
          {
            jsonrpc: "2.0",
            id: 2,
            result: {
              tools: [
                {
                  name: "search",
                  description: "Search through Kamiwaza.",
                  inputSchema: {
                    type: "object",
                    properties: { query: { type: "string" } },
                    required: ["query"],
                  },
                },
              ],
            },
          },
          "test-session",
        );
      case "tools/call": {
        if (options.expectDelegation) {
          const header = getHeader(init, "x-kamiwaza-agent-delegation");
          expect(header).toMatch(/^Bearer /u);
          const claims = decodeJwt(header?.replace(/^Bearer /u, "") ?? "", "delegation-secret");
          expect(claims.sub).toBe("agent-main");
          expect(claims.scope).toBe("kamiwaza.tool.invoke");
          expect(claims.tool).toBe("kamiwaza_tool_z_19607be6_search");
          expect(claims.extension).toBe("tool-z-19607be6");
          expect(claims.mcp_tool).toBe("search");
        }
        return mcpResponse(
          {
            jsonrpc: "2.0",
            id: 3,
            result: { content: [{ type: "text", text: "ok" }] },
          },
          "test-session",
        );
      }
      default:
        return jsonResponse({ error: "unexpected MCP method" }, { status: 400 });
    }
  });
}

describe("kamiwaza direct plugin", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    resetKamiwazaDiscoveryCacheForTest();
    resetKamiwazaCredentialStoreCacheForTest();
  });

  it("discovers Kamiwaza MCP tools using the synced PAT store without exposing the token", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-kamiwaza-test-"));
    const storePath = path.join(dir, "kamiwaza-pat-store.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        credentials: [
          {
            host_name: "kamiwaza.local",
            aliases: ["kamiwaza.local"],
            token: "kamiwaza-token",
          },
        ],
      }),
    );
    mockKamiwazaFetch({ expectedToken: "kamiwaza-token" });

    const tools = await discoverKamiwazaTools(
      cfg({
        apiUrl: "http://kamiwaza.local/api",
        credentialStorePath: storePath,
      }),
    );

    expect(tools).toEqual([
      expect.objectContaining({
        name: "kamiwaza_tool_z_19607be6_search",
        description: "Search through Kamiwaza.",
        mcpTool: "search",
      }),
    ]);
    expect(JSON.stringify(tools)).not.toContain("kamiwaza-token");
  });

  it("uses the synced PAT store source host when a local API URL cannot identify one credential", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-kamiwaza-test-"));
    const storePath = path.join(dir, "kamiwaza-pat-store.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        source: { source_host: "mikoshi.local" },
        credentials: [
          {
            host_name: "relic",
            aliases: ["relic"],
            token: "relic-token",
          },
          {
            host_name: "mikoshi",
            aliases: ["mikoshi"],
            token: "mikoshi-token",
          },
        ],
      }),
    );

    expect(
      resolveKamiwazaApiToken(
        cfg({
          apiUrl: "http://host.lima.internal:4000/api",
          credentialStorePath: storePath,
        }),
      ),
    ).toBe("mikoshi-token");
  });

  it("reads raw pdash active token exports before the Lima sync step", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-kamiwaza-test-"));
    const storePath = path.join(dir, "pdash-pat-store.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        format: "pdash-pat-store-v1",
        source_host: "mikoshi.local",
        active_tokens: [
          {
            host_name: "mikoshi",
            token: "mikoshi-token",
          },
          {
            host_name: "yod",
            token: "yod-token",
          },
        ],
      }),
    );

    expect(
      resolveKamiwazaApiToken(
        cfg({
          apiUrl: "https://127.0.0.1/api",
          credentialStorePath: storePath,
          credentialHost: "yod",
        }),
      ),
    ).toBe("yod-token");

    resetKamiwazaCredentialStoreCacheForTest();

    expect(
      resolveKamiwazaApiToken(
        cfg({
          apiUrl: "https://127.0.0.1/api",
          credentialStorePath: storePath,
        }),
      ),
    ).toBe("mikoshi-token");
  });

  it("calls Kamiwaza MCP tools with a signed delegated agent identity when configured", async () => {
    mockKamiwazaFetch({ expectedToken: "kamiwaza-token", expectDelegation: true });

    const result = await callKamiwazaTool({
      cfg: cfg({
        apiUrl: "http://kamiwaza.local/api",
        apiToken: "kamiwaza-token",
        delegation: {
          enabled: true,
          required: true,
          signingSecret: "delegation-secret",
        },
      }),
      tool: "kamiwaza_tool_z_19607be6_search",
      arguments: { query: "openclaw" },
      agentId: "agent-main",
    });

    expect(result).toEqual({
      tool: "kamiwaza_tool_z_19607be6_search",
      result: { content: [{ type: "text", text: "ok" }] },
    });
  });

  it("fails closed when direct delegated identity is required but no agent id is available", async () => {
    mockKamiwazaFetch({ expectedToken: "kamiwaza-token" });

    await expect(
      callKamiwazaTool({
        cfg: cfg({
          apiUrl: "http://kamiwaza.local/api",
          apiToken: "kamiwaza-token",
          delegation: {
            enabled: true,
            required: true,
            signingSecret: "delegation-secret",
          },
        }),
        tool: "kamiwaza_tool_z_19607be6_search",
        arguments: { query: "openclaw" },
      }),
    ).rejects.toMatchObject({
      code: "delegation-unavailable",
      message: "Kamiwaza delegated identity is required but no agent id is available.",
    });
  });

  it("refreshes the direct catalog so newly added Kamiwaza tools become callable without restart", async () => {
    let nowMs = 1_000;
    let includeSummarize = false;
    let extensionsFetches = 0;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(requestUrl(input));
      expect(getHeader(init, "authorization")).toBe("Bearer kamiwaza-token");

      if (url.pathname === "/api/extensions") {
        extensionsFetches += 1;
        return jsonResponse([
          {
            name: "tool-z-19607be6",
            type: "tool",
            phase: "Running",
            services: [{ ready: true, available_replicas: 1 }],
            endpoints: { external: "http://kamiwaza.local/runtime/tools/tool-z-19607be6" },
          },
        ]);
      }

      if (url.pathname !== EXTENSION_PATH) {
        return jsonResponse({ error: "unexpected path" }, { status: 404 });
      }

      const payload = JSON.parse(requestBody(init)) as {
        method?: string;
        params?: { name?: string };
      };
      switch (payload.method) {
        case "initialize":
          return mcpResponse(
            {
              jsonrpc: "2.0",
              id: 1,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: { tools: { listChanged: true } },
                serverInfo: { name: "tool-z", version: "1.0.0" },
              },
            },
            "test-session",
          );
        case "notifications/initialized":
          return jsonResponse({}, { status: 202, headers: { "mcp-session-id": "test-session" } });
        case "tools/list":
          return mcpResponse(
            {
              jsonrpc: "2.0",
              id: 2,
              result: {
                tools: [
                  {
                    name: "search",
                    description: "Search through Kamiwaza.",
                    inputSchema: { type: "object" },
                  },
                  ...(includeSummarize
                    ? [
                        {
                          name: "summarize",
                          description: "Summarize through Kamiwaza.",
                          inputSchema: { type: "object" },
                        },
                      ]
                    : []),
                ],
              },
            },
            "test-session",
          );
        case "tools/call":
          return mcpResponse(
            {
              jsonrpc: "2.0",
              id: 3,
              result: {
                content: [{ type: "text", text: `${payload.params?.name ?? "unknown"} ok` }],
              },
            },
            "test-session",
          );
        default:
          return jsonResponse({ error: "unexpected MCP method" }, { status: 400 });
      }
    });

    const config = cfg({
      apiUrl: "http://kamiwaza.local/api",
      apiToken: "kamiwaza-token",
      catalogTtlSeconds: 1,
    });

    await expect(discoverKamiwazaTools(config)).resolves.toEqual([
      expect.objectContaining({ name: "kamiwaza_tool_z_19607be6_search" }),
    ]);

    includeSummarize = true;
    nowMs += 1_001;

    await expect(
      callKamiwazaTool({
        cfg: config,
        tool: "kamiwaza_tool_z_19607be6_summarize",
        arguments: { text: "new tool" },
      }),
    ).resolves.toEqual({
      tool: "kamiwaza_tool_z_19607be6_summarize",
      result: { content: [{ type: "text", text: "summarize ok" }] },
    });
    expect(extensionsFetches).toBe(2);
  });

  it("prompts for PAT setup in dynamic guidance when credentials are missing", async () => {
    const guidance = await buildKamiwazaDynamicCatalogGuidance(
      cfg({ apiUrl: "http://kamiwaza.local/api" }),
    );

    expect(guidance).toContain("no PAT is available");
    expect(guidance).toContain("plugins.entries.kamiwaza.config.apiToken");
  });

  it("scopes discovery to extensions matching extensionNames and skips the rest", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-kamiwaza-scope-"));
    const storePath = path.join(dir, "kamiwaza-pat-store.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        credentials: [{ host_name: "kamiwaza.local", token: "kamiwaza-token" }],
      }),
    );

    const probedMcpPaths: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(requestUrl(input));
      if (url.pathname === "/api/extensions") {
        return jsonResponse([
          {
            name: "tool-serperdev-agentzero",
            type: "tool",
            phase: "Running",
            services: [{ ready: true, available_replicas: 1 }],
            endpoints: { external: "http://kamiwaza.local/runtime/tools/tool-serperdev-agentzero" },
          },
          {
            name: "tool-serperdev-kz1",
            type: "tool",
            phase: "Running",
            services: [{ ready: true, available_replicas: 1 }],
            endpoints: { external: "http://kamiwaza.local/runtime/tools/tool-serperdev-kz1" },
          },
        ]);
      }
      probedMcpPaths.push(url.pathname);
      const payload = JSON.parse(requestBody(init)) as { method?: string };
      if (payload.method === "initialize") {
        return mcpResponse(
          { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } },
          "test-session",
        );
      }
      if (payload.method === "notifications/initialized") {
        return jsonResponse({}, { status: 202, headers: { "mcp-session-id": "test-session" } });
      }
      if (payload.method === "tools/list") {
        return mcpResponse(
          { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search", description: "s" }] } },
          "test-session",
        );
      }
      return jsonResponse({}, { status: 202, headers: { "mcp-session-id": "test-session" } });
    });

    const tools = await discoverKamiwazaTools(
      cfg({
        apiUrl: "http://kamiwaza.local/api",
        credentialStorePath: storePath,
        extensionNames: ["*-agentzero"],
      }),
    );

    expect(tools.map((tool) => tool.extensionName)).toEqual(["tool-serperdev-agentzero"]);
    expect(probedMcpPaths.every((probed) => probed.includes("agentzero"))).toBe(true);
    expect(probedMcpPaths.some((probed) => probed.includes("kz1"))).toBe(false);
  });

  describe("kamiwazaExtensionNameMatches", () => {
    it("returns true for everything when no patterns are configured", () => {
      expect(kamiwazaExtensionNameMatches("tool-serperdev-kz1", [])).toBe(true);
    });

    it("matches a trailing suffix wildcard and rejects other runtimes", () => {
      const patterns = ["*-agentzero"];
      expect(kamiwazaExtensionNameMatches("tool-serperdev-agentzero", patterns)).toBe(true);
      expect(kamiwazaExtensionNameMatches("tool-untrusted-content-agentzero", patterns)).toBe(true);
      expect(kamiwazaExtensionNameMatches("tool-serperdev-kz1", patterns)).toBe(false);
      expect(kamiwazaExtensionNameMatches("tool-serperdev-agentzero-2", patterns)).toBe(false);
    });

    it("supports exact names, leading and interior wildcards", () => {
      expect(kamiwazaExtensionNameMatches("tool-serperdev-kz1", ["tool-serperdev-kz1"])).toBe(true);
      expect(kamiwazaExtensionNameMatches("tool-serperdev-kz1", ["tool-serperdev-*"])).toBe(true);
      expect(kamiwazaExtensionNameMatches("tool-serperdev-kz1", ["tool-*-kz1"])).toBe(true);
      expect(kamiwazaExtensionNameMatches("tool-telegram-kz1", ["tool-serperdev-*"])).toBe(false);
    });
  });
});
