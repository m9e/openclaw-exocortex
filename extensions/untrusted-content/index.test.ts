import { createAgentToolResultMiddlewareRunner } from "openclaw/plugin-sdk/agent-harness";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareOptions,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";

const { transform } = vi.hoisted(() => ({ transform: vi.fn() }));
vi.mock("./src/transform.js", () => ({ maybeTransformToolResult: transform }));
import plugin from "./index.js";

describe("untrusted-content result middleware", () => {
  afterEach(() => vi.resetAllMocks());

  it("requires replaceable delivery for guarded tool prefixes while retaining exclusions", () => {
    let options: AgentToolResultMiddlewareOptions | undefined;
    const api = createTestPluginApi({
      config: {
        plugins: {
          entries: {
            "untrusted-content": {
              enabled: true,
              config: {
                enabled: true,
                toolNames: ["web_fetch", "web_search", "browser", "locksmith_*"],
                excludedToolNames: ["locksmith_health"],
              },
            },
          },
        },
      },
      registerAgentToolResultMiddleware: (_handler, value) => {
        options = value;
      },
    });
    plugin.register(api);
    expect(options?.requiresResultReplacement?.("web_search")).toBe(true);
    expect(options?.requiresResultReplacement?.("locksmith_future_tool")).toBe(true);
    expect(options?.requiresResultReplacement?.("locksmith_health")).toBe(false);
    expect(options?.requiresResultReplacement?.("exec")).toBe(false);
  });

  it.each(["openclaw", "codex"] as const)(
    "replaces raw tool output before delivery through the %s runtime",
    async (runtime) => {
      const handlers: AgentToolResultMiddleware[] = [];
      const api = createTestPluginApi({
        config: {
          plugins: {
            entries: { "untrusted-content": { enabled: true, config: { enabled: true } } },
          },
        },
        registerAgentToolResultMiddleware: (handler) => {
          handlers.push(handler);
        },
      });
      plugin.register(api);
      const quarantined = {
        content: [{ type: "text", text: "Quarantined: original content omitted." }],
        details: { quarantined: true },
      };
      transform.mockResolvedValue(quarantined);
      const runner = createAgentToolResultMiddlewareRunner(
        { runtime, agentId: "main", sessionId: "guard-test", sessionKey: "agent:main:guard-test" },
        handlers,
      );
      const result = await runner.applyToolResultMiddleware({
        toolCallId: "fetch-1",
        toolName: "web_fetch",
        args: { url: "https://example.test" },
        result: { content: [{ type: "text", text: "UNTRUSTED_RAW_CANARY" }], details: {} },
      });
      expect(result).toEqual(quarantined);
      expect(JSON.stringify(result)).not.toContain("UNTRUSTED_RAW_CANARY");
      expect(transform).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { url: "https://example.test" },
          sessionId: "guard-test",
          sessionKey: "agent:main:guard-test",
          agentId: "main",
        }),
      );

      transform.mockRejectedValueOnce(new Error("guard processing failed"));
      const failedResult = await runner.applyToolResultMiddleware({
        toolCallId: "fetch-2",
        toolName: "web_fetch",
        args: {},
        result: { content: [{ type: "text", text: "UNTRUSTED_RAW_CANARY" }], details: {} },
      });
      expect(JSON.stringify(failedResult)).not.toContain("UNTRUSTED_RAW_CANARY");
      expect(failedResult.details).toMatchObject({ middlewareError: true });
    },
  );
});
