import { describe, expect, it } from "vitest";
import {
  MAX_FALLBACK_MODELS,
  parseModelFallbackConfig,
} from "../src/model-fallback-config.js";

// TB1 pure parser (Projects/Piren/model-fallbacks-design.md §2.2).
// Absent fallback is inert; a present block must be a mapping with a non-empty
// ordered array of exact provider/modelId strings (colon-bearing ids such as
// `ollama/llama3.1:8b` preserved), optional boolean auto_switch defaulting to
// true, bounded to MAX_FALLBACK_MODELS, duplicates rejected. No catalog lookup,
// provider availability, credentials, or suffix heuristics.

describe("parseModelFallbackConfig", () => {
  it("treats an absent fallback as a valid inert absence", () => {
    expect(parseModelFallbackConfig(undefined)).toEqual({ ok: true, present: false });
  });

  it("defaults auto_switch to true when omitted", () => {
    const result = parseModelFallbackConfig({ models: ["opencode-go/kimi-k3"] });
    expect(result).toEqual({
      ok: true,
      present: true,
      config: { autoSwitch: true, models: ["opencode-go/kimi-k3"] },
    });
  });

  it("parses a valid fallback with explicit auto_switch and ordered models", () => {
    const result = parseModelFallbackConfig({
      auto_switch: true,
      models: ["opencode-go/kimi-k3", "openrouter/kimi-k3"],
    });
    expect(result).toEqual({
      ok: true,
      present: true,
      config: {
        autoSwitch: true,
        models: ["opencode-go/kimi-k3", "openrouter/kimi-k3"],
      },
    });
  });

  it("preserves an explicit auto_switch false as valid and inspectable", () => {
    const result = parseModelFallbackConfig({
      auto_switch: false,
      models: ["opencode-go/kimi-k3"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.present) throw new Error("unreachable");
    expect(result.config.autoSwitch).toBe(false);
    expect(result.config.models).toEqual(["opencode-go/kimi-k3"]);
  });

  it("preserves colon-bearing exact model ids such as ollama/llama3.1:8b", () => {
    const result = parseModelFallbackConfig({ models: ["ollama/llama3.1:8b", "ollama/qwen2.5-coder:7b"] });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.present) throw new Error("unreachable");
    expect(result.config.models).toEqual(["ollama/llama3.1:8b", "ollama/qwen2.5-coder:7b"]);
  });

  it("accepts exactly MAX_FALLBACK_MODELS entries (boundary) and exposes the constant", () => {
    expect(MAX_FALLBACK_MODELS).toBe(5);
    const models = ["a/m1", "a/m2", "a/m3", "a/m4", "a/m5"];
    const result = parseModelFallbackConfig({ models });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.present) throw new Error("unreachable");
    expect(result.config.models).toHaveLength(5);
  });

  it("rejects more than MAX_FALLBACK_MODELS entries with a deterministic non-secret reason", () => {
    const result = parseModelFallbackConfig({
      models: ["a/m1", "a/m2", "a/m3", "a/m4", "a/m5", "a/m6"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("5");
    expect(result.reason).toMatch(/maximum/i);
  });

  it("rejects a present fallback that is not a mapping", () => {
    for (const bad of ["models", 42, true, ["a/m1"]]) {
      const result = parseModelFallbackConfig(bad);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/mapping/i);
    }
  });

  it("rejects an explicit null fallback as present-but-not-a-mapping", () => {
    const result = parseModelFallbackConfig(null);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/mapping/i);
  });

  it("rejects a missing or non-array models list", () => {
    const noModels = parseModelFallbackConfig({});
    expect(noModels.ok).toBe(false);
    if (noModels.ok) throw new Error("unreachable");
    expect(noModels.reason).toMatch(/models/i);

    const nonArray = parseModelFallbackConfig({ models: "opencode-go/kimi-k3" });
    expect(nonArray.ok).toBe(false);
    if (nonArray.ok) throw new Error("unreachable");
    expect(nonArray.reason).toMatch(/models/i);
  });

  it("rejects an empty models array", () => {
    const result = parseModelFallbackConfig({ models: [] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/non-empty/i);
  });

  it("rejects non-string and empty-string model entries", () => {
    const nonString = parseModelFallbackConfig({ models: ["a/m1", 7] });
    expect(nonString.ok).toBe(false);
    if (nonString.ok) throw new Error("unreachable");
    expect(nonString.reason).toMatch(/models/i);

    const empty = parseModelFallbackConfig({ models: [""] });
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error("unreachable");
    expect(empty.reason).toMatch(/models/i);
  });

  it("rejects ids that do not match the conservative provider/modelId grammar", () => {
    const badIds = [
      "no-slash",
      "/missing-provider",
      "provider/",
      "UPPER/m1",
      "provider/With-Space",
      "provider/m1!",
      " provider/m1",
    ];
    for (const id of badIds) {
      const result = parseModelFallbackConfig({ models: [id] });
      expect(result.ok, `expected rejection for ${JSON.stringify(id)}`).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/valid model id/i);
    }
  });

  it("does not reject a thinking-like colon suffix by heuristic: the exact id is preserved", () => {
    // A trailing :... is part of the exact model identity (like
    // ollama/llama3.1:8b); no suffix heuristic decides validity.
    const result = parseModelFallbackConfig({ models: ["provider/m1:thinking"] });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.present) throw new Error("unreachable");
    expect(result.config.models).toEqual(["provider/m1:thinking"]);
  });

  it("rejects duplicate ids in the list with a deterministic reason", () => {
    const result = parseModelFallbackConfig({ models: ["a/m1", "b/m2", "a/m1"] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/duplicate/i);
  });

  it("rejects a non-boolean auto_switch", () => {
    for (const bad of ["yes", 1, null, ["x"]]) {
      const result = parseModelFallbackConfig({ auto_switch: bad, models: ["a/m1"] });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/auto_switch/i);
    }
  });
});
