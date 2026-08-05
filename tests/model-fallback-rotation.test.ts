import { describe, expect, it } from "vitest";
import {
  buildFallbackHandoffPrompt,
  planFallbackAttempt,
  type FallbackPlanResult,
} from "../src/model-fallback-rotation.js";
import type { RunOutcome } from "../src/model-fallback-outcome.js";

// TB3 pure rotation planner + handoff prompt (design §4.3, §5). Pure planning
// state only: no persistence, queues, retries, catalog probing, or agent
// rerouting. Uses the delivered ProviderErrorOutcome eligibility predicate.

const ELIGIBLE: RunOutcome = { category: "provider_error_other", detail: "d" };
const ELIGIBLE_TRANSIENT: RunOutcome = { category: "provider_error_transient_exhausted", detail: "d" };
const NOT_ELIGIBLE: RunOutcome[] = [
  { category: "completed", detail: "d" },
  { category: "aborted", detail: "d" },
  { category: "ambiguous", detail: "d" },
];

const BASE = {
  configuredFallbacks: ["opencode-go/kimi-k3", "openrouter/kimi-k3"],
  autoSwitch: true,
  explicitModelSelected: false,
  aborted: false,
  outcome: ELIGIBLE,
  currentModelId: "kimi-coding/k3",
} as const;

describe("planFallbackAttempt", () => {
  it("no-attempt when auto_switch is disabled or absent", () => {
    const disabled = planFallbackAttempt({ ...BASE, autoSwitch: false });
    expect(disabled).toEqual({ kind: "no-attempt", reason: "auto-switch-disabled" });
    // Absent fallback block is modeled by the caller as autoSwitch:false.
    const absent = planFallbackAttempt({ ...BASE, autoSwitch: false });
    expect(absent).toEqual({ kind: "no-attempt", reason: "auto-switch-disabled" });
  });

  it("no-attempt when an explicit steward model selection is active (precedence over auto_switch)", () => {
    const explicit = planFallbackAttempt({ ...BASE, explicitModelSelected: true, autoSwitch: false });
    expect(explicit).toEqual({ kind: "no-attempt", reason: "explicit-model-selected" });
    const explicitWithAuto = planFallbackAttempt({ ...BASE, explicitModelSelected: true });
    expect(explicitWithAuto).toEqual({ kind: "no-attempt", reason: "explicit-model-selected" });
  });

  it("abort/cancel takes precedence over every other gate", () => {
    const aborted = planFallbackAttempt({ ...BASE, aborted: true });
    expect(aborted).toEqual({ kind: "no-attempt", reason: "aborted" });
    // Abort wins even over explicit selection and a non-eligible outcome.
    expect(planFallbackAttempt({ ...BASE, aborted: true, explicitModelSelected: true })).toEqual({
      kind: "no-attempt",
      reason: "aborted",
    });
    expect(planFallbackAttempt({ ...BASE, aborted: true, outcome: NOT_ELIGIBLE[0]! })).toEqual({
      kind: "no-attempt",
      reason: "aborted",
    });
  });

  it("no-attempt for every non-eligible outcome", () => {
    for (const outcome of NOT_ELIGIBLE) {
      const result = planFallbackAttempt({ ...BASE, outcome });
      expect(result).toEqual({ kind: "no-attempt", reason: "not-eligible" });
    }
  });

  it("selects configured fallback models strictly in declaration order with deterministic attempt numbers", () => {
    const first = planFallbackAttempt({ ...BASE });
    expect(first).toEqual({ kind: "attempt", modelId: "opencode-go/kimi-k3", attemptNumber: 1 });

    const second = planFallbackAttempt({ ...BASE, attemptedModelIds: ["opencode-go/kimi-k3"] });
    expect(second).toEqual({ kind: "attempt", modelId: "openrouter/kimi-k3", attemptNumber: 2 });

    const third = planFallbackAttempt({
      ...BASE,
      attemptedModelIds: ["opencode-go/kimi-k3", "openrouter/kimi-k3"],
    });
    expect(third).toEqual({ kind: "exhausted", attemptedCount: 2 });
  });

  it("never chooses the current/primary model, even when duplicated in the configured list", () => {
    const result = planFallbackAttempt({
      ...BASE,
      configuredFallbacks: ["kimi-coding/k3", "opencode-go/kimi-k3"],
      currentModelId: "kimi-coding/k3",
    });
    expect(result).toEqual({ kind: "attempt", modelId: "opencode-go/kimi-k3", attemptNumber: 1 });
  });

  it("never chooses a model already attempted in this incident", () => {
    const result = planFallbackAttempt({
      ...BASE,
      configuredFallbacks: ["a/m1", "b/m2", "c/m3"],
      attemptedModelIds: ["a/m1", "c/m3"],
    });
    expect(result).toEqual({ kind: "attempt", modelId: "b/m2", attemptNumber: 3 });
  });

  it("exhaustion is a distinct deterministic result, not a retry or loop", () => {
    const allAttempted = planFallbackAttempt({
      ...BASE,
      configuredFallbacks: ["a/m1", "b/m2"],
      attemptedModelIds: ["a/m1", "b/m2"],
    });
    expect(allAttempted).toEqual({ kind: "exhausted", attemptedCount: 2 });

    const noneDeclared = planFallbackAttempt({ ...BASE, configuredFallbacks: [] });
    expect(noneDeclared).toEqual({ kind: "exhausted", attemptedCount: 0 });

    // Not a no-attempt reason: exhaustion is its own kind.
    const kinds: FallbackPlanResult[] = [allAttempted, noneDeclared];
    for (const kind of kinds) expect(kind.kind).toBe("exhausted");
  });

  it("both eligible provider-error categories allow attempts", () => {
    expect(planFallbackAttempt({ ...BASE, outcome: ELIGIBLE }).kind).toBe("attempt");
    expect(planFallbackAttempt({ ...BASE, outcome: ELIGIBLE_TRANSIENT }).kind).toBe("attempt");
  });

  it("results carry no error text (deterministic evidence fields only)", () => {
    const result = planFallbackAttempt({ ...BASE, attemptedModelIds: ["opencode-go/kimi-k3"] });
    expect(JSON.stringify(result)).not.toMatch(/error|fail|detail|secret/i);
  });
});

describe("buildFallbackHandoffPrompt", () => {
  it("produces the exact design §4.3 structure for a known model and category", () => {
    const prompt = buildFallbackHandoffPrompt(
      "Please review the vault layout.",
      "kimi-coding/k3",
      "provider_error_other",
    );
    expect(prompt).toBe(
      "[model fallback: your previous run on kimi-coding/k3 ended with a provider error\n" +
        " (provider_error_other) before producing any output or running any tool. Continue the\n" +
        " original request exactly. Inspect durable task/conversation evidence before\n" +
        " acting and do not repeat uncertain side effects. The request is unchanged:]\n" +
        "Please review the vault layout.",
    );
  });

  it("names only the prior model id and eligible category", () => {
    const prompt = buildFallbackHandoffPrompt("Go.", "opencode-go/kimi-k3", "provider_error_transient_exhausted");
    expect(prompt).toContain("opencode-go/kimi-k3");
    expect(prompt).toContain("provider_error_transient_exhausted");
    expect(prompt).not.toContain("kimi-coding/k3"); // no other model mentioned
  });

  it("preserves a verbatim multiline original prompt without modification", () => {
    const original = "Read team/dipu/inbox/20260805T160414200Z-example.md\n\nThen:\n1. Summarize.\n2. Append a log entry.";
    const prompt = buildFallbackHandoffPrompt(original, "a/m1", "provider_error_other");
    expect(prompt.endsWith("\n" + original)).toBe(true);
    // The original is appended verbatim as the exact tail (all its lines).
    const originalLines = original.split("\n");
    expect(prompt.split("\n").slice(-originalLines.length).join("\n")).toBe(original);
  });

  it("never includes provider error text, credentials, or an implicit new request", () => {
    const secret = "OpenAI API error (401): sk-ant-secret-body";
    const prompt = buildFallbackHandoffPrompt("Original task.", "a/m1", "provider_error_other");
    expect(prompt).not.toContain(secret);
    expect(prompt).not.toMatch(/401|403|429|5\d\d/i);
    expect(prompt).not.toMatch(/api[_-]?key|token|secret|bearer/i);
    // The handoff instructs continuation of the SAME request (the design wraps
    // the line, so assert the wrapped phrase parts); it must not add a new request.
    expect(prompt).toContain("Continue the");
    expect(prompt).toContain("original request exactly");
    expect(prompt).toContain("The request is unchanged");
  });
});
