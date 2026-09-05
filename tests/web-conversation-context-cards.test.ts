// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { agentDisplayName } from "../web/src/agent-display.js";
import {
  contextCardsForSelection,
  telemetryPopupViewModel,
  type ContextCardViewModel,
} from "../web/src/conversation-context-cards.js";
import {
  applyConversationTelemetryFrame,
  applyConversationTelemetryRead,
  emptyConversationTelemetryState,
  type ConversationTelemetryState,
} from "../web/src/conversation-telemetry.js";

/**
 * Context cards / telemetry details popup — pure view-model core
 * (workbench-context-cards-telemetry-details-popup-design §2, §5, §6).
 *
 * The pure core maps the EXISTING T6 parser/state core outputs (never
 * re-parsed, never re-derived) plus durable audience order to card and popup
 * view models. It performs no fetch, no DOM, and no React. Truthfulness pins:
 * every T6 state maps one-to-one; a truthful 0% keeps a real percent while
 * unknown/unavailable never becomes a number; the bar is only ever "Context"
 * (never energy/health/attention/availability/progress).
 */

const OK_ENTRY_FRAME = {
  conversationId: "c1",
  agent: "dipu",
  runId: "run-0001",
  contextState: "ok",
  context: { tokens: 60000, contextWindow: 200000, percent: 30 },
  model: { provider: "anthropic", id: "claude-sonnet-4" },
  thinkingLevel: "high",
  autoCompactionEnabled: true,
} as const;

function stateWith(frame: Record<string, unknown>): ConversationTelemetryState {
  return applyConversationTelemetryFrame(emptyConversationTelemetryState(), frame as never);
}

function cardFor(agent: string, cards: ContextCardViewModel[]): ContextCardViewModel {
  const card = cards.find((candidate) => candidate.agent === agent);
  if (card === undefined) throw new Error(`no card for ${agent}`);
  return card;
}

describe("contextCardsForSelection — membership, ordering, states", () => {
  it("active selection renders one card per durable audience member in durable order, never-sampled truthful state", () => {
    const cards = contextCardsForSelection({ phase: "active", audience: ["dipu", "zai"] }, emptyConversationTelemetryState());
    expect(cards.map((card) => card.agent)).toEqual(["dipu", "zai"]);
    for (const card of cards) {
      expect(card.stateKey).toBe("not_sampled");
      expect(card.bar).toEqual({ kind: "neutral" });
      expect(card.shortText).toBe("not sampled");
      expect(card.stateText).toBe("No context telemetry yet");
      expect(card.accessibleName).toBe(`${agentDisplayName(card.agent)}: No context telemetry yet; activate for details`);
      // No invented zero/percent anywhere.
      expect(card.stateText).not.toContain("0%");
      expect(card.shortText).not.toContain("%");
    }
    expect(cards[0]?.initial).toBe("D");
    expect(cards[1]?.initial).toBe("Z");
  });

  it("read-only and no-selection phases render no cards", () => {
    const telemetry = stateWith(OK_ENTRY_FRAME);
    expect(contextCardsForSelection({ phase: "read-only" }, telemetry)).toEqual([]);
    expect(contextCardsForSelection({ phase: "none" }, telemetry)).toEqual([]);
  });

  it("an ok entry produces a truthful percent bar (30.00%) with exact two-decimal accessible text", () => {
    const cards = contextCardsForSelection({ phase: "active", audience: ["dipu"] }, stateWith(OK_ENTRY_FRAME));
    const card = cardFor("dipu", cards);
    expect(card.stateKey).toBe("ok");
    expect(card.bar).toEqual({ kind: "percent", percent: 30 });
    expect(card.shortText).toBe("30.00%");
    expect(card.stateText).toBe("Context usage: 30.00% of 200.0k window");
    expect(card.accessibleName).toBe("Dipu: Context usage: 30.00% of 200.0k window; activate for details");
  });

  it("fractional percents render with exactly two decimals (8.74% / 7.50%)", () => {
    const fractional = stateWith({ ...OK_ENTRY_FRAME, context: { tokens: 17480, contextWindow: 200000, percent: 8.74 } });
    const cardA = cardFor("dipu", contextCardsForSelection({ phase: "active", audience: ["dipu"] }, fractional));
    expect(cardA.shortText).toBe("8.74%");
    expect(cardA.stateText).toBe("Context usage: 8.74% of 200.0k window");
    const half = stateWith({ ...OK_ENTRY_FRAME, context: { tokens: 15000, contextWindow: 200000, percent: 7.5 } });
    const cardB = cardFor("dipu", contextCardsForSelection({ phase: "active", audience: ["dipu"] }, half));
    expect(cardB.shortText).toBe("7.50%");
    expect(cardB.stateText).toBe("Context usage: 7.50% of 200.0k window");
  });

  it("a truthful 0% is a real measured value: percent bar with 0, rendered as 0.00%, never collapsed into unavailable", () => {
    const zero = stateWith({ ...OK_ENTRY_FRAME, context: { tokens: 0, contextWindow: 200000, percent: 0 } });
    const card = cardFor("dipu", contextCardsForSelection({ phase: "active", audience: ["dipu"] }, zero));
    expect(card.stateKey).toBe("ok");
    expect(card.bar).toEqual({ kind: "percent", percent: 0 });
    expect(card.shortText).toBe("0.00%");
    expect(card.stateText).toBe("Context usage: 0.00% of 200.0k window");
  });

  it("post-compaction pending renders the truthful unavailable phrase, never a fabricated percent", () => {
    const pending = stateWith({
      conversationId: "c1",
      agent: "dipu",
      runId: "run-0002",
      contextState: "post_compaction_pending",
      context: { tokens: null, contextWindow: 200000, percent: null },
    });
    const card = cardFor("dipu", contextCardsForSelection({ phase: "active", audience: ["dipu"] }, pending));
    expect(card.stateKey).toBe("post_compaction_pending");
    expect(card.bar).toEqual({ kind: "neutral" });
    expect(card.shortText).toBe("unavailable");
    expect(card.stateText).toBe("Context usage temporarily unavailable after compaction");
    expect(card.accessibleName).toContain("temporarily unavailable after compaction");
    expect(card.accessibleName).not.toContain("%");
  });

  it("no_window and no_live_session stay distinct truthful states", () => {
    const noWindow = applyConversationTelemetryRead(emptyConversationTelemetryState(), "dipu", { sessionState: "live", contextState: "no_window" });
    const cardNoWindow = cardFor("dipu", contextCardsForSelection({ phase: "active", audience: ["dipu"] }, noWindow));
    expect(cardNoWindow.stateKey).toBe("no_window");
    expect(cardNoWindow.bar).toEqual({ kind: "neutral" });
    expect(cardNoWindow.shortText).toBe("no window");
    expect(cardNoWindow.stateText).toBe("No context window information for this session");

    const noLive = applyConversationTelemetryRead(emptyConversationTelemetryState(), "dipu", { sessionState: "no_live_session" });
    const cardNoLive = cardFor("dipu", contextCardsForSelection({ phase: "active", audience: ["dipu"] }, noLive));
    expect(cardNoLive.stateKey).toBe("no_live_session");
    expect(cardNoLive.bar).toEqual({ kind: "neutral" });
    expect(cardNoLive.shortText).toBe("no live session");
    expect(cardNoLive.stateText).toBe("No live session");
  });

  it("telemetry-bearing agents outside the audience append after the durable audience in deterministic insertion order", () => {
    let telemetry = emptyConversationTelemetryState();
    telemetry = applyConversationTelemetryFrame(telemetry, { ...OK_ENTRY_FRAME, agent: "kimi", runId: "run-0003" } as never);
    telemetry = applyConversationTelemetryFrame(telemetry, { ...OK_ENTRY_FRAME, agent: "sam", runId: "run-0004" } as never);
    telemetry = applyConversationTelemetryFrame(telemetry, OK_ENTRY_FRAME as never);
    const cards = contextCardsForSelection({ phase: "active", audience: ["dipu", "zai"] }, telemetry);
    expect(cards.map((card) => card.agent)).toEqual(["dipu", "zai", "kimi", "sam"]);
  });

  it("card vocabulary never uses energy/health/attention/availability/progress wording", () => {
    const telemetry = stateWith(OK_ENTRY_FRAME);
    const cards = contextCardsForSelection({ phase: "active", audience: ["dipu"] }, telemetry);
    const haystack = cards.map((card) => `${card.shortText} ${card.stateText} ${card.accessibleName}`).join(" ").toLowerCase();
    for (const banned of ["energy", "health", "attention", "availability", "progress"]) {
      expect(haystack).not.toContain(banned);
    }
  });
});

describe("telemetryPopupViewModel — bounded permitted fields only", () => {
  it("ok entry: title, labels, state line, and exactly the permitted detail fields", () => {
    const model = telemetryPopupViewModel("dipu", stateWith(OK_ENTRY_FRAME).get("dipu"));
    expect(model.title).toBe("Context telemetry for Dipu");
    expect(model.closeLabel).toBe("Close context telemetry for Dipu");
    expect(model.refreshLabel).toBe("Refresh context telemetry for Dipu");
    expect(model.stateKey).toBe("ok");
    expect(model.stateText).toBe("Context usage: 30.00% of 200.0k window");
    expect(model.bar).toEqual({ kind: "percent", percent: 30 });
    expect(model.fields).toEqual([
      { label: "Agent", value: "Dipu" },
      { label: "State", value: "Context usage: 30.00% of 200.0k window" },
      { label: "Context tokens", value: "60.0k" },
      { label: "Context window", value: "200.0k" },
      { label: "Context usage", value: "30.00%" },
      { label: "Model", value: "anthropic/claude-sonnet-4" },
      { label: "Thinking", value: "high" },
      { label: "Auto-compaction", value: "on" },
    ]);
    // Excluded fields never appear: no session ids/paths, run ids, totals, or cost.
    const rendered = JSON.stringify(model);
    for (const banned of ["run-0001", "sessionFile", "sessionId", "cost", "cacheRead", "cacheWrite"]) {
      expect(rendered).not.toContain(banned);
    }
  });

  it("post-compaction pending keeps only the truthful context window field", () => {
    const pending = stateWith({
      conversationId: "c1",
      agent: "dipu",
      runId: "run-0005",
      contextState: "post_compaction_pending",
      context: { tokens: null, contextWindow: 200000, percent: null },
    });
    const model = telemetryPopupViewModel("dipu", pending.get("dipu"));
    expect(model.stateKey).toBe("post_compaction_pending");
    expect(model.stateText).toBe("Context usage temporarily unavailable after compaction");
    expect(model.bar).toEqual({ kind: "neutral" });
    expect(model.fields).toEqual([
      { label: "Agent", value: "Dipu" },
      { label: "State", value: "Context usage temporarily unavailable after compaction" },
      { label: "Context window", value: "200.0k" },
    ]);
  });

  it("no_window and no_live_session and never-sampled carry only the agent and truthful state lines", () => {
    const noWindow = applyConversationTelemetryRead(emptyConversationTelemetryState(), "dipu", { sessionState: "live", contextState: "no_window" });
    expect(telemetryPopupViewModel("dipu", noWindow.get("dipu")).fields).toEqual([
      { label: "Agent", value: "Dipu" },
      { label: "State", value: "No context window information for this session" },
    ]);
    const noLive = applyConversationTelemetryRead(emptyConversationTelemetryState(), "dipu", { sessionState: "no_live_session" });
    const noLiveModel = telemetryPopupViewModel("dipu", noLive.get("dipu"));
    expect(noLiveModel.stateKey).toBe("no_live_session");
    expect(noLiveModel.stateText).toBe("No live session");
    expect(noLiveModel.fields).toEqual([
      { label: "Agent", value: "Dipu" },
      { label: "State", value: "No live session" },
    ]);
    const neverSampled = telemetryPopupViewModel("dipu", undefined);
    expect(neverSampled.stateKey).toBe("not_sampled");
    expect(neverSampled.stateText).toBe("No context telemetry yet");
    expect(neverSampled.fields).toEqual([
      { label: "Agent", value: "Dipu" },
      { label: "State", value: "No context telemetry yet" },
    ]);
  });

  it("partial optional facts render only the present ones (model id alone, auto-compaction off)", () => {
    const partial = stateWith({
      conversationId: "c1",
      agent: "dipu",
      runId: "run-0006",
      contextState: "ok",
      context: { tokens: 100, contextWindow: 1000, percent: 10 },
      model: { id: "gpt-5.6-terra" },
      autoCompactionEnabled: false,
    });
    const model = telemetryPopupViewModel("dipu", partial.get("dipu"));
    expect(model.fields).toEqual([
      { label: "Agent", value: "Dipu" },
      { label: "State", value: "Context usage: 10.00% of 1.0k window" },
      { label: "Context tokens", value: "100" },
      { label: "Context window", value: "1.0k" },
      { label: "Context usage", value: "10.00%" },
      { label: "Model", value: "gpt-5.6-terra" },
      { label: "Auto-compaction", value: "off" },
    ]);
  });

  it("popup field labels never exceed the bounded allowlist (agent, state, tokens/window/percent, model, thinking, auto-compaction)", () => {
    const allowed = ["Agent", "State", "Context tokens", "Context window", "Context usage", "Model", "Thinking", "Auto-compaction"];
    const models = [
      telemetryPopupViewModel("dipu", stateWith(OK_ENTRY_FRAME).get("dipu")),
      telemetryPopupViewModel("dipu", undefined),
      telemetryPopupViewModel("zai", applyConversationTelemetryRead(emptyConversationTelemetryState(), "zai", { sessionState: "no_live_session" }).get("zai")),
    ];
    for (const model of models) {
      for (const field of model.fields) {
        expect(allowed).toContain(field.label);
      }
    }
  });
});
