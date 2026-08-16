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
 * - D3: for the special agent-first path only, the redundant SUCCESSFUL
 *   system run envelopes correlated to an exact system-authored durable
 *   `conversation_start_requested` origin id (its `run_started`, and its `run_finished` only when the durable
 *   terminal status is exactly `completed`) are omitted from display. The
 *   durable origin and the agent greeting stay visible; every failure and
 *   all malformed/unattributed/uncorrelated evidence keeps its current path.
 *   Historic reread and live append share this one grouping, so read-only
 *   inspection and active surfaces always agree.
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

/** The durable agent-first origin kind (ADR-0044 system-authored start marker). */
const AGENT_FIRST_ORIGIN_KIND = "conversation_start_requested";

/** D3 only projects the exact durable system-authored shape, never a lookalike. */
function isSystemAuthored(event: ConversationEventRecord): boolean {
  return event.authorKind === "system" && event.author === "system";
}

/** The exact durable system origin body shape persisted by the gateway. */
const START_ORIGIN_BODY_PATTERN = /^The steward requested starting this conversation with agent '([^']+)'\.$/;

/** The concise presentation applies only to a valid Piren agent name. */
const START_ORIGIN_AGENT_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * D5 — concise presentation for the EXACT system-authored durable
 * `conversation_start_requested` origin only: the concise label
 * `Conversation started with agent <agent>` covers the redundant
 * explanatory body, so the row renderer suppresses the body when (and only
 * when) this returns non-null. The captured name must be a valid Piren
 * agent name (`[a-z][a-z0-9-]*`); a system-authored lookalike body with an
 * arbitrary captured value fails safe to the technical label and visible
 * body. The durable event itself — kind, body, ordering, correlation — is
 * never changed, and the D3 suppression predicate is untouched. Non-system
 * lookalikes, malformed bodies, and every other event return null and keep
 * their current fail-safe visible rendering.
 */
export function conversationStartOriginPresentation(event: ConversationEventRecord): { label: string } | null {
  if (event.kind !== AGENT_FIRST_ORIGIN_KIND) return null;
  if (!isSystemAuthored(event)) return null;
  const match = START_ORIGIN_BODY_PATTERN.exec(event.body);
  const agent = match?.[1];
  if (agent === undefined || !START_ORIGIN_AGENT_PATTERN.test(agent)) return null;
  return { label: `Conversation started with agent ${agent}` };
}

/**
 * D3 — the redundant successful system run envelope of the special
 * agent-first path, and nothing else. Suppression requires EVERY exact
 * durable field: an exact system-authored run_started/run_finished shape, a
 * non-empty correlationId matching an actually displayed exact
 * system-authored durable `conversation_start_requested` origin id, a valid
 * non-empty durable runAgent attribution, and — for
 * run_finished only — a durable terminal status of exactly "completed".
 * Failures, cancellations, unknown/missing statuses, and malformed or
 * unattributed evidence are NEVER suppressed: they fail safe to their
 * current visible display path. The durable agent greeting remains the
 * normal successful acknowledgement; no chip or inferred state replaces the
 * omitted envelopes.
 */
function isAgentFirstRedundantSuccessEnvelope(event: ConversationEventRecord, startOriginIds: ReadonlySet<string>): boolean {
  if (event.kind !== "run_started" && event.kind !== "run_finished") return false;
  if (!isSystemAuthored(event)) return false;
  const correlationId = event.correlationId;
  if (typeof correlationId !== "string" || correlationId === "") return false;
  if (!startOriginIds.has(correlationId)) return false;
  if (typeof event.runAgent !== "string" || event.runAgent === "") return false;
  if (event.kind === "run_started") return true;
  return event.runStatus === "completed";
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
  const startOriginIds = new Set<string>();
  for (const item of items) {
    if (item.type === "event" && isMessageKind(item.event)) requesterIds.add(item.event.id);
    if (item.type === "event" && item.event.kind === AGENT_FIRST_ORIGIN_KIND && isSystemAuthored(item.event)) {
      startOriginIds.add(item.event.id);
    }
  }

  const rows: ConversationTranscriptRow[] = [];
  const messageById = new Map<string, Extract<ConversationTranscriptRow, { type: "message" }>>();
  for (const item of items) {
    if (item.type === "error") {
      rows.push({ type: "error", id: item.id, message: item.message });
      continue;
    }
    const event = item.event;
    // D3: omit ONLY the redundant successful agent-first run envelopes;
    // everything else keeps its current grouping/display path unchanged.
    if (isAgentFirstRedundantSuccessEnvelope(event, startOriginIds)) {
      continue;
    }
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
