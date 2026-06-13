import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_UNTRUSTED_CONTENT_ON_ERROR,
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
