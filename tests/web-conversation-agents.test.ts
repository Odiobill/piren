import { describe, expect, it } from "vitest";
import { parseConversationAgents, parseConfiguredModelLabel } from "../web/src/conversation-agents.js";

/**
 * D5 — the Workbench roster parser carries the additive gateway-projected
 * configured-model field. The browser reads the roster ONLY from the
 * authenticated GET /api/conversation-agents response: it never reads agent
 * configuration, never queries a live Pi session/provider, and never
 * infers a model. A present optional `model` field is validated strictly
 * (present-but-invalid fails closed); an absent field stays absent so the
 * Dashboard can distinguish an unavailable configured model truthfully.
 */
describe("parseConversationAgents configured model (D5)", () => {
  it("accepts entries with a configured model string and preserves it", () => {
    const parsed = parseConversationAgents({
      agents: [
        { name: "kimi", online: true, model: "moonshotai/kimi-k2:high" },
        { name: "dipu", online: false },
      ],
    });
    expect(parsed.agents).toEqual([
      { name: "kimi", online: true, model: "moonshotai/kimi-k2:high" },
      { name: "dipu", online: false },
    ]);
    expect("model" in (parsed.agents[1] as object)).toBe(false);
  });

  it("rejects a present-but-non-string model field fail-closed", () => {
    for (const model of [5, true, null, {}, ["a/b"]]) {
      expect(() => parseConversationAgents({ agents: [{ name: "kimi", online: true, model }] }), JSON.stringify(model)).toThrow(
        "unexpected roster entry",
      );
    }
  });

  it("rejects a present-but-empty model string fail-closed (no invented value)", () => {
    expect(() => parseConversationAgents({ agents: [{ name: "kimi", online: true, model: "" }] })).toThrow(
      "unexpected roster entry",
    );
  });

  it("keeps the existing fail-closed validation for the base entry shape", () => {
    expect(() => parseConversationAgents({ agents: [{ name: "", online: true }] })).toThrow("unexpected roster entry");
    expect(() => parseConversationAgents({ agents: [{ name: "kimi" }] })).toThrow("unexpected roster entry");
    expect(() => parseConversationAgents({})).toThrow("unexpected /api/conversation-agents response");
  });
});

describe("parseConfiguredModelLabel (model-card presentation parts)", () => {
  it("parses provider/model and provider/model:thinking", () => {
    expect(parseConfiguredModelLabel("anthropic/claude-opus-4.6")).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4.6",
      thinking: null,
    });
    expect(parseConfiguredModelLabel("moonshotai/kimi-k2:high")).toEqual({
      provider: "moonshotai",
      modelId: "kimi-k2",
      thinking: "high",
    });
  });

  it("returns null for malformed values so the raw string is shown truthfully", () => {
    for (const bad of ["", "nope", "a/", "/b", "a/b:", "a/b:c:d", "a:/b"]) {
      expect(parseConfiguredModelLabel(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
