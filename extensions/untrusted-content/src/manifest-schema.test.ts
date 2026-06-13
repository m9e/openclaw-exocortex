import fs from "node:fs";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";

// Loads the same configSchema the plugin loader validates against, so a
// regression that drops a feature-config key (causing the plugin to fail to
// load when honeypot/channel-guard is configured) is caught here.
const manifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema: Record<string, unknown> };
const manifestConfigSchemaCacheKey = "untrusted-content.manifest.config-schema";

describe("untrusted-content manifest schema", () => {
  it("declares a risk property in configSchema.properties", () => {
    const properties = (manifest.configSchema as { properties?: Record<string, unknown> })
      .properties;
    expect(properties).toBeDefined();
    expect(properties?.risk).toBeDefined();
  });

  it("validates a representative risk.* config the feature reads", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: manifestConfigSchemaCacheKey,
      value: {
        enabled: true,
        baseUrl: "http://127.0.0.1:8787",
        risk: {
          honeypotTools: ["admin_exec"],
          guardChannels: true,
          quarantineAt: 8,
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("still rejects unknown top-level keys (additionalProperties: false)", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: manifestConfigSchemaCacheKey,
      value: { totallyUnknownKey: true },
    });

    expect(result.ok).toBe(false);
  });
});
