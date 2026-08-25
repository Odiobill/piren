import { describe, expect, it } from "vitest";
import {
  contextCardsForSelection,
  telemetryPopupViewModel,
} from "../web/src/conversation-context-cards.js";
import type { ConversationTelemetryLiveFacts, ConversationTelemetryState } from "../web/src/conversation-telemetry.js";
import type { ContextContinuityEntry } from "../web/src/context-continuity-store.js";

/**
 * VR-4 — restored Context continuity view models. A rehydrated entry renders
 * as the SAME concise compact card (no stale label), while ONLY the popup
 * adds the truthful "Last observed <time>" field until a fresh live frame or
 * explicit Refresh supersedes it.
 */

const LIVE_FACTS: ConversationTelemetryLiveFacts = {
  contextState: "ok",
  context: { tokens: 60000, contextWindow: 200000, percent: 30 },
};

function liveState(): ConversationTelemetryState {
  return new Map([["a", { kind: "live", agent: "a", runId: "r1", facts: LIVE_FACTS }]]);
}

function restored(observedAt: number): ReadonlyMap<string, ContextContinuityEntry> {
  return new Map([["b", { facts: { contextState: "ok", context: { tokens: 1000, contextWindow: 10000, percent: 10 } }, observedAt }]]);
}

describe("contextCardsForSelection with restored continuity (VR-4)", () => {
  it("rehydrates a restored agent as a normal concise card (no stale label)", () => {
    const cards = contextCardsForSelection({ phase: "active", audience: ["b"] }, new Map(), restored(1_000));
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.agent).toBe("b");
    expect(card.shortText).toBe("10.00%");
    // Compact card must NOT carry any restored/stale wording.
    expect(card.stateText).not.toContain("Last observed");
    expect(card.accessibleName).not.toContain("Last observed");
  });

  it("a live entry wins over a restored entry for the same agent", () => {
    const state = liveState();
    const both = contextCardsForSelection({ phase: "active", audience: ["a"] }, state, new Map([["a", { facts: LIVE_FACTS, observedAt: 5 }]]));
    expect(both[0]!.shortText).toBe("30.00%");
  });

  it("restored agents outside the audience appear after the audience", () => {
    const cards = contextCardsForSelection({ phase: "active", audience: ["a"] }, liveState(), restored(1_000));
    expect(cards.map((c) => c.agent)).toEqual(["a", "b"]);
  });

  it("read-only/no-selection surfaces have no cards even with restored entries", () => {
    expect(contextCardsForSelection({ phase: "read-only" }, new Map(), restored(1))).toEqual([]);
    expect(contextCardsForSelection({ phase: "none" }, new Map(), restored(1))).toEqual([]);
  });
});

describe("telemetryPopupViewModel restored label (VR-4)", () => {
  it("labels a rehydrated entry 'Last observed <time>' only when restored", () => {
    const entry = { kind: "live", agent: "b", runId: null, facts: { contextState: "ok", context: { tokens: 1000, contextWindow: 10000, percent: 10 } } } as const;
    const vm = telemetryPopupViewModel("b", entry, Date.UTC(2026, 7, 25, 14, 3, 22));
    const label = vm.fields.find((f) => f.label === "Last observed");
    expect(label).toEqual({ label: "Last observed", value: "14:03:22 UTC" });
  });

  it("a fresh live entry has NO restored label", () => {
    const entry = { kind: "live", agent: "a", runId: "r1", facts: LIVE_FACTS } as const;
    const vm = telemetryPopupViewModel("a", entry, undefined);
    expect(vm.fields.some((f) => f.label === "Last observed")).toBe(false);
  });
});
