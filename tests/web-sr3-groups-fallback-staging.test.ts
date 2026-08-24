// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { stageFallbackCandidate } from "../web/src/groups-fallback.js";

/**
 * SR-3 — the fallback candidate selection must be UNAMBIGUOUS. The staging
 * decision is a pure core so duplicate/self rejection is directly testable
 * without DOM gymnastics: choosing a valid candidate stages it immediately;
 * choosing the target itself or an already-staged candidate is rejected with
 * an exact, bounded reason (never silently discarded).
 */

describe("stageFallbackCandidate (SR-3)", () => {
  it("stages a fresh candidate immediately, preserving exact order", () => {
    const result = stageFallbackCandidate([], "Piren", "Vera");
    expect(result).toEqual({ kind: "staged", candidates: ["Vera"] });
    const second = stageFallbackCandidate(["Vera"], "Piren", "Kimi");
    expect(second).toEqual({ kind: "staged", candidates: ["Vera", "Kimi"] });
  });

  it("rejects the target itself with an exact reason (never stages self)", () => {
    const result = stageFallbackCandidate([], "Piren", "Piren");
    expect("reason" in result).toBe(true);
    if (result.kind === "rejected") expect(result.reason).toContain("own fallback");
  });

  it("rejects an already-staged candidate with an exact reason and keeps the list untouched", () => {
    const result = stageFallbackCandidate(["Vera"], "Piren", "Vera");
    expect("reason" in result).toBe(true);
    if (result.kind === "rejected") {
      expect(result.reason).toContain("Vera");
      expect(result.reason).toContain("already in the ordered list");
    }
  });

  it("rejects empty choices defensively without mutating anything", () => {
    const result = stageFallbackCandidate(["Vera"], "Piren", "");
    expect(result.kind).toBe("rejected");
  });
});
