import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  assertRequiredLocksmithReady,
  resolveRequiredLocksmithStartupConfig,
} from "./locksmith-requirement.js";

function requiredConfig(overrides: Record<string, unknown> = {}): OpenClawConfig {
  return {
    plugins: {
      entries: {
        locksmith: {
          enabled: true,
          config: {
            required: true,
            genericTool: false,
            baseUrl: "http://127.0.0.1:9200",
            inboundToken: "secret-token",
            tools: {
              github: { enabled: true },
            },
            ...overrides,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("required Locksmith startup config", () => {
  it("is disabled when neither config nor env requires it", () => {
    expect(resolveRequiredLocksmithStartupConfig({} as OpenClawConfig, {})).toBeNull();
  });

  it("requires the plugin to be enabled", () => {
    const cfg = requiredConfig();
    cfg.plugins!.entries!.locksmith!.enabled = false;

    expect(() => resolveRequiredLocksmithStartupConfig(cfg, {})).toThrow(
      "locksmith plugin is not enabled",
    );
  });

  it("requires projected tools and hides the generic tool", () => {
    expect(() =>
      resolveRequiredLocksmithStartupConfig(requiredConfig({ genericTool: true }), {}),
    ).toThrow("genericTool is not false");

    expect(() => resolveRequiredLocksmithStartupConfig(requiredConfig({ tools: {} }), {})).toThrow(
      "no projected Locksmith tools",
    );
  });

  it("requires loopback baseUrl and inbound token", () => {
    expect(() =>
      resolveRequiredLocksmithStartupConfig(requiredConfig({ baseUrl: "https://example.com" }), {}),
    ).toThrow("requires a loopback baseUrl");

    expect(() =>
      resolveRequiredLocksmithStartupConfig(requiredConfig({ inboundToken: "" }), {}),
    ).toThrow("no inboundToken");
  });
});

describe("required Locksmith startup check", () => {
  it("passes only when health works, unauthenticated tools are blocked, and projected tools are active", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }))
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ tools: [{ name: "github" }] }));

    await expect(
      assertRequiredLocksmithReady({
        cfg: requiredConfig(),
        fetchImpl,
      }),
    ).resolves.toEqual({
      baseUrl: "http://127.0.0.1:9200",
      activeTools: ["github"],
    });

    const authenticatedCall = fetchImpl.mock.calls[2];
    expect(authenticatedCall?.[1]?.headers).toEqual({
      Authorization: "Bearer secret-token",
    });
  });

  it("fails when Locksmith accepts unauthenticated tool discovery", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }))
      .mockResolvedValueOnce(jsonResponse({ tools: [{ name: "github" }] }));

    await expect(
      assertRequiredLocksmithReady({
        cfg: requiredConfig(),
        fetchImpl,
      }),
    ).rejects.toThrow("unauthenticated /tools succeeded");
  });

  it("fails when a projected tool is missing from the active catalog", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }))
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 403))
      .mockResolvedValueOnce(jsonResponse({ tools: [{ name: "tavily" }] }));

    await expect(
      assertRequiredLocksmithReady({
        cfg: requiredConfig(),
        fetchImpl,
      }),
    ).rejects.toThrow("projected tool(s) not active");
  });
});
