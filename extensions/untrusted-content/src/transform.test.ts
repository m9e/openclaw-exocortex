import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maybeTransformToolResult } from "./transform.js";

vi.mock("openclaw/plugin-sdk/security-runtime", () => ({
  wrapExternalContent: (content: string, opts?: { source?: string; includeWarning?: boolean }) =>
    `[wrapped:${opts?.source ?? "unknown"}:${opts?.includeWarning === true ? "warn" : "plain"}]${content}`,
  wrapWebContent: (content: string, source?: string) =>
    `[wrapped:${source ?? "web_fetch"}]${content}`,
}));

function buildConfig(params: {
  baseUrl: string;
  apiKey?: unknown;
  toolNames?: string[];
  onError?: "pass" | "quarantine";
}): OpenClawConfig {
  return {
    plugins: {
      entries: {
        "untrusted-content": {
          enabled: true,
          config: {
            baseUrl: params.baseUrl,
            ...(params.apiKey ? { apiKey: params.apiKey } : {}),
            toolNames: params.toolNames ?? ["web_fetch", "browser"],
            ...(params.onError ? { onError: params.onError } : {}),
          },
        },
      },
    },
  } as OpenClawConfig;
}

function buildPipelineResponse(params: {
  id: string;
  clean: boolean;
  quarantined: boolean;
  content: string | null;
  threats?: Array<{
    stage: string;
    severity: "info" | "warn" | "critical";
    message: string;
    confidence?: number;
  }>;
}) {
  return {
    id: params.id,
    clean: params.clean,
    quarantined: params.quarantined,
    content: params.content,
    threats: params.threats ?? [],
    metadata: {
      original_length: 123,
      sanitized_length: params.content?.length ?? 0,
      truncated: false,
      sanitizer_actions: [],
      windows_scanned: 1,
      scan_time_ms: 4,
      pipeline_version: "test",
      trust_level: "untrusted",
      storage: {
        raw: "/tmp/raw.json",
        clean: params.clean ? "/tmp/clean.json" : null,
        incident: params.quarantined ? "/tmp/incident.json" : null,
      },
    },
  };
}

describe("untrusted-content tool result transform", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sanitizes configured web_fetch text results and rewraps the content", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify(
          buildPipelineResponse({
            id: "scan-clean-1",
            clean: true,
            quarantined: false,
            content: "sanitized body",
          }),
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const result = (await maybeTransformToolResult({
      cfg: buildConfig({ baseUrl: "http://127.0.0.1:8787" }),
      toolName: "web_fetch",
      params: { url: "https://example.com" },
      toolCallId: "call-clean-1",
      result: {
        text: "unsafe body",
        finalUrl: "https://example.com",
      },
    })) as Record<string, unknown>;

    expect(result).toMatchObject({
      text: "[wrapped:web_fetch]sanitized body",
    });
    expect(result.untrustedContentGuard).toMatchObject({
      guard: "untrusted-content",
      toolName: "web_fetch",
      clean: true,
      quarantined: false,
      contentId: "scan-clean-1",
      threatCount: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8787/v1/pipelines/default/run");
    const cleanHeaders = fetchMock.mock.calls[0]?.[1]?.headers as
      | Record<string, string>
      | undefined;
    expect(cleanHeaders?.authorization).toBeUndefined();
    const requestBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(typeof requestBody).toBe("string");
    expect(JSON.parse(requestBody as string)).toMatchObject({
      input: {
        content: "unsafe body",
        source: "web_fetch",
        url: "https://example.com",
        content_id: "call-clean-1",
      },
    });
  });

  it("sends a bearer token when the untrusted-content endpoint is authenticated", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify(
          buildPipelineResponse({
            id: "scan-auth-1",
            clean: true,
            quarantined: false,
            content: "authenticated sanitized body",
          }),
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    await maybeTransformToolResult({
      cfg: buildConfig({
        baseUrl: "https://yod.local/runtime/tools/tool-untrusted",
        apiKey: "pat-value",
      }),
      toolName: "web_fetch",
      params: { url: "https://example.com" },
      toolCallId: "call-auth-1",
      result: {
        text: "unsafe body",
        finalUrl: "https://example.com",
      },
    });

    const bearerHeaders = fetchMock.mock.calls[0]?.[1]?.headers as
      | Record<string, string>
      | undefined;
    expect(bearerHeaders?.authorization).toBe("Bearer pat-value");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://yod.local/runtime/tools/tool-untrusted/v1/pipelines/default/run",
    );
  });

  it("resolves an allowlisted env SecretRef for authenticated Kamiwaza endpoints", async () => {
    vi.stubEnv("KAMIWAZA_API_KEY", "kamiwaza-env-key");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify(
          buildPipelineResponse({
            id: "scan-env-auth-1",
            clean: true,
            quarantined: false,
            content: "env authenticated sanitized body",
          }),
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    await maybeTransformToolResult({
      cfg: {
        secrets: {
          providers: {
            default: {
              source: "env",
              allowlist: ["KAMIWAZA_API_KEY"],
            },
          },
        },
        ...buildConfig({
          baseUrl: "https://yod.local/runtime/tools/tool-untrusted",
          apiKey: { source: "env", provider: "default", id: "KAMIWAZA_API_KEY" },
        }),
      } as OpenClawConfig,
      toolName: "web_fetch",
      params: { url: "https://example.com" },
      toolCallId: "call-env-auth-1",
      result: {
        text: "unsafe body",
        finalUrl: "https://example.com",
      },
    });

    const envKeyHeaders = fetchMock.mock.calls[0]?.[1]?.headers as
      | Record<string, string>
      | undefined;
    expect(envKeyHeaders?.authorization).toBe("Bearer kamiwaza-env-key");
  });

  it("does not resolve env SecretRefs excluded by the provider allowlist", async () => {
    vi.stubEnv("KAMIWAZA_API_KEY", "blocked-env-key");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify(
          buildPipelineResponse({
            id: "scan-blocked-auth-1",
            clean: true,
            quarantined: false,
            content: "blocked auth sanitized body",
          }),
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    await maybeTransformToolResult({
      cfg: {
        secrets: {
          providers: {
            default: {
              source: "env",
              allowlist: ["OTHER_KAMIWAZA_API_KEY"],
            },
          },
        },
        ...buildConfig({
          baseUrl: "https://yod.local/runtime/tools/tool-untrusted",
          apiKey: { source: "env", provider: "default", id: "KAMIWAZA_API_KEY" },
        }),
      } as OpenClawConfig,
      toolName: "web_fetch",
      params: { url: "https://example.com" },
      toolCallId: "call-blocked-auth-1",
      result: {
        text: "unsafe body",
        finalUrl: "https://example.com",
      },
    });

    const excludedHeaders = fetchMock.mock.calls[0]?.[1]?.headers as
      | Record<string, string>
      | undefined;
    expect(excludedHeaders?.authorization).toBeUndefined();
  });

  it("quarantines browser content blocks and drops the original block list", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify(
          buildPipelineResponse({
            id: "scan-quarantine-1",
            clean: false,
            quarantined: true,
            content: null,
            threats: [
              {
                stage: "scanner",
                severity: "critical",
                message: "prompt injection pattern",
                confidence: 0.98,
              },
            ],
          }),
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const result = (await maybeTransformToolResult({
      cfg: buildConfig({ baseUrl: "http://127.0.0.1:8788" }),
      toolName: "browser",
      params: { url: "https://example.com" },
      toolCallId: "call-quarantine-1",
      result: {
        content: [
          { type: "text", text: "malicious page body" },
          { type: "image", imageUrl: "https://example.com/image.png" },
        ],
        details: {
          url: "https://example.com",
        },
      },
    })) as Record<string, unknown>;

    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("output was quarantined before agent ingest"),
      },
    ]);
    expect(result.untrustedContentGuard).toMatchObject({
      guard: "untrusted-content",
      toolName: "browser",
      quarantined: true,
    });
    expect((result.details as Record<string, unknown>).untrustedContentGuard).toMatchObject({
      guard: "untrusted-content",
      toolName: "browser",
      quarantined: true,
    });
  });

  it("passes the original result through when the guard service fails and onError=pass", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connect ECONNREFUSED"));
    const originalResult = {
      text: "leave me alone",
      finalUrl: "https://example.com",
    };

    const result = await maybeTransformToolResult({
      cfg: buildConfig({ baseUrl: "http://127.0.0.1:8789", onError: "pass" }),
      toolName: "web_fetch",
      params: { url: "https://example.com" },
      toolCallId: "call-pass-1",
      result: originalResult,
    });

    expect(result).toBe(originalResult);
  });

  it("replaces the tool result with a quarantine summary when onError=quarantine", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("service offline"));

    const result = (await maybeTransformToolResult({
      cfg: buildConfig({ baseUrl: "http://127.0.0.1:8790", onError: "quarantine" }),
      toolName: "web_fetch",
      params: { url: "https://example.com" },
      toolCallId: "call-fallback-1",
      result: {
        text: "unsafe page",
        details: {
          url: "https://example.com",
        },
      },
    })) as Record<string, unknown>;

    expect(result.text).toContain("output was quarantined before agent ingest");
    expect(result.text).toContain("Reason: service offline");
    expect(result.untrustedContentGuard).toMatchObject({
      guard: "untrusted-content",
      toolName: "web_fetch",
      quarantined: true,
      error: "service offline",
    });
    expect((result.details as Record<string, unknown>).untrustedContentGuard).toMatchObject({
      guard: "untrusted-content",
      toolName: "web_fetch",
      quarantined: true,
      error: "service offline",
    });
  });

  it("guards dynamically projected tools matched by a prefix wildcard", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify(
          buildPipelineResponse({
            id: "scan-prefix-1",
            clean: true,
            quarantined: false,
            content: "sanitized search results",
          }),
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const result = (await maybeTransformToolResult({
      cfg: buildConfig({
        baseUrl: "http://127.0.0.1:8787",
        toolNames: ["kamiwaza_*", "locksmith_kamiwaza_*"],
      }),
      toolName: "kamiwaza_tool_z_19607be6_search",
      params: { query: "openclaw" },
      toolCallId: "call-prefix-1",
      result: { text: "raw search results" },
    })) as Record<string, unknown>;

    expect(result.text).toContain("sanitized search results");
    expect(result.untrustedContentGuard).toMatchObject({
      guard: "untrusted-content",
      toolName: "kamiwaza_tool_z_19607be6_search",
      clean: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not guard tools outside the configured prefixes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const originalResult = { text: "internal status" };

    const result = await maybeTransformToolResult({
      cfg: buildConfig({
        baseUrl: "http://127.0.0.1:8787",
        toolNames: ["kamiwaza_*"],
      }),
      toolName: "session_status",
      params: {},
      toolCallId: "call-prefix-2",
      result: originalResult,
    });

    expect(result).toBe(originalResult);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
