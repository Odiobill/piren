/**
 * U2 + VR-1 — selected-Conversation composer interlock state machine.
 *
 * The interlock is an honest browser reflection of authoritative selected-
 * Conversation broker state (an active broker run OR a steward-scoped
 * pending approval). It is NEVER a second gateway lock: the broker's
 * at-most-one-active-run/approval authority remains the only enforcement,
 * and the browser never blocks, alters, or re-derives dispatch, approval, or
 * abort authority. Read-only inspection surfaces keep their existing
 * disabled-composer semantics, distinct from interlock.
 *
 * The visible composer text is derived from the interlock state, so an
 * UNSENT draft is preserved/restored byte-for-byte across interlock.
 *
 * VR-1 removed the sent-message acknowledgement entirely: a submitted
 * message clears from the composer immediately (before the POST resolves)
 * and its durable timeline event is the only evidence — no accepted send is
 * retained or re-shown. A send that FAILS while a REAL interlock is active
 * preserves its exact failed draft INSIDE that read-only interlock (never an
 * editable bypass) until the interlock clears; without an active interlock a
 * failure restores the exact draft immediately as editable.
 */
import { conversationActivityRunStateLabel } from "./conversation-activity.js";
import { agentDisplayName } from "./agent-display.js";

export type ComposerInterlockState =
  | { state: "editable" }
  | { state: "interlocked-draft"; draft: string };

export type ComposerInterlockEvent =
  | { type: "interlock-begin"; draft: string }
  | { type: "interlock-clear" }
  | { type: "send-rejected" }
  /** Only dispatchable while a REAL authoritative interlock is active. */
  | { type: "send-failed-interlocked"; draft: string }
  | { type: "selection-change" };

/**
 * The exact reducer transitions:
 *  1/2 interlock-begin from editable -> interlocked-draft (byte-for-byte;
 *      idempotent — an existing preserved draft is never clobbered);
 *  3   interlock-clear -> editable (component restores the draft / leaves a
 *      cleared composer empty);
 *  4   send-rejected -> editable (component restores the exact draft
 *      immediately as editable; only dispatched while not interlocked);
 *  5   send-failed-interlocked -> interlocked-draft with the EXACT failed
 *      draft, staying read-only under the real interlock until it clears;
 *  6   selection-change -> editable (discard session-only interlock state).
 */
export function reduceComposerInterlock(state: ComposerInterlockState, event: ComposerInterlockEvent): ComposerInterlockState {
  switch (event.type) {
    case "interlock-begin":
      // Idempotent: an already-interlocked composer never clobbers its draft.
      return state.state === "editable" ? { state: "interlocked-draft", draft: event.draft } : state;
    case "interlock-clear":
      return state.state === "editable" ? state : { state: "editable" };
    case "send-rejected":
      return { state: "editable" };
    case "send-failed-interlocked":
      // Preserve the byte-exact failed draft under the ACTIVE real interlock;
      // the component keeps readOnly until the authoritative interlock clears.
      return { state: "interlocked-draft", draft: event.draft };
    case "selection-change":
      return { state: "editable" };
  }
}

export function isComposerInterlocked(state: ComposerInterlockState): boolean {
  return state.state !== "editable";
}

/**
 * The exact visible textarea text: editable shows the live draft; an
 * interlocked composer shows its preserved unsent draft (never the live
 * draft, which is held separately while interlocked). VR-1: there is no
 * acknowledgement state — an accepted send is never re-shown here.
 */
export function composerInterlockVisibleText(state: ComposerInterlockState, editableText: string): string {
  switch (state.state) {
    case "editable":
      return editableText;
    case "interlocked-draft":
      return state.draft;
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
  if (approval !== undefined) return `Approval required for ${agentDisplayName(approval.agent)}`;
  const run = input.activeRuns[0];
  if (run !== undefined) return `${agentDisplayName(run.agent)} ${conversationActivityRunStateLabel(run.phase)}`;
  return null;
}

/** One neutral polite announcement on interlock clear (never a completion/failure claim). */
export const COMPOSER_INTERLOCK_CLEARED_ANNOUNCEMENT = "Composer available.";
