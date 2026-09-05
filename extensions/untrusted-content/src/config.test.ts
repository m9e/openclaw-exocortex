import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_UNTRUSTED_CONTENT_ON_ERROR,
  shouldGuardToolResult,
  resolveUntrustedContentOnErrorMode,
} from "./config.js";

function buildConfig(onError?: "pass" | "quarantine"): OpenClawConfig {
  return {
    plugins: {
      entries: {
        "untrusted-content": {
          enabled: true,
          config: onError ? { onError } : {},
        },
      },
    },
  } as OpenClawConfig;
}

describe("resolveUntrustedContentOnErrorMode", () => {
  it("fails closed (quarantine) by code default", () => {
    expect(DEFAULT_UNTRUSTED_CONTENT_ON_ERROR).toBe("quarantine");
  });

  it("defaults to quarantine when onError is unset", () => {
    expect(resolveUntrustedContentOnErrorMode(buildConfig())).toBe("quarantine");
    expect(resolveUntrustedContentOnErrorMode(undefined)).toBe("quarantine");
  });

  it("honors an explicit pass opt-out", () => {
    expect(resolveUntrustedContentOnErrorMode(buildConfig("pass"))).toBe("pass");
  });

  it("honors an explicit quarantine setting", () => {
    expect(resolveUntrustedContentOnErrorMode(buildConfig("quarantine"))).toBe("quarantine");
  });
});

describe("shouldGuardToolResult", () => {
  it("does not bypass any guarded tool by default", () => {
    const cfg = {
      plugins: {
        entries: {
          "untrusted-content": {
            enabled: true,
            config: {
              toolNames: ["remote_*"],
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(shouldGuardToolResult(cfg, "remote_read_message")).toBe(true);
    expect(shouldGuardToolResult(cfg, "remote_model_proxy")).toBe(true);
  });

  it("bypasses an explicitly excluded tool name", () => {
    const cfg = {
      plugins: {
        entries: {
          "untrusted-content": {
            enabled: true,
            config: {
              toolNames: ["remote_*"],
              excludedToolNames: ["remote_model_proxy"],
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(shouldGuardToolResult(cfg, "remote_read_message")).toBe(true);
    expect(shouldGuardToolResult(cfg, "remote_model_proxy")).toBe(false);
  });

  it("requires a trailing wildcard to bypass a tool-name prefix", () => {
    const cfg = {
      plugins: {
        entries: {
          "untrusted-content": {
            enabled: true,
            config: {
              toolNames: ["remote_*"],
              excludedToolNames: ["remote_read_*"],
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(shouldGuardToolResult(cfg, "remote_read_message")).toBe(false);
    expect(shouldGuardToolResult(cfg, "remote_write_message")).toBe(true);
  });
});
