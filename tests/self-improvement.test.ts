import { describe, expect, it } from "vitest";
import {
  buildAutoNudgeNotification,
  buildSelfImprovementReviewPrompt,
  collectReviewConversation,
  detectCorrectionTrigger,
  findConsolidationPromotionCandidates,
  formatCorrectionArtifactNudge,
  resolveAutoNudgeConfig,
  resolveReviewLoopConfig,
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

describe("ADR-0024 review loop primitives", () => {
  it("defaults the review loop to disabled and supports config/env opt-in", () => {
    expect(resolveReviewLoopConfig({ env: {} })).toEqual({
      enabled: false,
      source: "default",
      intervalTurns: 10,
      recentMessages: 20,
      timeoutMs: 120000,
    });

    expect(resolveReviewLoopConfig({
      env: {},
      config: { self_improvement: { review_loop: { enabled: true, interval_turns: 3, recent_messages: 8, timeout_ms: 90000 } } },
    })).toEqual({
      enabled: true,
      source: "config",
      intervalTurns: 3,
      recentMessages: 8,
      timeoutMs: 90000,
    });

    expect(resolveReviewLoopConfig({
      env: { PIREN_REVIEW_LOOP: "0", PIREN_REVIEW_INTERVAL_TURNS: "2" },
      config: { self_improvement: { review_loop: { enabled: true } } },
    }).enabled).toBe(false);
  });

  it("collects recent user and assistant text from Pi session entries", () => {
    const conversation = collectReviewConversation([
      { message: { role: "system", content: "ignored" } },
      { message: { role: "user", content: "Actually, use project_append_log." } },
      { message: { role: "assistant", content: [{ type: "text", text: "Understood." }, { type: "toolCall", name: "ignored" }] } },
      { role: "user", content: "Please don't put secrets in the vault." },
    ], 2);

    expect(conversation).toEqual([
      "assistant: Understood.",
      "user: Please don't put secrets in the vault.",
    ]);
  });

  it("builds an inspectable review prompt that can only target visible Piren tools", () => {
    const prompt = buildSelfImprovementReviewPrompt({
      agentName: "thor",
      vaultRoot: "/vault",
      conversation: [
        "user: Actually, write this as a concept.",
        "assistant: I will use wiki_update_concept.",
      ],
    });

    expect(prompt).toContain("ADR-0024");
    expect(prompt).toContain("No hidden memory store");
    expect(prompt).toContain("project_append_log");
    expect(prompt).toContain("wiki_update_concept");
    expect(prompt).toContain("If there is no durable knowledge delta, reply exactly: Nothing to promote.");
    expect(prompt).toContain("user: Actually, write this as a concept.");
  });

  it("identifies large raw vault artifacts as consolidation-as-promotion candidates", () => {
    const candidates = findConsolidationPromotionCandidates([
      { path: "Projects/Piren/log.md", bytes: 80_000 },
      { path: "team/thor/MEMORY.md", bytes: 60_000 },
      { path: "wiki/concepts/piren.md", bytes: 90_000 },
      { path: "Projects/Piren/index.md", bytes: 120_000 },
    ], { thresholdBytes: 50_000 });

    expect(candidates.map((candidate) => candidate.path)).toEqual([
      "Projects/Piren/log.md",
      "team/thor/MEMORY.md",
    ]);
    expect(candidates[0]?.kind).toBe("project-log");
    expect(candidates[0]?.suggestedTools).toContain("wiki_update_concept");
    expect(candidates[1]?.kind).toBe("agent-notes");
    expect(candidates[1]?.suggestedTools).toContain("skill_candidate_write");
  });

  it("adds consolidation-as-promotion guidance to the review prompt when raw artifacts are large", () => {
    const prompt = buildSelfImprovementReviewPrompt({
      agentName: "thor",
      vaultRoot: "/vault",
      conversation: ["user: Continue the work."],
      consolidationCandidates: [
        {
          path: "Projects/Piren/log.md",
          bytes: 80_000,
          kind: "project-log",
          reason: "Project log is over the consolidation threshold.",
          suggestedTools: ["wiki_update_concept", "decision_record"],
        },
      ],
    });

    expect(prompt).toContain("Consolidation-as-promotion candidates");
    expect(prompt).toContain("Projects/Piren/log.md");
    expect(prompt).toContain("raw entries stay as evidence");
    expect(prompt).toContain("wiki_update_concept");
  });
});
