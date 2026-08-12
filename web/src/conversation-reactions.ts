/**
 * U5 — bounded Conversation lifecycle/status reactions (accepted 0.2.0 UX
 * plan §U5).
 *
 * A small pure status-mapping core over DURABLE broker evidence only:
 * `received` after a durable `run_started`, and `completed` / `failed` /
 * `cancelled` from durable terminal evidence (`run_finished` /
 * `run_cancelled`) with the ACTUAL supplied terminal status, using the U4
 * durable `runAgent` attribution. Status is never inferred from text, event
 * order, activity frames, or browser state; nothing here ever claims an
 * agent read, saw, or was delivered content. Old/unknown/malformed evidence
 * (no `runAgent`, unknown `runStatus`, non-run kinds) is absent safely —
 * never a fabricated reaction. Reactions are presentation-only: they never
 * write, mutate, or fabricate durable history and never appear as arbitrary
 * user/agent-authored emoji.
 */
import type { ConversationEventRecord } from "./conversations.js";

export type ConversationReactionKind = "received" | "completed" | "failed" | "cancelled";

export interface ConversationReaction {
  kind: ConversationReactionKind;
  /** Durable `runAgent` attribution (the broker's exact run agent). */
  agent: string;
  /** Bounded truthful status word (the actual supplied durable status). */
  status: "received" | "completed" | "failed" | "timed out" | "cancelled";
  /** Accessible label, e.g. "dipu completed". */
  label: string;
}

/**
 * Map one durable Conversation event to its bounded status reaction, or null
 * when the evidence cannot truthfully attribute a status (legacy records
 * without `runAgent`, unknown terminal statuses, non-run kinds).
 */
export function conversationReactionForEvent(event: ConversationEventRecord): ConversationReaction | null {
  const agent = event.runAgent;
  if (typeof agent !== "string" || agent === "") return null;
  if (event.kind === "run_started") {
    return { kind: "received", agent, status: "received", label: `${agent} received` };
  }
  if (event.kind === "run_finished") {
    if (event.runStatus === "completed") {
      return { kind: "completed", agent, status: "completed", label: `${agent} completed` };
    }
    if (event.runStatus === "failed") {
      return { kind: "failed", agent, status: "failed", label: `${agent} failed` };
    }
    if (event.runStatus === "timed_out") {
      return { kind: "failed", agent, status: "timed out", label: `${agent} timed out` };
    }
    return null;
  }
  if (event.kind === "run_cancelled") {
    return { kind: "cancelled", agent, status: "cancelled", label: `${agent} cancelled` };
  }
  return null;
}
