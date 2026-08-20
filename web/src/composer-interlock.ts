/**
 * U2 — selected-Conversation composer interlock state machine (0.2.0
 * amendment §6.2).
 *
 * The interlock is an honest browser reflection of authoritative selected-
 * Conversation broker state (an active broker run OR a steward-scoped
 * pending approval). It is NEVER a second gateway lock: the broker's
 * at-most-one-active-run/approval authority remains the only enforcement,
 * and the browser never blocks, alters, or re-derives dispatch, approval, or
 * abort authority. Read-only inspection surfaces keep their existing
 * disabled-composer semantics, distinct from interlock.
 *
 * The visible composer text is derived from the interlock state, so the
 * draft is preserved/restored byte-for-byte across interlock and a send
 * acknowledgement is retained read-only (never resendable) until the
 * interlock clears.
 */
import { conversationActivityRunStateLabel } from "./conversation-activity.js";

export type ComposerInterlockState =
  | { state: "editable" }
  | { state: "interlocked-draft"; draft: string }
  | { state: "interlocked-ack"; ack: string };

export type ComposerInterlockEvent =
  | { type: "interlock-begin"; draft: string }
  | { type: "interlock-clear" }
  | { type: "send-accepted"; text: string; interlockFollows: boolean }
  | { type: "send-rejected" }
  | { type: "selection-change" };

/**
 * The exact 8-transition reducer (§6.2):
 *  1/2 interlock-begin from editable -> interlocked-draft (byte-for-byte);
 *  3   send-accepted with interlockFollows -> interlocked-ack;
 *  4   send-accepted without interlock -> editable (clear-on-success);
 *  5   send-rejected -> editable (draft stays editable);
 *  6/7 interlock-clear -> editable (component restores draft / clears ack);
 *  8   selection-change -> editable (discard session-only interlock/ack).
 */
export function reduceComposerInterlock(state: ComposerInterlockState, event: ComposerInterlockEvent): ComposerInterlockState {
  switch (event.type) {
    case "interlock-begin":
      // Idempotent: an already-interlocked composer never clobbers its draft.
      return state.state === "editable" ? { state: "interlocked-draft", draft: event.draft } : state;
    case "interlock-clear":
      return state.state === "editable" ? state : { state: "editable" };
    case "send-accepted":
      return event.interlockFollows ? { state: "interlocked-ack", ack: event.text } : { state: "editable" };
    case "send-rejected":
      return { state: "editable" };
    case "selection-change":
      return { state: "editable" };
  }
}

export function isComposerInterlocked(state: ComposerInterlockState): boolean {
  return state.state !== "editable";
}

/**
 * The exact visible textarea text: editable shows the live draft; an
 * interlocked composer shows its preserved draft or read-only acknowledgement
 * (never the live draft, which is held separately while interlocked).
 */
export function composerInterlockVisibleText(state: ComposerInterlockState, editableText: string): string {
  switch (state.state) {
    case "editable":
      return editableText;
    case "interlocked-draft":
      return state.draft;
    case "interlocked-ack":
      return state.ack;
  }
}

/**
 * The specific visible reason referenced by aria-describedby while
 * interlocked. A pending approval (actionable) takes precedence; otherwise
 * the first active run's truthful working/typing line. Null means not
 * interlocked.
 */
export function composeInterlockReason(input: {
  activeRuns: readonly { agent: string; phase: "working" | "typing" }[];
  approvals: readonly { agent: string }[];
}): string | null {
  const approval = input.approvals[0];
  if (approval !== undefined) return `Approval required for ${approval.agent}`;
  const run = input.activeRuns[0];
  if (run !== undefined) return `${run.agent} ${conversationActivityRunStateLabel(run.phase)}`;
  return null;
}

/** One neutral polite announcement on interlock clear (never a completion/failure claim). */
export const COMPOSER_INTERLOCK_CLEARED_ANNOUNCEMENT = "Composer available.";
