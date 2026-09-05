// Covers plugin middleware that can transform agent tool results.
import { afterEach, describe, expect, it } from "vitest";
import {
  agentToolResultMiddlewareRegistrationCoversTool,
  appendAgentToolResultMiddlewareScope,
  hasAgentToolResultReplacementRequirement,
  requiresAgentToolResultReplacement,
  normalizeAgentToolResultMiddlewareRuntimeIds,
  normalizeAgentToolResultMiddlewareRuntimes,
} from "./agent-tool-result-middleware.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginAgentToolResultMiddlewareRegistration } from "./registry-types.js";
import { setActivePluginRegistry } from "./runtime.js";

afterEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));

describe("required middleware delivery", () => {
  it("queries only active scopes and preserves matcher, runtime, and predicate exclusions", () => {
    const registry = createEmptyPluginRegistry();
    const handler = () => undefined;
    const registration: PluginAgentToolResultMiddlewareRegistration = {
      pluginId: "guard",
      handler,
      rawHandler: handler,
      source: "test",
      runtimes: ["codex"],
      scopes: [
        {
          runtimes: ["codex"],
          matcher: ["web_fetch", "web_search"],
          requiresResultReplacement: (name) => name !== "web_search",
        },
      ],
    };
    registry.agentToolResultMiddlewares.push(registration);
    setActivePluginRegistry(registry);
    expect(hasAgentToolResultReplacementRequirement("codex")).toBe(true);
    expect(requiresAgentToolResultReplacement("codex", "web_fetch")).toBe(true);
    expect(requiresAgentToolResultReplacement("codex", "web_search")).toBe(false);
    expect(requiresAgentToolResultReplacement("codex", "exec")).toBe(false);
    expect(requiresAgentToolResultReplacement("openclaw", "web_fetch")).toBe(false);
    appendAgentToolResultMiddlewareScope(registration, {
      runtimes: ["openclaw"],
      requiresResultReplacement: () => true,
    });
    expect(requiresAgentToolResultReplacement("openclaw", "exec")).toBe(true);
    expect(requiresAgentToolResultReplacement("codex", "exec")).toBe(false);
    setActivePluginRegistry(createEmptyPluginRegistry());
    expect(requiresAgentToolResultReplacement("codex", "web_fetch")).toBe(false);
  });

  it("fails closed on a broken requirement without requiring ordinary reducing middleware", () => {
    const registry = createEmptyPluginRegistry();
    const handler = () => undefined;
    registry.agentToolResultMiddlewares.push({
      pluginId: "reducer",
      handler,
      rawHandler: handler,
      source: "test",
      runtimes: ["codex"],
    });
    setActivePluginRegistry(registry);
    expect(hasAgentToolResultReplacementRequirement("codex")).toBe(false);
    expect(requiresAgentToolResultReplacement("codex", "exec")).toBe(false);
    registry.agentToolResultMiddlewares.push({
      pluginId: "guard",
      handler,
      rawHandler: handler,
      source: "test",
      runtimes: ["codex"],
      scopes: [
        {
          runtimes: ["codex"],
          requiresResultReplacement: () => {
            throw new Error("invalid policy");
          },
        },
      ],
    });
    expect(requiresAgentToolResultReplacement("codex", "web_search")).toBe(true);
  });
});

describe("normalizeAgentToolResultMiddlewareRuntimes", () => {
  it("defaults omitted runtimes to every supported runtime", () => {
    expect(normalizeAgentToolResultMiddlewareRuntimes()).toEqual(["openclaw", "codex"]);
  });

  it("preserves an explicit empty runtime list", () => {
    expect(normalizeAgentToolResultMiddlewareRuntimes({ runtimes: [] })).toEqual([]);
  });

  it("ignores unknown runtime ids from manifest metadata", () => {
    expect(normalizeAgentToolResultMiddlewareRuntimeIds(["codex-app-server", "openclaw"])).toEqual([
      "openclaw",
    ]);
  });
});

describe("agent tool result middleware scopes", () => {
  it("keeps runtime and matcher registrations paired without cross-products", () => {
    const handler = () => undefined;
    const registration: PluginAgentToolResultMiddlewareRegistration = {
      pluginId: "policy",
      rawHandler: handler,
      handler,
      runtimes: ["codex"],
      scopes: [{ runtimes: ["codex"], matcher: ["exec"] }],
      source: "test",
    };
    appendAgentToolResultMiddlewareScope(registration, {
      runtimes: ["openclaw"],
      matcher: ["apply_patch"],
    });

    expect(agentToolResultMiddlewareRegistrationCoversTool(registration, "codex", "exec")).toBe(
      true,
    );
    expect(agentToolResultMiddlewareRegistrationCoversTool(registration, "codex", "Bash")).toBe(
      false,
    );
    expect(
      agentToolResultMiddlewareRegistrationCoversTool(registration, "codex", "apply_patch"),
    ).toBe(false);
    expect(
      agentToolResultMiddlewareRegistrationCoversTool(registration, "openclaw", "apply_patch"),
    ).toBe(true);
    expect(agentToolResultMiddlewareRegistrationCoversTool(registration, "openclaw", "Write")).toBe(
      false,
    );
    expect(agentToolResultMiddlewareRegistrationCoversTool(registration, "openclaw", "exec")).toBe(
      false,
    );
  });
});
