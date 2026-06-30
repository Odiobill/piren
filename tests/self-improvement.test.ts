import { describe, expect, it } from "vitest";
import {
  detectCorrectionTrigger,
  formatCorrectionArtifactNudge,
  suggestCorrectionArtifacts,
} from "../src/self-improvement.js";

describe("ADR-0024 correction trigger detection", () => {
  it("detects strong correction patterns and extracts the directive", () => {
    const result = detectCorrectionTrigger("Please don't use hidden memory stores for Piren.");

    expect(result.triggered).toBe(true);
    expect(result.confidence).toBe("strong");
    expect(result.directive).toBe("use hidden memory stores for Piren.");
  });

  it("detects weak corrections only when followed by a directive word", () => {
    expect(detectCorrectionTrigger("Actually, use project_append_log for that convention.").triggered).toBe(true);
    expect(detectCorrectionTrigger("Actually, looks great.").triggered).toBe(false);
    expect(detectCorrectionTrigger("No worries, this is fine.").triggered).toBe(false);
  });

  it("supports configured pattern overrides without requiring production globals", () => {
    const result = detectCorrectionTrigger("Careful: always write docs first.", {
      strongPatterns: ["^careful:"],
      weakPatterns: [],
      negativePatterns: [],
    });

    expect(result.triggered).toBe(true);
    expect(result.matchedPattern).toBe("^careful:");
  });
});

describe("ADR-0024 visible artifact suggestions", () => {
  it("retargets a project convention correction at existing visible vault tools", () => {
    const suggestions = suggestCorrectionArtifacts("Actually, use project_append_log for project conventions.");

    expect(suggestions.map((entry) => entry.tool)).toEqual([
      "project_append_log",
      "skill_candidate_write",
      "decision_record",
      "wiki_update_concept",
    ]);
  });

  it("formats a nudge that forbids hidden memory mutation and names existing tools", () => {
    const result = detectCorrectionTrigger("No, use wiki_update_concept for tool quirks.");
    const nudge = formatCorrectionArtifactNudge(result);

    expect(nudge).toContain("Correction detected");
    expect(nudge).toContain("No hidden memory store");
    expect(nudge).toContain("wiki_update_concept");
    expect(nudge).toContain("skill_candidate_write");
  });
});
