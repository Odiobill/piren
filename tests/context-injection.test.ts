import { describe, expect, it } from "vitest";
import { resolveContextInjectionMode, shouldInjectContext } from "../src/context-injection.js";

describe("resolveContextInjectionMode", () => {
  it("defaults to per_turn with no warnings when config is null or the block is absent", () => {
    expect(resolveContextInjectionMode({ env: {}, config: null })).toEqual({ mode: "per_turn", warnings: [] });
    expect(resolveContextInjectionMode({ env: {}, config: {} })).toEqual({ mode: "per_turn", warnings: [] });
  });

  it("accepts explicit per_turn and session_start_only", () => {
    expect(resolveContextInjectionMode({ env: {}, config: { context_injection: { mode: "per_turn" } } })).toEqual({ mode: "per_turn", warnings: [] });
    expect(resolveContextInjectionMode({ env: {}, config: { context_injection: { mode: "session_start_only" } } })).toEqual({ mode: "session_start_only", warnings: [] });
  });

  it("falls back to per_turn with a warning for an unknown mode value", () => {
    const result = resolveContextInjectionMode({ env: {}, config: { context_injection: { mode: "session_start" } } });
    expect(result.mode).toBe("per_turn");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("session_start");
  });

  it("falls back to per_turn with a warning for a non-map context_injection block", () => {
    const result = resolveContextInjectionMode({ env: {}, config: { context_injection: "session_start_only" } });
    expect(result.mode).toBe("per_turn");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("context_injection");
  });

  it("honors a valid PIREN_CONTEXT_INJECTION override over the config value", () => {
    const result = resolveContextInjectionMode({
      env: { PIREN_CONTEXT_INJECTION: "session_start_only" },
      config: { context_injection: { mode: "per_turn" } },
    });
    expect(result).toEqual({ mode: "session_start_only", warnings: [] });
  });

  it("falls back to the config value with a warning for an invalid override", () => {
    const result = resolveContextInjectionMode({
      env: { PIREN_CONTEXT_INJECTION: "bogus" },
      config: { context_injection: { mode: "session_start_only" } },
    });
    expect(result.mode).toBe("session_start_only");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("PIREN_CONTEXT_INJECTION");
  });

  it("falls back to per_turn when both the override and the config value are invalid", () => {
    const result = resolveContextInjectionMode({
      env: { PIREN_CONTEXT_INJECTION: "bogus" },
      config: { context_injection: { mode: "also-bogus" } },
    });
    expect(result.mode).toBe("per_turn");
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
  });
});

describe("shouldInjectContext", () => {
  it("always injects in per_turn mode", () => {
    expect(shouldInjectContext({ mode: "per_turn", sessionStartedSinceLastInjection: false })).toBe(true);
    expect(shouldInjectContext({ mode: "per_turn", sessionStartedSinceLastInjection: true })).toBe(true);
  });

  it("injects only on the first prompt of a session in session_start_only mode", () => {
    expect(shouldInjectContext({ mode: "session_start_only", sessionStartedSinceLastInjection: true })).toBe(true);
    expect(shouldInjectContext({ mode: "session_start_only", sessionStartedSinceLastInjection: false })).toBe(false);
  });
});
