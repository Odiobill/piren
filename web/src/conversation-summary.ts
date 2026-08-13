/**
 * P8 (§4) — collapsed bounded in-memory run summaries (accepted
 * `conversation-p8-pilot-correction-contract.md`).
 *
 * After a run settles, the browser keeps a COLLAPSED, bounded, in-memory-only
 * summary for the currently selected Conversation: the exact broker agent,
 * the actual already-permitted streamed reply text the browser already
 * displayed via U4 (if still present at the durable terminal), and the
 * truthful terminal state from the DURABLE terminal event. It is explicitly
 * NOT private reasoning, provider/model internals, fabricated progress,
 * durable state, or history/reconnect reconstruction. It is discarded on
 * selection change, browser/session closure, history reread, reconnect, and
 * stream end — never stored, never replayed from history.
 */
import type { ConversationActivityState } from "./conversation-activity.js";
import type { ConversationEventRecord } from "./conversations.js";

export interface ConversationRunSummary {
  /** Exact broker-provided agent name (bounded). */
  agent: string;
  /** Already-permitted U4 partial text the browser displayed ("" = none). */
  partial: string;
  truncated: boolean;
  /** Truthful terminal state copied from the DURABLE terminal event. */
  terminal: { runStatus: string; failureKind?: string };
}

/** Most recent run per agent; at most this many summaries in memory. */
export const CONVERSATION_RUN_SUMMARY_MAX = 4;

export function emptyConversationRunSummaries(): ConversationRunSummary[] {
  return [];
}

export function clearConversationRunSummaries(_summaries: readonly ConversationRunSummary[]): ConversationRunSummary[] {
  return [];
}

/**
 * Capture one summary at the durable terminal: the exact runAgent from the
 * terminal event (never browser inference), the already-permitted U4 partial
 * for that agent (bounded; empty records no text), and the truthful terminal
 * state. Replaces the previous summary for the same agent (most recent wins)
 * and bounds the total to the newest ≤ CONVERSATION_RUN_SUMMARY_MAX runs.
 * A terminal without a runAgent captures nothing (legacy evidence).
 */
export function captureConversationRunSummary(
  summaries: readonly ConversationRunSummary[],
  activity: ConversationActivityState,
  terminal: ConversationEventRecord,
): ConversationRunSummary[] {
  const agent = typeof terminal.runAgent === "string" && terminal.runAgent !== "" ? terminal.runAgent : null;
  if (agent === null) return [...summaries];
  const run = activity.runs.find((candidate) => candidate.agent === agent);
  const failureKind =
    typeof terminal.failureKind === "string" && terminal.failureKind !== "" ? terminal.failureKind : undefined;
  const summary: ConversationRunSummary = {
    agent,
    partial: run?.partial ?? "",
    truncated: run?.truncated ?? false,
    terminal: {
      runStatus: typeof terminal.runStatus === "string" && terminal.runStatus !== "" ? terminal.runStatus : "unknown",
      ...(failureKind !== undefined ? { failureKind } : {}),
    },
  };
  const withoutAgent = summaries.filter((candidate) => candidate.agent !== agent);
  const next = [...withoutAgent, summary];
  return next.length > CONVERSATION_RUN_SUMMARY_MAX ? next.slice(next.length - CONVERSATION_RUN_SUMMARY_MAX) : next;
}

/** Bounded non-secret terminal label from the durable terminal state only. */
export function conversationRunSummaryTerminalLabel(summary: ConversationRunSummary): string {
  if (summary.terminal.failureKind !== undefined) {
    return `Run ended ${summary.terminal.runStatus} (${summary.terminal.failureKind}).`;
  }
  return `Run ended ${summary.terminal.runStatus}.`;
}
