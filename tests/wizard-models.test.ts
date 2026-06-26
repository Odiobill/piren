import { describe, expect, it } from "vitest";
import {
  MODEL_CATALOG,
  formatModelMenu,
  resolveModelChoice,
  buildAgentModelConfig,
  type AgentModelConfigInput,
} from "../src/wizard.js";

describe("model catalog", () => {
  it("includes flagship models for the common providers", () => {
    const ids = (MODEL_CATALOG.anthropic ?? []).map((m) => m.id);
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("claude-opus-4-8");
    expect(ids).toContain("claude-haiku-4-5");
    const gpt5 = (MODEL_CATALOG.openai ?? []).map((m) => m.id);
    expect(gpt5).toContain("gpt-5.2");
    const gemini = (MODEL_CATALOG.google ?? []).map((m) => m.id);
    expect(gemini).toContain("gemini-3-pro-preview");
  });

  it("each model entry has an id and a human-readable name", () => {
    for (const provider of Object.keys(MODEL_CATALOG)) {
      for (const model of MODEL_CATALOG[provider] ?? []) {
        expect(typeof model.id).toBe("string");
        expect(model.id.length).toBeGreaterThan(0);
        expect(typeof model.name).toBe("string");
        expect(model.name.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("formatModelMenu", () => {
  it("lists numbered models for a provider with names", () => {
    const text = formatModelMenu("anthropic");
    expect(text).toContain("claude-sonnet-4-6");
    expect(text).toContain("Claude Sonnet 4.6");
    expect(text).toMatch(/\d+\.\s/);
    // includes a custom option at the end
    expect(text.toLowerCase()).toMatch(/custom|enter.*manually|other/);
  });

  it("falls back gracefully for an unknown provider (custom only)", () => {
    const text = formatModelMenu("bogus");
    expect(text.toLowerCase()).toMatch(/custom|enter.*manually/);
  });
});

describe("resolveModelChoice", () => {
  it("resolves a numeric selection to the catalog entry", () => {
    const resolved = resolveModelChoice("anthropic", 0);
    expect(resolved).not.toBeNull();
    expect(resolved!.provider).toBe("anthropic");
    expect(resolved!.id).toBe((MODEL_CATALOG.anthropic ?? [])[0]!.id);
  });

  it("resolves the custom slot by returning null", () => {
    const resolved = resolveModelChoice("anthropic", (MODEL_CATALOG.anthropic ?? []).length);
    expect(resolved).toBeNull();
  });

  it("returns null for an out-of-range index", () => {
    expect(resolveModelChoice("anthropic", 999)).toBeNull();
  });
});

describe("buildAgentModelConfig", () => {
  it("serializes a model with provider prefix and thinking level", () => {
    const input: AgentModelConfigInput = {
      provider: "anthropic",
      id: "claude-sonnet-4-6",
      thinking: "medium",
    };
    const config = buildAgentModelConfig(input);
    expect(config.id).toBe("anthropic/claude-sonnet-4-6");
    expect(config.thinking).toBe("medium");
  });

  it("preserves an id that already includes the provider prefix", () => {
    const config = buildAgentModelConfig({ provider: "openai", id: "openai/gpt-5.2", thinking: "off" });
    expect(config.id).toBe("openai/gpt-5.2");
    expect(config.thinking).toBe("off");
  });

  it("omits thinking when not provided", () => {
    const config = buildAgentModelConfig({ provider: "google", id: "gemini-3-pro-preview" });
    expect(config.id).toBe("google/gemini-3-pro-preview");
    expect(config.thinking).toBeUndefined();
  });
});
