import { describe, expect, it } from "vitest";
import {
  HANDOFF_BUDGET_MAX_EDGES,
  HANDOFF_BUDGET_MAX_REWORK_ROUNDS,
  deriveHandoffBudget,
  validateHandoffBudgetUpdateCandidate,
  type HandoffBudgetUpdateEvidence,
} from "../src/conversation-budget.js";
import { CONVERSATION_HANDOFF_MAX_EDGES, CONVERSATION_HANDOFF_MAX_REWORK_ROUNDS } from "../src/conversation-handoff.js";

const ROOT = "20260829T120000000Z-root";

/** Valid first-update evidence fixture: raise edges 8 -> 10. */
function evidence(overrides: Partial<HandoffBudgetUpdateEvidence> = {}): HandoffBudgetUpdateEvidence {
  return {
    eventId: "u1",
    sequence: 1,
    kind: "handoff_budget_updated",
    author: "steward",
    authorKind: "steward",
    rootEventId: ROOT,
    correlationId: ROOT,
    edges: { from: CONVERSATION_HANDOFF_MAX_EDGES, to: 10 },
    ...overrides,
  };
}

describe("conversation-budget: constants and bases (B1)", () => {
  it("aligns the fixed caps and never changes the existing C5 base constants", () => {
    expect(HANDOFF_BUDGET_MAX_EDGES).toBe(24);
    expect(HANDOFF_BUDGET_MAX_REWORK_ROUNDS).toBe(6);
    expect(CONVERSATION_HANDOFF_MAX_EDGES).toBe(8);
    expect(CONVERSATION_HANDOFF_MAX_REWORK_ROUNDS).toBe(2);
  });
});

describe("conversation-budget: base/no-update derivation and threshold boundaries (B1 §3.2)", () => {
  it("derives the C5 base budget with no updates and no usage", () => {
    const derived = deriveHandoffBudget({
      rootEventId: ROOT,
      updates: [],
      usage: { consumedEdges: 0, worstPairOccurrences: 0 },
    });
    expect(derived.base).toEqual({ edges: 8, reworkRounds: 2 });
    expect(derived.effective).toEqual({ edges: 8, reworkRounds: 2 });
    expect(derived.consumedEdges).toBe(0);
    expect(derived.remainingEdges).toBe(8);
    expect(derived.worstPairOccurrences).toBe(0);
    expect(derived.remainingReworkRounds).toBe(3);
    expect(derived.validUpdateEventIds).toEqual([]);
    expect(derived.ignored).toEqual([]);
    expect(derived.low).toBe(false);
    expect(derived.exhausted).toBe(false);
  });

  it("low is exactly true at the two-remaining-edges threshold and false above it", () => {
    const at = deriveHandoffBudget({ rootEventId: ROOT, updates: [], usage: { consumedEdges: 6, worstPairOccurrences: 0 } });
    expect(at.remainingEdges).toBe(2);
    expect(at.low).toBe(true);
    expect(at.exhausted).toBe(false);
    const above = deriveHandoffBudget({ rootEventId: ROOT, updates: [], usage: { consumedEdges: 5, worstPairOccurrences: 0 } });
    expect(above.remainingEdges).toBe(3);
    expect(above.low).toBe(false);
  });

  it("exhausted is exactly true when the edges budget is fully consumed", () => {
    const at = deriveHandoffBudget({ rootEventId: ROOT, updates: [], usage: { consumedEdges: 8, worstPairOccurrences: 0 } });
    expect(at.remainingEdges).toBe(0);
    expect(at.exhausted).toBe(true);
    const overRaise = deriveHandoffBudget({
      rootEventId: ROOT,
      updates: [evidence({ eventId: "u1", edges: { from: 8, to: 10 } })],
      usage: { consumedEdges: 10, worstPairOccurrences: 0 },
    });
    expect(overRaise.effective.edges).toBe(10);
    expect(overRaise.exhausted).toBe(true);
  });

  it("low is exactly true at the one-remaining-rework threshold via the worst pair", () => {
    // base allows 1 + 2 = 3 occurrences; 2 used leaves 1 remaining (low).
    const at = deriveHandoffBudget({ rootEventId: ROOT, updates: [], usage: { consumedEdges: 0, worstPairOccurrences: 2 } });
    expect(at.remainingReworkRounds).toBe(1);
    expect(at.low).toBe(true);
    expect(at.exhausted).toBe(false);
    const above = deriveHandoffBudget({ rootEventId: ROOT, updates: [], usage: { consumedEdges: 0, worstPairOccurrences: 1 } });
    expect(above.remainingReworkRounds).toBe(2);
    expect(above.low).toBe(false);
  });
});

describe("conversation-budget: valid sequential updates (B1 §3.2)", () => {
  it("applies a valid single-dimension edges raise", () => {
    const derived = deriveHandoffBudget({
      rootEventId: ROOT,
      updates: [evidence({ eventId: "u1", sequence: 1, edges: { from: 8, to: 12 } })],
      usage: { consumedEdges: 9, worstPairOccurrences: 0 },
    });
    expect(derived.effective).toEqual({ edges: 12, reworkRounds: 2 });
    expect(derived.validUpdateEventIds).toEqual(["u1"]);
    expect(derived.ignored).toEqual([]);
    expect(derived.remainingEdges).toBe(3);
    expect(derived.exhausted).toBe(false);
  });

  it("applies a valid rework-only raise", () => {
    const derived = deriveHandoffBudget({
      rootEventId: ROOT,
      updates: [evidence({ eventId: "u1", sequence: 1, edges: undefined, reworkRounds: { from: 2, to: 4 } })],
      usage: { consumedEdges: 0, worstPairOccurrences: 4 },
    });
    expect(derived.effective).toEqual({ edges: 8, reworkRounds: 4 });
    expect(derived.remainingReworkRounds).toBe(1);
    expect(derived.validUpdateEventIds).toEqual(["u1"]);
  });

  it("applies both dimensions in one update and chains subsequent updates per dimension", () => {
    const derived = deriveHandoffBudget({
      rootEventId: ROOT,
      updates: [
        evidence({ eventId: "u1", sequence: 1, edges: { from: 8, to: 10 }, reworkRounds: { from: 2, to: 3 } }),
        evidence({ eventId: "u2", sequence: 2, edges: { from: 10, to: 11 }, reworkRounds: undefined }),
        evidence({ eventId: "u3", sequence: 3, edges: undefined, reworkRounds: { from: 3, to: 5 } }),
      ],
      usage: { consumedEdges: 11, worstPairOccurrences: 5 },
    });
    expect(derived.effective).toEqual({ edges: 11, reworkRounds: 5 });
    expect(derived.validUpdateEventIds).toEqual(["u1", "u2", "u3"]);
    expect(derived.remainingEdges).toBe(0);
    expect(derived.exhausted).toBe(true);
    expect(derived.remainingReworkRounds).toBe(1);
    expect(derived.low).toBe(true);
  });

  it("applies updates in durable sequence order regardless of input order", () => {
    const derived = deriveHandoffBudget({
      rootEventId: ROOT,
      updates: [
        evidence({ eventId: "u2", sequence: 2, edges: { from: 10, to: 12 } }),
        evidence({ eventId: "u1", sequence: 1, edges: { from: 8, to: 10 } }),
      ],
      usage: { consumedEdges: 0, worstPairOccurrences: 0 },
    });
    expect(derived.effective.edges).toBe(12);
    expect(derived.validUpdateEventIds).toEqual(["u1", "u2"]);
  });

  it("carries an unmentioned dimension forward and applies the raised one", () => {
    const derived = deriveHandoffBudget({
      rootEventId: ROOT,
      updates: [evidence({ eventId: "u1", sequence: 1, edges: undefined, reworkRounds: { from: 2, to: 3 } })],
      usage: { consumedEdges: 0, worstPairOccurrences: 0 },
    });
    expect(derived.effective).toEqual({ edges: 8, reworkRounds: 3 });
  });
});

describe("conversation-budget: fail-closed evidence (B1 §3.2)", () => {
  function deriveWith(update: Partial<HandoffBudgetUpdateEvidence>, prior?: HandoffBudgetUpdateEvidence) {
    return deriveHandoffBudget({
      rootEventId: ROOT,
      updates: prior ? [prior, evidence({ eventId: "u2", sequence: 2, ...update })] : [evidence(update)],
      usage: { consumedEdges: 0, worstPairOccurrences: 0 },
    });
  }

  it("ignores a stale from value and never widens or lowers", () => {
    // Hand-edited lower attempt: from 8 while a prior update already moved the
    // effective value to 10 — ignored, effective stays 10.
    const stale = deriveWith({ edges: { from: 8, to: 12 } }, evidence({ eventId: "u1", edges: { from: 8, to: 10 } }));
    expect(stale.effective).toEqual({ edges: 10, reworkRounds: 2 });
    expect(stale.validUpdateEventIds).toEqual(["u1"]);
    expect(stale.ignored).toHaveLength(1);
    expect(stale.ignored[0]?.eventId).toBe("u2");
    expect(stale.ignored[0]?.reason).toContain("from");
  });

  it("ignores a hand-edited non-raising (lowering) update", () => {
    const lowered = deriveWith({ edges: { from: 8, to: 6 } });
    expect(lowered.effective).toEqual({ edges: 8, reworkRounds: 2 });
    expect(lowered.ignored).toHaveLength(1);
    expect(lowered.ignored[0]?.reason).toContain("raise");
  });

  it("ignores a cap violation", () => {
    const capped = deriveWith({ edges: { from: 8, to: HANDOFF_BUDGET_MAX_EDGES + 1 } });
    expect(capped.effective).toEqual({ edges: 8, reworkRounds: 2 });
    expect(capped.ignored).toHaveLength(1);
    expect(capped.ignored[0]?.reason).toContain("cap");
  });

  it("ignores malformed values: non-integer, non-finite, wrong type", () => {
    for (const bad of [1.5, NaN, Infinity, "10", null]) {
      const malformed = deriveWith({ edges: { from: 8, to: bad as number } });
      expect(malformed.effective).toEqual({ edges: 8, reworkRounds: 2 });
      expect(malformed.ignored).toHaveLength(1);
    }
    const badFrom = deriveWith({ edges: { from: "8" as unknown as number, to: 10 } });
    expect(badFrom.effective).toEqual({ edges: 8, reworkRounds: 2 });
    expect(badFrom.ignored).toHaveLength(1);
  });

  it("ignores an update with no dimension at all", () => {
    const empty = deriveWith({ edges: undefined, reworkRounds: undefined });
    expect(empty.effective).toEqual({ edges: 8, reworkRounds: 2 });
    expect(empty.ignored).toHaveLength(1);
  });

  it("ignores evidence with a wrong root, correlation, author, author kind, or event kind", () => {
    const wrongRoot = deriveWith({ rootEventId: "other-root" });
    expect(wrongRoot.effective).toEqual({ edges: 8, reworkRounds: 2 });
    expect(wrongRoot.ignored).toHaveLength(1);

    const wrongCorrelation = deriveWith({ correlationId: "other-root" });
    expect(wrongCorrelation.effective).toEqual({ edges: 8, reworkRounds: 2 });
    expect(wrongCorrelation.ignored).toHaveLength(1);

    const wrongAuthor = deriveWith({ author: "someone-else" });
    expect(wrongAuthor.effective).toEqual({ edges: 8, reworkRounds: 2 });
    expect(wrongAuthor.ignored).toHaveLength(1);
    expect(wrongAuthor.ignored[0]?.reason).toContain("steward");
    expect(wrongAuthor.ignored[0]?.reason).not.toContain("someone-else");

    const wrongAuthorKind = deriveWith({ authorKind: "agent" });
    expect(wrongAuthorKind.effective).toEqual({ edges: 8, reworkRounds: 2 });
    expect(wrongAuthorKind.ignored).toHaveLength(1);

    const wrongKind = deriveWith({ kind: "agent_message" });
    expect(wrongKind.effective).toEqual({ edges: 8, reworkRounds: 2 });
    expect(wrongKind.ignored).toHaveLength(1);
  });

  it("treats a duplicate/replay as idempotent: the budget is applied exactly once", () => {
    const replayed = deriveHandoffBudget({
      rootEventId: ROOT,
      updates: [
        evidence({ eventId: "u1", sequence: 1, edges: { from: 8, to: 10 } }),
        evidence({ eventId: "u1-replay", sequence: 2, edges: { from: 8, to: 10 } }),
      ],
      usage: { consumedEdges: 0, worstPairOccurrences: 0 },
    });
    expect(replayed.effective).toEqual({ edges: 10, reworkRounds: 2 });
    expect(replayed.validUpdateEventIds).toEqual(["u1"]);
    expect(replayed.ignored).toHaveLength(1);
    expect(replayed.ignored[0]?.eventId).toBe("u1-replay");
  });

  it("ignores evidence with a malformed event id or sequence but keeps derivations stable", () => {
    const badId = deriveWith({ eventId: "" });
    expect(badId.effective).toEqual({ edges: 8, reworkRounds: 2 });
    expect(badId.ignored).toHaveLength(1);

    const badSequence = deriveWith({ sequence: 0 });
    expect(badSequence.effective).toEqual({ edges: 8, reworkRounds: 2 });
    expect(badSequence.ignored).toHaveLength(1);
  });

  it("a mid-chain failure never blocks later valid updates for the untouched dimension", () => {
    const derived = deriveHandoffBudget({
      rootEventId: ROOT,
      updates: [
        evidence({ eventId: "u1", sequence: 1, edges: { from: 8, to: 10 } }),
        // u2 is stale for edges (from 8) but carries a valid rework raise from 2.
        evidence({ eventId: "u2", sequence: 2, edges: { from: 8, to: 11 }, reworkRounds: { from: 2, to: 3 } }),
        // u3 is a valid edges raise on top of the still-effective 10.
        evidence({ eventId: "u3", sequence: 3, edges: { from: 10, to: 11 } }),
      ],
      usage: { consumedEdges: 0, worstPairOccurrences: 0 },
    });
    // u2 failed as a whole (one failing dimension fails the event); u3 applies.
    expect(derived.effective).toEqual({ edges: 11, reworkRounds: 2 });
    expect(derived.validUpdateEventIds).toEqual(["u1", "u3"]);
    expect(derived.ignored.map((i) => i.eventId)).toEqual(["u2"]);
  });
});

describe("conversation-budget: duplicate durable identity/order fail closed (B1 correction)", () => {
  it("a replayed eventId at a later sequence with a chained from never produces a second raise", () => {
    const replayed = deriveHandoffBudget({
      rootEventId: ROOT,
      updates: [
        evidence({ eventId: "u1", sequence: 1, edges: { from: 8, to: 10 } }),
        evidence({ eventId: "u1", sequence: 2, edges: { from: 10, to: 12 } }),
      ],
      usage: { consumedEdges: 0, worstPairOccurrences: 0 },
    });
    // Durable identity is one record: both occurrences are rejected as a
    // group (safe fail-closed policy) and the budget never widens.
    expect(replayed.effective).toEqual({ edges: 8, reworkRounds: 2 });
    expect(replayed.validUpdateEventIds).toEqual([]);
    expect(replayed.ignored.map((i) => i.eventId).sort()).toEqual(["u1", "u1"]);
    for (const entry of replayed.ignored) {
      expect(entry.reason).toContain("duplicate");
    }
  });

  it("conflicting records at the same valid sequence reject the whole sequence regardless of input order", () => {
    const updates = [
      evidence({ eventId: "u1", sequence: 1, edges: { from: 8, to: 10 } }),
      evidence({ eventId: "u2", sequence: 1, edges: { from: 8, to: 12 } }),
    ];
    const forward = deriveHandoffBudget({ rootEventId: ROOT, updates, usage: { consumedEdges: 0, worstPairOccurrences: 0 } });
    const backward = deriveHandoffBudget({
      rootEventId: ROOT,
      updates: [...updates].reverse(),
      usage: { consumedEdges: 0, worstPairOccurrences: 0 },
    });
    for (const derived of [forward, backward]) {
      expect(derived.effective).toEqual({ edges: 8, reworkRounds: 2 });
      expect(derived.validUpdateEventIds).toEqual([]);
      expect(derived.ignored).toHaveLength(2);
      for (const entry of derived.ignored) {
        expect(entry.reason).toContain("sequence");
      }
    }
    expect(forward.ignored.map((i) => i.eventId).sort()).toEqual(backward.ignored.map((i) => i.eventId).sort());
  });

  it("later valid uniquely identified and ordered evidence still applies after an unrelated duplicate group", () => {
    const derived = deriveHandoffBudget({
      rootEventId: ROOT,
      updates: [
        evidence({ eventId: "u1", sequence: 1, edges: { from: 8, to: 10 } }),
        evidence({ eventId: "u1", sequence: 2, edges: { from: 10, to: 12 } }),
        evidence({ eventId: "u3", sequence: 3, edges: undefined, reworkRounds: { from: 2, to: 3 } }),
      ],
      usage: { consumedEdges: 0, worstPairOccurrences: 0 },
    });
    // The u1 group is rejected; u3 is uniquely identified/ordered and applies.
    expect(derived.effective).toEqual({ edges: 8, reworkRounds: 3 });
    expect(derived.validUpdateEventIds).toEqual(["u3"]);
    expect(derived.ignored.map((i) => i.eventId)).toEqual(["u1", "u1"]);
  });

  it("the full derived result including ignored metadata is deep-equal under reversed caller order (deterministic total ordering)", () => {
    const updates = [
      evidence({ eventId: "u1", sequence: 1, edges: { from: 8, to: 10 } }),
      evidence({ eventId: "u2", sequence: 1, edges: { from: 8, to: 12 } }),
      evidence({ eventId: "u3", sequence: -1, edges: { from: 8, to: 11 } }),
      evidence({ eventId: "u4", sequence: 2, edges: undefined, reworkRounds: { from: 2, to: 9 } }),
    ];
    const forward = deriveHandoffBudget({ rootEventId: ROOT, updates, usage: { consumedEdges: 0, worstPairOccurrences: 0 } });
    const backward = deriveHandoffBudget({
      rootEventId: ROOT,
      updates: [...updates].reverse(),
      usage: { consumedEdges: 0, worstPairOccurrences: 0 },
    });
    // The ENTIRE derived result — effective values, valid ids, and the full
    // ignored metadata in order — must be deterministic, not merely the
    // effective limits or the ignored ids after sorting.
    expect(backward).toEqual(forward);
  });

  it("reasons never echo the conflicting values", () => {
    const derived = deriveHandoffBudget({
      rootEventId: ROOT,
      updates: [
        evidence({ eventId: "u1", sequence: 1, edges: { from: 8, to: 10 } }),
        evidence({ eventId: "u2", sequence: 1, edges: { from: 8, to: 24 } }),
      ],
      usage: { consumedEdges: 0, worstPairOccurrences: 0 },
    });
    const reasons = derived.ignored.map((i) => i.reason).join("\n");
    expect(reasons).not.toContain("24");
  });
});

describe("conversation-budget: candidate validation (B1 §2.2)", () => {
  it("accepts a valid single- and both-dimension raise within caps", () => {
    const edges = validateHandoffBudgetUpdateCandidate({ candidate: { edges: 12 }, current: { edges: 8, reworkRounds: 2 } });
    expect(edges.ok).toBe(true);
    if (edges.ok) expect(edges.edges).toBe(12);
    const both = validateHandoffBudgetUpdateCandidate({
      candidate: { edges: 10, reworkRounds: 4 },
      current: { edges: 8, reworkRounds: 2 },
    });
    expect(both.ok).toBe(true);
  });

  it("rejects a candidate with no dimension", () => {
    const result = validateHandoffBudgetUpdateCandidate({ candidate: {}, current: { edges: 8, reworkRounds: 2 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("dimension");
  });

  it("rejects non-raising and equal values", () => {
    const lower = validateHandoffBudgetUpdateCandidate({ candidate: { edges: 6 }, current: { edges: 8, reworkRounds: 2 } });
    expect(lower.ok).toBe(false);
    const equal = validateHandoffBudgetUpdateCandidate({ candidate: { edges: 8 }, current: { edges: 8, reworkRounds: 2 } });
    expect(equal.ok).toBe(false);
  });

  it("rejects invalid numbers: non-integer, non-finite, wrong type, non-positive", () => {
    for (const bad of [1.5, NaN, Infinity, "10", null, 0, -2]) {
      const result = validateHandoffBudgetUpdateCandidate({
        candidate: { edges: bad as number },
        current: { edges: 8, reworkRounds: 2 },
      });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects cap violations without clamping", () => {
    const overEdges = validateHandoffBudgetUpdateCandidate({
      candidate: { edges: HANDOFF_BUDGET_MAX_EDGES + 1 },
      current: { edges: 8, reworkRounds: 2 },
    });
    expect(overEdges.ok).toBe(false);
    if (!overEdges.ok) expect(overEdges.reason).toContain("cap");
    const overRework = validateHandoffBudgetUpdateCandidate({
      candidate: { reworkRounds: HANDOFF_BUDGET_MAX_REWORK_ROUNDS + 1 },
      current: { edges: 8, reworkRounds: 2 },
    });
    expect(overRework.ok).toBe(false);
    if (!overRework.ok) expect(overRework.reason).toContain("cap");
  });

  it("accepts a raise exactly to the cap", () => {
    const result = validateHandoffBudgetUpdateCandidate({
      candidate: { edges: HANDOFF_BUDGET_MAX_EDGES },
      current: { edges: 8, reworkRounds: 2 },
    });
    expect(result.ok).toBe(true);
  });

  it("never leaks the rejected candidate value in a rejection reason", () => {
    const secret = "candidate-secret-must-not-appear";
    const result = validateHandoffBudgetUpdateCandidate({
      candidate: { edges: secret as unknown as number },
      current: { edges: 8, reworkRounds: 2 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain(secret);
  });
});

describe("conversation-budget: rework-only pressure stays non-red (B1 §2.4/§6)", () => {
  it("a fully exhausted rework pair is low but never red while edges remain", () => {
    // base allows 3 occurrences of a pair; 3 used exhausts that pair.
    const derived = deriveHandoffBudget({
      rootEventId: ROOT,
      updates: [],
      usage: { consumedEdges: 2, worstPairOccurrences: 3 },
    });
    expect(derived.remainingReworkRounds).toBe(0);
    expect(derived.low).toBe(true);
    expect(derived.exhausted).toBe(false);
  });

  it("a rework raise relieves the pressure without touching edges", () => {
    const derived = deriveHandoffBudget({
      rootEventId: ROOT,
      updates: [evidence({ eventId: "u1", edges: undefined, reworkRounds: { from: 2, to: 4 } })],
      usage: { consumedEdges: 2, worstPairOccurrences: 4 },
    });
    expect(derived.effective).toEqual({ edges: 8, reworkRounds: 4 });
    expect(derived.remainingReworkRounds).toBe(1);
    expect(derived.low).toBe(true);
    expect(derived.exhausted).toBe(false);
  });

  it("low may be true together with exhausted (UI precedence masks it), but exhaustion is edges-only", () => {
    const derived = deriveHandoffBudget({
      rootEventId: ROOT,
      updates: [],
      usage: { consumedEdges: 8, worstPairOccurrences: 3 },
    });
    expect(derived.exhausted).toBe(true);
    expect(derived.remainingEdges).toBe(0);
  });
});
