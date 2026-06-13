import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { HARDENED_SUMMARIZER_SYSTEM_PROMPT, summarizeUntrusted } from "./summarize.js";

type CompleteParams = {
  systemPrompt?: string;
  messages: { role: string; content: string }[];
  maxTokens?: number;
  temperature?: number;
  agentId?: string;
  purpose?: string;
  signal?: AbortSignal;
};

function createFakeApi(complete: (params: CompleteParams) => Promise<{ text: string }>): {
  api: OpenClawPluginApi;
  calls: CompleteParams[];
} {
  const calls: CompleteParams[] = [];
  const api = {
    runtime: {
      llm: {
        complete: async (params: CompleteParams) => {
          calls.push(params);
          return complete(params);
        },
      },
    },
  } as unknown as OpenClawPluginApi;
  return { api, calls };
}

describe("summarizeUntrusted", () => {
  it("returns the trimmed summary on success", async () => {
    const { api, calls } = createFakeApi(async () => ({ text: "  SUMMARY  " }));

    const result = await summarizeUntrusted(api, { content: "hello world", agentId: "agent-1" });

    expect(result).toEqual({ ok: true, summary: "SUMMARY" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.systemPrompt).toBe(HARDENED_SUMMARIZER_SYSTEM_PROMPT);
    expect(calls[0]?.agentId).toBe("agent-1");
    expect(calls[0]?.temperature).toBe(0);
    expect(calls[0]?.maxTokens).toBe(400);
  });

  it("wraps the untrusted content in <UNTRUSTED_TEXT> delimiters", async () => {
    const { api, calls } = createFakeApi(async () => ({ text: "ok" }));

    await summarizeUntrusted(api, { content: "DANGEROUS PAYLOAD" });

    const userMessage = calls[0]?.messages[0];
    expect(userMessage?.role).toBe("user");
    expect(userMessage?.content).toBe("<UNTRUSTED_TEXT>\nDANGEROUS PAYLOAD\n</UNTRUSTED_TEXT>");
  });

  it("honors an explicit maxTokens override", async () => {
    const { api, calls } = createFakeApi(async () => ({ text: "ok" }));
    await summarizeUntrusted(api, { content: "x", maxTokens: 100 });
    expect(calls[0]?.maxTokens).toBe(100);
  });

  it("returns ok:false on an empty summary", async () => {
    const { api } = createFakeApi(async () => ({ text: "   " }));
    const result = await summarizeUntrusted(api, { content: "x" });
    expect(result).toEqual({ ok: false, error: "empty summary" });
  });

  it("never throws: returns ok:false when the completion throws", async () => {
    const { api } = createFakeApi(async () => {
      throw new Error("provider down");
    });
    const result = await summarizeUntrusted(api, { content: "x" });
    expect(result).toEqual({ ok: false, error: "provider down" });
  });
});
