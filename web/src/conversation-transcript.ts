/**
 * P3 — message-first Conversation transcript and fixed correlated status
 * clusters (accepted `conversation-message-first-transcript-contract.md`,
 * 2026-08-12). Pure presentation grouping over the accumulated durable
 * timeline items:
 *
 * - `steward_message` and `agent_message` are requester-capable message rows
 *   (C5 handoff agent_messages keep their durable handoff identity and may
 *   still be a requester for their own child run).
 * - An eligible run event (`run_started`/`run_finished`/`run_cancelled` with
 *   a non-empty durable `correlationId` pointing at a displayed message row,
 *   a valid non-empty durable `runAgent`, and an existing U5 mapping) appends
 *   exactly one fixed status item to that requester row in server order —
 *   never deduped or overwritten.
 * - Everything else (uncorrelated/unknown-requester/unattributed/malformed
 *   run evidence, `model_fallback`, lifecycle/rename evidence, errors) fails
 *   safe to a compact visible row with the U5 chip when a mapping exists.
 *
 * Mapping uses ONLY durable `correlationId`, `runAgent`, event kind, and
 * durable terminal status — never body text, adjacency, roster, live
 * activity, or browser state. No read/seen/delivery claim, no writes, no
 * Markdown/HTML rendering.
 */
import type { ConversationEventRecord } from "./conversations.js";
import type { ConversationTimelineItem } from "./conversation-timeline.js";
import { conversationReactionForEvent, type ConversationReaction, type ConversationReactionKind } from "./conversation-reactions.js";

/** One fixed status attachment to a requester message row. */
export interface ConversationStatusAttachment {
  /** Durable run event id (React key; distinct events are never deduped). */
  eventId: string;
  /** The exact U5 durable mapping (kind/label). */
  reaction: ConversationReaction;
}

/** P3 transcript row model: messages carry a fixed status cluster. */
export type ConversationTranscriptRow =
  | { type: "message"; event: ConversationEventRecord; statuses: ConversationStatusAttachment[] }
  | { type: "evidence"; event: ConversationEventRecord; reaction: ConversationReaction | null }
  | { type: "error"; id: string; message: string };

/** Requester-capable message kinds (steward and agent durable messages). */
function isMessageKind(event: ConversationEventRecord): boolean {
  return event.kind === "steward_message" || event.kind === "agent_message";
}

/** The three run kinds whose U5 status can attach to a requester row. */
function isRunKind(event: ConversationEventRecord): boolean {
  return event.kind === "run_started" || event.kind === "run_finished" || event.kind === "run_cancelled";
}

/**
 * Eligible run evidence: a run kind with a non-empty durable `correlationId`
 * pointing at a displayed message row, a valid non-empty durable `runAgent`,
 * and an existing U5 mapping.
 */
function isEligibleRunEvent(event: ConversationEventRecord, requesterIds: ReadonlySet<string>): boolean {
  if (!isRunKind(event)) return false;
  const correlationId = event.correlationId;
  if (typeof correlationId !== "string" || correlationId === "") return false;
  if (!requesterIds.has(correlationId)) return false;
  if (typeof event.runAgent !== "string" || event.runAgent === "") return false;
  return conversationReactionForEvent(event) !== null;
}

/**
 * Group the durable timeline items into P3 transcript rows. The transcript is
 * processed strictly in server evidence order; every distinct durable event
 * is preserved (a correlated run appears only inside its requester cluster —
 * never a standalone card — while ineligible evidence stays visible).
 */
export function groupConversationTranscript(items: readonly ConversationTimelineItem[]): ConversationTranscriptRow[] {
  const requesterIds = new Set<string>();
  for (const item of items) {
    if (item.type === "event" && isMessageKind(item.event)) requesterIds.add(item.event.id);
  }

  const rows: ConversationTranscriptRow[] = [];
  const messageById = new Map<string, Extract<ConversationTranscriptRow, { type: "message" }>>();
  for (const item of items) {
    if (item.type === "error") {
      rows.push({ type: "error", id: item.id, message: item.message });
      continue;
    }
    const event = item.event;
    if (isMessageKind(event)) {
      const row: Extract<ConversationTranscriptRow, { type: "message" }> = { type: "message", event, statuses: [] };
      messageById.set(event.id, row);
      rows.push(row);
      continue;
    }
    if (isEligibleRunEvent(event, requesterIds)) {
      const correlationId = event.correlationId as string;
      const target = messageById.get(correlationId);
      const reaction = conversationReactionForEvent(event);
      if (target !== undefined && reaction !== null) {
        // Represented in the requester cluster; no standalone card.
        target.statuses.push({ eventId: event.id, reaction });
        continue;
      }
    }
    // Fail safe: compact visible evidence/attention row with the U5 chip
    // when a mapping exists (uncorrelated, unknown requester, missing
    // attribution, malformed/unsupported terminal, model_fallback, ...).
    rows.push({ type: "evidence", event, reaction: conversationReactionForEvent(event) });
  }
  return rows;
}

/**
 * Deterministic decorative circular initial: the first Unicode code point of
 * the durable author string, uppercased. Decorative only (`aria-hidden`); the
 * full author name remains text.
 */
export function conversationAuthorInitial(author: string): string {
  const codePoint = author.codePointAt(0);
  if (codePoint === undefined) return "";
  return String.fromCodePoint(codePoint).toUpperCase();
}

/** Exact fixed P3 display symbol for a U5 status kind. */
export function conversationStatusSymbol(kind: ConversationReactionKind): string {
  switch (kind) {
    case "received":
      return "⏳";
    case "completed":
      return "✅";
    case "failed":
      return "⚠️";
    case "cancelled":
      return "⏹";
  }
}
