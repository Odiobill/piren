import { describe, expect, it } from "vitest";
import {
  buildModelFallbackNotice,
  loadAgentFallbackPolicy,
  parseAgentFallbackPolicy,
  splitFallbackModelId,
  type GatewayFallbackPolicy,
} from "../src/model-fallback-gateway.js";

// TB4 gateway-specific pure helpers (design §5.4, §6.2, §7). These helpers
// are filesystem/Pi-auth-free: policy parsing, exact-id splitting (first
// slash only, colons preserved), and the six-key model_fallback notice
// builder. The rotation decision itself stays in the delivered
// planFallbackAttempt core.

const INERT: GatewayFallbackPolicy = { primaryModelId: null, fallback: { ok: true, present: false } };

describe("parseAgentFallbackPolicy", () => {
  it("null or empty config resolves to an inert policy", () => {
    expect(parseAgentFallbackPolicy(null)).toEqual(INERT);
    expect(parseAgentFallbackPolicy({})).toEqual(INERT);
    expect(parseAgentFallbackPolicy({ model: undefined })).toEqual(INERT);
  });

  it("reads the normalized primary model id from model.id", () => {
    const policy = parseAgentFallbackPolicy({ model: { id: "openai/gpt-4.1" } });
    expect(policy.primaryModelId).toBe("openai/gpt-4.1");
    expect(policy.fallback).toEqual({ ok: true, present: false });
  });

  it("combines model.provider with a bare model.id like run.ts does", () => {
    const policy = parseAgentFallbackPolicy({ model: { provider: "openai", id: "gpt-4.1" } });
    expect(policy.primaryModelId).toBe("openai/gpt-4.1");
  });

  it("keeps a slash-bearing bare id as-is", () => {
    const policy = parseAgentFallbackPolicy({ model: { id: "kimi-coding/k3" } });
    expect(policy.primaryModelId).toBe("kimi-coding/k3");
  });

  it("parses a valid fallback block and passes through the TB1 outcome untouched", () => {
    const policy = parseAgentFallbackPolicy({
      model: {
        id: "kimi-coding/k3",
        fallback: { auto_switch: false, models: ["opencode-go/kimi-k3", "ollama/llama3.1:8b"] },
      },
    });
    expect(policy.primaryModelId).toBe("kimi-coding/k3");
    expect(policy.fallback).toEqual({
      ok: true,
      present: true,
      config: { autoSwitch: false, models: ["opencode-go/kimi-k3", "ollama/llama3.1:8b"] },
    });
  });

  it("malformed fallback blocks surface the deterministic TB1 reason (runtime inert)", () => {
    const policy = parseAgentFallbackPolicy({ model: { id: "a/b", fallback: { models: "nope" } } });
    expect(policy.fallback).toEqual({ ok: false, reason: "model.fallback.models must be an array." });
    const missing = parseAgentFallbackPolicy({ model: { id: "a/b", fallback: { models: [] } } });
    expect(missing.fallback.ok).toBe(false);
    const nonMapping = parseAgentFallbackPolicy({ model: { id: "a/b", fallback: "x" } });
    expect(nonMapping.fallback).toEqual({ ok: false, reason: "model.fallback must be a mapping." });
  });
});

describe("splitFallbackModelId", () => {
  it("splits at the FIRST slash into provider and modelId", () => {
    expect(splitFallbackModelId("openai/gpt-4.1")).toEqual({ provider: "openai", modelId: "gpt-4.1" });
    expect(splitFallbackModelId("openrouter/moonshotai/kimi-k3")).toEqual({
      provider: "openrouter",
      modelId: "moonshotai/kimi-k3",
    });
  });

  it("preserves colons in the model id (exact local ids, no suffix heuristics)", () => {
    expect(splitFallbackModelId("ollama/llama3.1:8b")).toEqual({ provider: "ollama", modelId: "llama3.1:8b" });
  });

  it("defensively keeps a no-slash string as provider with an empty modelId", () => {
    expect(splitFallbackModelId("nakedid")).toEqual({ provider: "nakedid", modelId: "" });
  });
});

describe("buildModelFallbackNotice", () => {
  it("builds the exact six-key attempt notice", () => {
    expect(
      buildModelFallbackNotice({
        from: "a/m1",
        to: "b/m2",
        category: "provider_error_other",
        attempt: 1,
        exhausted: false,
      }),
    ).toEqual({
      kind: "model_fallback",
      from: "a/m1",
      to: "b/m2",
      category: "provider_error_other",
      attempt: 1,
      exhausted: false,
    });
  });

  it("builds a terminal exhaustion notice with an empty to", () => {
    expect(
      buildModelFallbackNotice({
        from: "b/m2",
        to: null,
        category: "provider_error_transient_exhausted",
        attempt: 2,
        exhausted: true,
      }),
    ).toEqual({
      kind: "model_fallback",
      from: "b/m2",
      to: "",
      category: "provider_error_transient_exhausted",
      attempt: 2,
      exhausted: true,
    });
  });

  it("never carries raw provider error text or secrets", () => {
    const notice = buildModelFallbackNotice({
      from: "a/m1",
      to: "b/m2",
      category: "provider_error_other",
      attempt: 1,
      exhausted: false,
    });
    expect(JSON.stringify(notice)).not.toMatch(/401|403|5\d\d|api[_-]?key|secret|token/i);
  });
});

describe("loadAgentFallbackPolicy", () => {
  it("reads team/<agent>/config.yml best-effort and parses the policy", async () => {
    const policy = await loadAgentFallbackPolicy("/vault", "dipu", {
      readFile: async () =>
        "model:\n  id: kimi-coding/k3\n  fallback:\n    models:\n      - openai/gpt-4.1\n",
    });
    expect(policy.primaryModelId).toBe("kimi-coding/k3");
    expect(policy.fallback).toEqual({
      ok: true,
      present: true,
      config: { autoSwitch: true, models: ["openai/gpt-4.1"] },
    });
  });

  it("missing vaultRoot or agent resolves inert without touching the filesystem", async () => {
    expect(await loadAgentFallbackPolicy(undefined, "dipu")).toEqual(INERT);
    expect(await loadAgentFallbackPolicy("/vault", null)).toEqual(INERT);
  });

  it("an invalid agent name resolves inert and never touches the filesystem", async () => {
    let touched = false;
    const policy = await loadAgentFallbackPolicy("/vault", "../escape", {
      readFile: async () => {
        touched = true;
        return "model:";
      },
    });
    expect(policy).toEqual(INERT);
    expect(touched).toBe(false);
    expect(await loadAgentFallbackPolicy("/vault", "UPPER", { readFile: async () => "" })).toEqual(INERT);
  });

  it("missing/malformed files resolve inert (best-effort contract)", async () => {
    const missing = await loadAgentFallbackPolicy("/vault", "dipu", {
      readFile: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(missing).toEqual(INERT);
    const malformed = await loadAgentFallbackPolicy("/vault", "dipu", {
      readFile: async () => "not: [valid",
    });
    expect(malformed).toEqual(INERT);
  });
});
