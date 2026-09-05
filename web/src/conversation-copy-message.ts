/**
 * W4 — pure core for the copy control on durable Conversation message cards
 * (accepted workbench-copy-conversation-message-contract.md,
 * accepted-steward-resolved). No React, no clipboard call, no DOM: pure
 * eligibility/payload/naming/feedback-state logic only.
 *
 * Normative points encoded here:
 * - Only ordinary durable `steward_message` and NON-handoff `agent_message`
 *   transcript rows are eligible. C5 handoff rows (durable agent_message
 *   rendering as `transcript-handoff`) are BINDINGLY excluded, as are all
 *   system/lifecycle/run/approval/tool/error/start-origin rows.
 * - The payload is exactly the canonical stored body (including its
 *   Markdown source) — never a rendered/DOM projection or enriched text.
 * - Feedback is per-card session-only state: success is transient with the
 *   steward-resolved 2-second duration; failure stays until the next
 *   deliberate gesture or cleanup and carries only a bounded non-secret
 *   reason class (never raw exception text).
 */

import { isConversationHandoffEvent } from "./conversation-timeline.js";
import type { ConversationTranscriptRow } from "./conversation-transcript.js";
import type { ConversationEventRecord } from "./conversations.js";
import { agentDisplayName } from "./agent-display.js";

/** Steward-resolved bounded visible duration for success feedback (ms). */
export const COPY_FEEDBACK_VISIBLE_MS = 2000;

export type CopyFailureReason = "clipboard unavailable" | "clipboard rejected";

export type CopyFeedbackState = { kind: "idle" } | { kind: "copied" } | { kind: "failed"; reason: CopyFailureReason };

/**
 * Normative eligibility predicate: exactly ordinary durable message cards.
 * Evaluated on the already-parsed, gateway-validated record; the browser
 * invents no eligibility facts. Empty-body fail-safe (the parser already
 * forbids an empty body).
 */
export function isCopyableMessageRow(row: ConversationTranscriptRow): boolean {
  if (row.type !== "message") return false;
  const { event } = row;
  if (event.kind !== "steward_message" && event.kind !== "agent_message") return false;
  if (isConversationHandoffEvent(event)) return false;
  return event.body !== "";
}

/** The exact copied payload: the canonical stored body, nothing else. */
export function copyMessagePayload(event: ConversationEventRecord): string {
  return event.body;
}

/** One scheduled success-feedback expiry; cancellation is idempotent. */
export interface ScheduledExpiry {
  cancel(): void;
}

/**
 * Schedule the steward-resolved bounded success-feedback expiry. The timer
 * seam lives here so the timeline component stays free of raw timer text;
 * the callback never fires after cancellation (unmount/selection change/
 * replacement gesture).
 */
export function scheduleFeedbackExpiry(
  onExpire: () => void,
  setTimeoutFn: (fn: () => void, ms: number) => unknown = (fn, ms) => window.setTimeout(fn, ms),
  clearTimeoutFn: (handle: unknown) => void = (handle) => window.clearTimeout(handle as number),
): ScheduledExpiry {
  let cancelled = false;
  const handle = setTimeoutFn(() => {
    if (!cancelled) onExpire();
  }, COPY_FEEDBACK_VISIBLE_MS);
  return {
    cancel(): void {
      cancelled = true;
      clearTimeoutFn(handle);
    },
  };
}

/** The exact accessible name for one card's copy control. */
export function copyMessageAccessibleName(event: ConversationEventRecord): string {
  const author = event.authorKind === "agent" ? agentDisplayName(event.author) : event.author;
  return `Copy message from ${author}`;
}

/** Bounded non-secret reason class from the clipboard capability outcome. */
export function copyFailureReason(outcome: { available: boolean; rejected?: boolean }): CopyFailureReason {
  return outcome.available ? "clipboard rejected" : "clipboard unavailable";
}

export function copyStateAfterSuccess(_previous: CopyFeedbackState): CopyFeedbackState {
  return { kind: "copied" };
}

export function copyStateAfterFailure(_previous: CopyFeedbackState, outcome: { available: boolean; rejected?: boolean }): CopyFeedbackState {
  return { kind: "failed", reason: copyFailureReason(outcome) };
}
