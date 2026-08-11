import { describe, expect, it } from "vitest";
import {
  applyConversationActivityFrame,
  clearConversationActivity,
  clearConversationActivityForAgent,
  CONVERSATION_ACTIVITY_DELTA_MAX,
  CONVERSATION_ACTIVITY_PARTIAL_MAX,
  emptyConversationActivity,
  parseConversationActivityFrame,
  reconcileConversationActivity,
  type ConversationActivityFrame,
  type ConversationActivityState,
} from "../web/src/conversation-activity.js";
import { parseConversationEventRecord, type ConversationEventRecord } from "../web/src/conversations.js";

/**
 * U4 — broker-authoritative live activity web core (accepted
 * `conversation-live-activity-contract.md`). Strict fail-closed frame
 * parsing, per-run transient state (working → typing → settled), bounded
 * partial-reply accumulation with a truthful truncation marker, and durable
 * reconciliation (agent_message / terminal evidence clears transient state).
 * Activity is NEVER reconstructed from history and never becomes durable.
 */

const CID = "20260811T000000000Z-live";

function frame(kind: "working" | "text_delta" | "settled", overrides: Partial<ConversationActivityFrame> = {}): ConversationActivityFrame {
  const base: ConversationActivityFrame = { conversationId: CID, runId: "run-0001", agent: "dipu", kind };
  if (kind === "text_delta") base.delta = "Hel";
  if (kind === "settled") base.outcome = "completed";
  return { ...base, ...overrides };
}

describe("parseConversationActivityFrame (strict, fail-closed)", () => {
  it("accepts valid working/text_delta/settled frames for the selected conversation", () => {
    expect(parseConversationActivityFrame(frame("working"), CID).ok).toBe(true);
    const delta = parseConversationActivityFrame(frame("text_delta"), CID);
    expect(delta.ok && delta.frame.delta).toBe("Hel");
    const settled = parseConversationActivityFrame(frame("settled"), CID);
    expect(settled.ok && settled.frame.outcome).toBe("completed");
  });

  it("rejects foreign conversations, malformed fields, unknown kinds, and forbidden combinations", () => {
    expect(parseConversationActivityFrame(frame("working"), "other-id").ok).toBe(false);
    for (const bad of [
      {},
      { conversationId: CID, runId: "", agent: "dipu", kind: "working" },
      { conversationId: CID, runId: "run-1", agent: "", kind: "working" },
      { conversationId: CID, runId: "run-1", agent: "dipu", kind: "bogus" },
      { ...frame("working"), delta: "x" }, // working must not carry delta
      { ...frame("working"), outcome: "completed" }, // working must not carry outcome
      { ...frame("text_delta"), delta: "" }, // empty delta
      { ...frame("text_delta"), delta: "x".repeat(CONVERSATION_ACTIVITY_DELTA_MAX + 1) }, // oversized
      { ...frame("text_delta"), outcome: "completed" }, // text_delta must not carry outcome
      { ...frame("settled"), delta: "x" }, // settled must not carry delta
      { ...frame("settled"), outcome: "bogus" }, // unknown outcome
    ]) {
      expect(parseConversationActivityFrame(bad, CID).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("transient activity state machine (per-run)", () => {
  it("working sets a working run; the first text_delta flips it to typing and accumulates the exact deltas", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1" }));
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({ runId: "r1", agent: "dipu", phase: "working", partial: "" });

    state = applyConversationActivityFrame(state, frame("text_delta", { runId: "r1", delta: "Hel" }));
    state = applyConversationActivityFrame(state, frame("text_delta", { runId: "r1", delta: "lo" }));
    expect(state.runs[0]).toMatchObject({ runId: "r1", phase: "typing", partial: "Hello" });
  });

  it("settled clears exactly that run and leaves other runs alone", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1" }));
    state = applyConversationActivityFrame(state, frame("working", { runId: "r2", agent: "zai" }));
    state = applyConversationActivityFrame(state, frame("settled", { runId: "r1" }));
    expect(state.runs.map((run) => run.runId)).toEqual(["r2"]);
  });

  it("a text_delta without a preceding working frame still shows truthful typing (tolerates lost frames)", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("text_delta", { runId: "r3", delta: "Hi" }));
    expect(state.runs[0]).toMatchObject({ runId: "r3", phase: "typing", partial: "Hi" });
  });

  it("caps the accumulated partial at the bounded limit with a truthful truncation marker", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1" }));
    const chunk = "a".repeat(100);
    for (let index = 0; index < CONVERSATION_ACTIVITY_PARTIAL_MAX / 100 + 2; index += 1) {
      state = applyConversationActivityFrame(state, frame("text_delta", { runId: "r1", delta: chunk }));
    }
    const run = state.runs[0];
    expect(run?.partial.length).toBeLessThanOrEqual(CONVERSATION_ACTIVITY_PARTIAL_MAX);
    expect(run?.truncated).toBe(true);
    // Excess live text is never fabricated or persisted beyond the cap.
    expect(run?.partial).toBe("a".repeat(CONVERSATION_ACTIVITY_PARTIAL_MAX));
  });
});

describe("durable reconciliation (transient is never promoted)", () => {
  it("a durable agent_message for the agent replaces/clears that transient partial", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1" }));
    state = applyConversationActivityFrame(state, frame("text_delta", { runId: "r1", delta: "partial" }));
    const event: ConversationEventRecord = {
      id: "e1", conversationId: CID, kind: "agent_message", authorKind: "agent", author: "dipu",
      created: "2026-08-11T00:00:00.000Z", sequence: 5, mentions: [], body: "final", path: "p",
    };
    state = reconcileConversationActivity(state, event);
    expect(state.runs).toHaveLength(0);
  });

  it("a durable terminal with runAgent clears the remaining activity for that agent", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1" }));
    const event = parseConversationEventRecord({
      id: "e2", conversationId: CID, kind: "run_finished", authorKind: "system", author: "system",
      created: "2026-08-11T00:00:00.000Z", sequence: 6, mentions: [], body: "done", path: "p",
      runStatus: "completed", runAgent: "dipu",
    });
    state = reconcileConversationActivity(state, event);
    expect(state.runs).toHaveLength(0);
  });

  it("unrelated events and legacy terminals without runAgent leave activity untouched", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1" }));
    const unrelated = parseConversationEventRecord({
      id: "e3", conversationId: CID, kind: "steward_message", authorKind: "steward", author: "steward",
      created: "2026-08-11T00:00:00.000Z", sequence: 7, mentions: [], body: "hi", path: "p",
    });
    const legacyTerminal = parseConversationEventRecord({
      id: "e4", conversationId: CID, kind: "run_finished", authorKind: "system", author: "system",
      created: "2026-08-11T00:00:00.000Z", sequence: 8, mentions: [], body: "done", path: "p",
      runStatus: "completed",
    });
    state = reconcileConversationActivity(state, unrelated);
    state = reconcileConversationActivity(state, legacyTerminal);
    expect(state.runs).toHaveLength(1);
  });

  it("clearConversationActivityForAgent removes only the named agent", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1", agent: "dipu" }));
    state = applyConversationActivityFrame(state, frame("working", { runId: "r2", agent: "zai" }));
    state = clearConversationActivityForAgent(state, "dipu");
    expect(state.runs.map((run) => run.agent)).toEqual(["zai"]);
  });
});

describe("runAgent durable metadata parsing (U4)", () => {
  it("parses runAgent on run events and tolerates absent values on old records", () => {
    const withAgent = parseConversationEventRecord({
      id: "e5", conversationId: CID, kind: "run_finished", authorKind: "system", author: "system",
      created: "2026-08-11T00:00:00.000Z", sequence: 9, mentions: [], body: "done", path: "p",
      runStatus: "completed", runAgent: "dipu",
    });
    expect(withAgent.runAgent).toBe("dipu");
    const legacy = parseConversationEventRecord({
      id: "e6", conversationId: CID, kind: "run_started", authorKind: "system", author: "system",
      created: "2026-08-11T00:00:00.000Z", sequence: 10, mentions: [], body: "start", path: "p",
      runStatus: "running",
    });
    expect(legacy.runAgent).toBeUndefined();
  });

  it("rejects a present-but-invalid runAgent fail-closed", () => {
    expect(() =>
      parseConversationEventRecord({
        id: "e7", conversationId: CID, kind: "run_started", authorKind: "system", author: "system",
        created: "2026-08-11T00:00:00.000Z", sequence: 11, mentions: [], body: "start", path: "p",
        runStatus: "running", runAgent: 42,
      }),
    ).toThrow(/runAgent/);
    expect(() =>
      parseConversationEventRecord({
        id: "e8", conversationId: CID, kind: "run_cancelled", authorKind: "system", author: "system",
        created: "2026-08-11T00:00:00.000Z", sequence: 12, mentions: [], body: "cancel", path: "p",
        runStatus: "cancelled", runAgent: "",
      }),
    ).toThrow(/runAgent/);
  });
});

describe("fail-closed invalid/stale/contradictory activity (U4 correction)", () => {
  it("clearConversationActivity removes every transient run while keeping settled tombstones", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1" }));
    state = applyConversationActivityFrame(state, frame("settled", { runId: "r1" }));
    state = applyConversationActivityFrame(state, frame("working", { runId: "r2", agent: "zai" }));
    const cleared = clearConversationActivity(state);
    expect(cleared.runs).toHaveLength(0);
    expect(cleared.settled).toContain("r1");
  });

  it("a delayed working/text_delta for a settled run is stale and never resurrects it", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1" }));
    state = applyConversationActivityFrame(state, frame("text_delta", { runId: "r1", delta: "Hel" }));
    state = applyConversationActivityFrame(state, frame("settled", { runId: "r1" }));
    expect(state.runs).toHaveLength(0);
    // Delayed frames for the settled run are ignored (no typing recreation).
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1" }));
    expect(state.runs).toHaveLength(0);
    state = applyConversationActivityFrame(state, frame("text_delta", { runId: "r1", delta: "late" }));
    expect(state.runs).toHaveLength(0);
    // A fresh, never-settled runId still shows truthful typing.
    state = applyConversationActivityFrame(state, frame("text_delta", { runId: "r9", delta: "fresh" }));
    expect(state.runs[0]).toMatchObject({ runId: "r9", phase: "typing", partial: "fresh" });
  });

  it("a structurally valid frame with a different agent for a known runId is contradictory and clears activity", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1", agent: "dipu" }));
    state = applyConversationActivityFrame(state, frame("text_delta", { runId: "r1", agent: "dipu", delta: "Hel" }));
    // Same runId, different agent: contradictory evidence — fail closed.
    state = applyConversationActivityFrame(state, frame("text_delta", { runId: "r1", agent: "zai", delta: "x" }));
    expect(state.runs).toHaveLength(0);
    // A later consistent working frame for the same runId/agent starts fresh.
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1", agent: "dipu" }));
    expect(state.runs[0]).toMatchObject({ runId: "r1", agent: "dipu", phase: "working" });
  });

  it("settled tombstones are bounded (never unbounded memory)", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    for (let index = 0; index < 100; index += 1) {
      const runId = `run-${String(index).padStart(4, "0")}`;
      state = applyConversationActivityFrame(state, frame("working", { runId }));
      state = applyConversationActivityFrame(state, frame("settled", { runId }));
    }
    expect(state.settled.length).toBeLessThanOrEqual(32);
    // The earliest tombstone was dropped; the newest ones are retained.
    expect(state.settled).toContain("run-0099");
    expect(state.settled).not.toContain("run-0000");
  });
});
