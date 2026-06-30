import { describe, expect, it } from "vitest";
import {
  buildAutoNudgeNotification,
  detectCorrectionTrigger,
  formatCorrectionArtifactNudge,
  resolveAutoNudgeConfig,
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

describe("ADR-0024 auto-nudge config resolution", () => {
  it("defaults to disabled when neither env nor config requests it", () => {
    const result = resolveAutoNudgeConfig({ env: {} });
    expect(result.enabled).toBe(false);
    expect(result.source).toBe("default");
  });

  it("enables when config sets self_improvement.auto_nudge true", () => {
    const result = resolveAutoNudgeConfig({
      env: {},
      config: { self_improvement: { auto_nudge: true } },
    });
    expect(result.enabled).toBe(true);
    expect(result.source).toBe("config");
  });

  it("env PIREN_AUTO_NUDGE=1 overrides config", () => {
    const enabled = resolveAutoNudgeConfig({
      env: { PIREN_AUTO_NUDGE: "1" },
      config: { self_improvement: { auto_nudge: false } },
    });
    expect(enabled.enabled).toBe(true);
    expect(enabled.source).toBe("env");

    const disabled = resolveAutoNudgeConfig({
      env: { PIREN_AUTO_NUDGE: "0" },
      config: { self_improvement: { auto_nudge: true } },
    });
    expect(disabled.enabled).toBe(false);
    expect(disabled.source).toBe("env");
  });

  it("ignores malformed config without throwing", () => {
    const result = resolveAutoNudgeConfig({
      env: {},
      config: { self_improvement: "yes please" as unknown as Record<string, unknown> },
    });
    expect(result.enabled).toBe(false);
    expect(result.source).toBe("default");
  });
});

describe("ADR-0024 auto-nudge notification builder", () => {
  it("returns null when no correction trigger is detected", () => {
    expect(buildAutoNudgeNotification("Looks great, ship it.")).toBeNull();
    expect(buildAutoNudgeNotification("")).toBeNull();
    expect(buildAutoNudgeNotification("   ")).toBeNull();
  });

  it("returns an inspectable notification when a strong correction is detected", () => {
    const notification = buildAutoNudgeNotification("Please don't use a hidden memory store.");
    expect(notification).not.toBeNull();
    expect(notification?.confidence).toBe("strong");
    expect(notification?.text).toContain("Correction detected");
    expect(notification?.text).toContain("No hidden memory store");
    expect(notification?.suggestions.length).toBeGreaterThan(0);
    expect(notification?.text).toContain("ADR-0024");
  });

  it("returns null for negative-pattern matches such as 'no worries'", () => {
    expect(buildAutoNudgeNotification("No worries, this is fine.")).toBeNull();
  });
});
