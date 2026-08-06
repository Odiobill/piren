/**
 * C3-A: immutable Conversation timeline core.
 *
 * Mirrors the accepted room timeline discipline (ADR-0041 R3b-3) over the
 * C2 Conversation event surface: durable historic events are the
 * chronological authority; live SSE frames only append valid records in
 * arrival order; malformed/unknown frames become non-authoritative display
 * items (never a crash, never a mutation); reconnects re-read the whole
 * history (no replay) and re-subscribe with dedupe by record id. The live
 * stream exists ONLY after a successful attach — a read-only inspection
 * surface renders history without any live subscription.
 */
import type { ConversationEventRecord } from "./conversations.js";
import { createSseParser, streamEnded, initialReconnectBudget, MAX_AUTO_RECONNECT_ATTEMPTS, type ReconnectBudget, type SseFrame } from "./timeline.js";

export { streamEnded, initialReconnectBudget, MAX_AUTO_RECONNECT_ATTEMPTS };
export type { ReconnectBudget };

/** One immutable timeline display item. Error items are non-authoritative. */
export type ConversationTimelineItem =
  | { type: "event"; id: string; event: ConversationEventRecord }
  | { type: "error"; id: string; message: string };

export { createSseParser };

/**
 * Map one live SSE frame to a display item. Never throws: malformed or
 * unknown frames become non-authoritative error items; heartbeat/comment
 * frames return null.
 */
export function conversationFrameToItem(frame: SseFrame): ConversationTimelineItem | null {
  if (frame.event === "" && frame.data === "") return null;
  if (frame.event === "conversation_event") {
    try {
      const parsed = parseConversationEventRecord(JSON.parse(frame.data));
      return { type: "event", id: parsed.id, event: parsed };
    } catch {
      return { type: "error", id: `error-${frameIdHint(frame)}`, message: "unreadable conversation_event frame (non-authoritative)" };
    }
  }
  return { type: "error", id: `error-${frameIdHint(frame)}`, message: `unknown SSE event '${frame.event}' (non-authoritative)` };
}

function parseConversationEventRecord(entry: unknown): ConversationEventRecord {
  if (typeof entry !== "object" || entry === null) throw new Error("unexpected conversation event record");
  const record = entry as Record<string, unknown>;
  for (const field of ["id", "conversationId", "kind", "authorKind", "author", "created", "body", "path"] as const) {
    if (typeof record[field] !== "string" || (record[field] as string) === "") {
      throw new Error(`unexpected conversation event record (${field})`);
    }
  }
  const sequence = record.sequence;
  if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 1) {
    throw new Error("unexpected conversation event record (sequence)");
  }
  const mentions = record.mentions;
  if (mentions !== undefined && (!Array.isArray(mentions) || mentions.some((m) => typeof m !== "string"))) {
    throw new Error("unexpected conversation event record (mentions)");
  }
  const parsed: ConversationEventRecord = {
    id: record.id as string,
    conversationId: record.conversationId as string,
    kind: record.kind as string,
    authorKind: record.authorKind as string,
    author: record.author as string,
    created: record.created as string,
    sequence,
    mentions: mentions === undefined ? [] : (mentions as string[]),
    body: record.body as string,
    path: record.path as string,
  };
  if (typeof record.addressedAgent === "string") parsed.addressedAgent = record.addressedAgent;
  if (typeof record.correlationId === "string") parsed.correlationId = record.correlationId;
  if (typeof record.runStatus === "string") parsed.runStatus = record.runStatus;
  if (typeof record.failureKind === "string") parsed.failureKind = record.failureKind;
  // L2 lifecycle metadata: accepted ONLY as open|archived; present-but-invalid
  // fails closed (mirrors the shared web conversations parser).
  if (record.lifecycleState === "open" || record.lifecycleState === "archived") {
    parsed.lifecycleState = record.lifecycleState;
  } else if (record.lifecycleState !== undefined) {
    throw new Error("unexpected conversation event record (lifecycleState)");
  }
  return parsed;
}

function frameIdHint(frame: SseFrame): string {
  let hash = 0;
  for (let index = 0; index < frame.data.length; index += 1) {
    hash = (hash * 31 + frame.data.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Append a valid live item in arrival order. Event items dedupe by id (no
 * duplicate live records on re-read/reconnect); error items are per-frame
 * diagnostics and are always appended.
 */
export function appendConversationLiveItem(
  items: ConversationTimelineItem[],
  item: ConversationTimelineItem,
): ConversationTimelineItem[] {
  if (item.type !== "error" && items.some((existing) => existing.id === item.id && existing.type !== "error")) {
    return items;
  }
  return [...items, item];
}

/**
 * Replace the timeline with the durable historic sequence after a fresh
 * whole-history reread. The durable server order is displayed as-is (never
 * re-sorted client-side); transient non-authoritative stream diagnostics
 * are cleared, never prepended.
 */
export function replaceConversationHistoric(events: ConversationEventRecord[]): ConversationTimelineItem[] {
  return events.map((event) => ({ type: "event" as const, id: event.id, event }));
}
