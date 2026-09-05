import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchQuarantineRaw, runUntrustedContentPipeline } from "./client.js";

const { fetchGuarded } = vi.hoisted(() => ({ fetchGuarded: vi.fn() }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: fetchGuarded }));

let endpointId = 0;
function config(): OpenClawConfig {
  return {
    plugins: {
      entries: {
        "untrusted-content": {
          config: { baseUrl: `http://127.0.0.1:8787/test-${++endpointId}` },
        },
      },
    },
  };
}

function respond(body: unknown) {
  fetchGuarded.mockResolvedValue({
    response: new Response(JSON.stringify(body), { status: 200 }),
    release: vi.fn(),
  });
}

const validPipeline = {
  id: "scan-1",
  clean: true,
  quarantined: false,
  content: "sanitized text",
  threats: [],
  metadata: { storage: { raw: "/var/lib/untrusted-content/raw/scan-1.json", clean: null } },
};

beforeEach(() => vi.clearAllMocks());

describe("guard service response validation", () => {
  it("accepts the pipeline wire contract", async () => {
    respond(validPipeline);
    await expect(
      runUntrustedContentPipeline({ cfg: config(), content: "input", source: "api" }),
    ).resolves.toEqual(validPipeline);
  });

  it.each([
    null,
    { ...validPipeline, clean: "true" },
    { ...validPipeline, content: { text: "unchecked" } },
    { ...validPipeline, threats: [{ confidence: "0.99" }] },
    { ...validPipeline, threats: [{ severity: "unrecognized" }] },
    { ...validPipeline, metadata: { storage: { raw: {} } } },
  ])("rejects malformed success responses before result transformation: %j", async (body) => {
    respond(body);
    await expect(
      runUntrustedContentPipeline({ cfg: config(), content: "input", source: "api" }),
    ).rejects.toThrow("pipeline response has an invalid shape");
  });

  it("rejects malformed raw retrieval instead of presenting it to the operator", async () => {
    respond({ id: "scan-1", raw_content: { text: "not a string" } });
    await expect(fetchQuarantineRaw(config(), "scan-1")).resolves.toMatchObject({
      ok: false,
      error: "quarantine response has an invalid shape",
    });
  });
});
