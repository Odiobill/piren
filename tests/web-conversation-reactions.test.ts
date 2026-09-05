import { describe, expect, it } from "vitest";
import { conversationReactionForEvent } from "../web/src/conversation-reactions.js";
import { parseConversationEventRecord, type ConversationEventRecord } from "../web/src/conversations.js";

/**
 * U5 — bounded Conversation lifecycle/status reactions (accepted 0.2.0 UX
 * plan §U5). Pure mapping of BROKER/DURABLE evidence only: `received` after
 * a durable `run_started`, and `completed`/`failed`/`cancelled` from durable
 * terminal evidence with the ACTUAL supplied terminal status, using durable
 * `runAgent` attribution. Never inferred by text, event order, activity
 * frames, or browser state; never a read/seen/delivery-to-model claim; old /
 * unknown / malformed evidence is absent safely.
 */

const CID = "20260812T000000000Z-reactions";

function event(overrides: Partial<ConversationEventRecord>): ConversationEventRecord {
  return parseConversationEventRecord({
    id: "e1",
    conversationId: CID,
    kind: "steward_message",
    authorKind: "steward",
    author: "steward",
    created: "2026-08-12T00:00:00.000Z",
    sequence: 1,
    mentions: [],
    body: "x",
    path: "collaboration/conversations/c1/events/00000001.md",
    ...overrides,
  });
}

describe("conversationReactionForEvent (pure, durable-only mapping)", () => {
  it("maps run_started with runAgent to the received reaction", () => {
    const reaction = conversationReactionForEvent(event({ kind: "run_started", authorKind: "system", author: "system", runStatus: "running", runAgent: "dipu" }));
    expect(reaction).toEqual({ kind: "received", agent: "dipu", status: "received", label: "Dipu received" });
  });

  it("maps durable terminal evidence to completed/failed/cancelled with the actual supplied status", () => {
    expect(conversationReactionForEvent(event({ kind: "run_finished", authorKind: "system", author: "system", runStatus: "completed", runAgent: "dipu" }))).toEqual({
      kind: "completed", agent: "dipu", status: "completed", label: "Dipu completed",
    });
    expect(conversationReactionForEvent(event({ kind: "run_finished", authorKind: "system", author: "system", runStatus: "failed", failureKind: "ambiguous", runAgent: "dipu" }))).toEqual({
      kind: "failed", agent: "dipu", status: "failed", label: "Dipu failed",
    });
    // A timed-out run is an explicit failure (actual status preserved).
    expect(conversationReactionForEvent(event({ kind: "run_finished", authorKind: "system", author: "system", runStatus: "timed_out", runAgent: "dipu" }))).toEqual({
      kind: "failed", agent: "dipu", status: "timed out", label: "Dipu timed out",
    });
    expect(conversationReactionForEvent(event({ kind: "run_cancelled", authorKind: "system", author: "system", runStatus: "cancelled", runAgent: "dipu" }))).toEqual({
      kind: "cancelled", agent: "dipu", status: "cancelled", label: "Dipu cancelled",
    });
  });

  it("legacy run events without runAgent are absent safely (never attributed by inference)", () => {
    for (const kind of ["run_started", "run_finished", "run_cancelled"] as const) {
      const base = event({ kind, authorKind: "system", author: "system" });
      if (kind === "run_started") base.runStatus = "running";
      if (kind === "run_finished") base.runStatus = "completed";
      if (kind === "run_cancelled") base.runStatus = "cancelled";
      expect(conversationReactionForEvent(base)).toBeNull();
    }
  });

  it("unknown/malformed evidence and non-run events are absent safely", () => {
    // Unknown terminal status: never a fabricated reaction.
    expect(conversationReactionForEvent(event({ kind: "run_finished", authorKind: "system", author: "system", runStatus: "bogus", runAgent: "dipu" }))).toBeNull();
    // Non-run kinds never carry runAgent; no reaction.
    expect(conversationReactionForEvent(event({ kind: "agent_message", authorKind: "agent", author: "dipu", body: "hi" }))).toBeNull();
    expect(conversationReactionForEvent(event({ kind: "steward_message", author: "steward", body: "hi" }))).toBeNull();
    // A forged runAgent on a non-run event is still never a reaction (kind gate).
    expect(conversationReactionForEvent(event({ kind: "agent_message", authorKind: "agent", author: "dipu", body: "hi", runAgent: "dipu" }))).toBeNull();
  });

  it("labels are bounded and never claim the agent read content", () => {
    for (const kind of ["received", "completed", "failed", "cancelled"] as const) {
      const reaction =
        kind === "received"
          ? conversationReactionForEvent(event({ kind: "run_started", authorKind: "system", author: "system", runStatus: "running", runAgent: "zai" }))
          : conversationReactionForEvent(
              event({ kind: kind === "cancelled" ? "run_cancelled" : "run_finished", authorKind: "system", author: "system", runStatus: kind === "cancelled" ? "cancelled" : kind, runAgent: "zai" }),
            );
      expect(reaction?.label).toContain("Zai");
      expect(reaction?.label).not.toMatch(/read|seen|delivered/i);
    }
  });
});
