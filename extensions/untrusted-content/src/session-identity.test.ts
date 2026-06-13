import { describe, expect, it } from "vitest";
import { resolveBlockSessionId } from "./session-identity.js";

describe("resolveBlockSessionId", () => {
  it("prefers sessionId when present", () => {
    expect(resolveBlockSessionId({ sessionId: "sid", sessionKey: "skey", agentId: "agent" })).toBe(
      "sid",
    );
  });

  it("falls back to sessionKey when sessionId is missing", () => {
    expect(resolveBlockSessionId({ sessionKey: "skey", agentId: "agent" })).toBe("skey");
  });

  it("falls back to agentId when sessionId and sessionKey are missing", () => {
    expect(resolveBlockSessionId({ agentId: "agent" })).toBe("agent");
  });

  it("trims and skips empty/whitespace candidates", () => {
    expect(resolveBlockSessionId({ sessionId: "   ", sessionKey: "  skey  " })).toBe("skey");
    expect(resolveBlockSessionId({ sessionId: "", agentId: "agent" })).toBe("agent");
  });

  it("returns undefined when nothing resolves", () => {
    expect(resolveBlockSessionId(undefined)).toBeUndefined();
    expect(resolveBlockSessionId({})).toBeUndefined();
    expect(
      resolveBlockSessionId({ sessionId: "  ", sessionKey: "", agentId: "   " }),
    ).toBeUndefined();
  });
});
