import { describe, expect, it } from "vitest";
import { CONVERSATIONAL_CLEAR_RE } from "./clear-pattern.js";

describe("CONVERSATIONAL_CLEAR_RE", () => {
  it("captures a valid 6-char code with surrounding whitespace and any case", () => {
    expect(CONVERSATIONAL_CLEAR_RE.exec("clear FQ35PZ")?.[1]).toBe("FQ35PZ");
    expect(CONVERSATIONAL_CLEAR_RE.exec("  clear fq35pz  ")?.[1]).toBe("fq35pz");
    expect(CONVERSATIONAL_CLEAR_RE.exec("CLEAR ABC234")?.[1]).toBe("ABC234");
  });

  it("rejects codes containing characters outside the [A-HJ-NP-Z2-9] class", () => {
    // 0, 1, I, and O are outside the accepted class, so the message is ignored.
    expect(CONVERSATIONAL_CLEAR_RE.exec("clear ABC01X")).toBeNull();
    expect(CONVERSATIONAL_CLEAR_RE.exec("clear ABCIIX")).toBeNull();
    expect(CONVERSATIONAL_CLEAR_RE.exec("clear ABCOOX")).toBeNull();
  });

  it("rejects wrong-length codes and extra words", () => {
    expect(CONVERSATIONAL_CLEAR_RE.exec("clear ABC23")).toBeNull();
    expect(CONVERSATIONAL_CLEAR_RE.exec("clear ABC2345")).toBeNull();
    expect(CONVERSATIONAL_CLEAR_RE.exec("clear ABC234 now")).toBeNull();
    expect(CONVERSATIONAL_CLEAR_RE.exec("please clear ABC234")).toBeNull();
  });

  it("rejects unrelated messages", () => {
    expect(CONVERSATIONAL_CLEAR_RE.exec("clearance check")).toBeNull();
    expect(CONVERSATIONAL_CLEAR_RE.exec("what blocks are active?")).toBeNull();
    expect(CONVERSATIONAL_CLEAR_RE.exec("")).toBeNull();
  });
});
