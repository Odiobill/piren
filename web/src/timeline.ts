/**
 * Inspectable immutable room timeline core (ADR-0041 R3b-3). Pure and
 * framework-free so the wire contract is directly unit-testable.
 *
 * Ordering contract: the durable historic sequence (GET .../events, sorted
 * chronologically server-side) is the authority; live SSE frames only
 * append valid records in arrival order — the client never re-sorts,
 * re-orders, edits, or synthesizes event content. Malformed or unknown SSE
 * data becomes a displayable non-authoritative error/status item (never a
 * crash, never a mutation). Reconnects re-read the whole history (the
 * endpoint has no replay) and re-subscribe, with dedupe by record id.
 */
export interface RoomEventRecord {
  id: string;
  roomId: string;
  created: string;
  authorKind: string;
  author: string;
  kind: string;
  body: string;
  path: string;
  addressedAgent?: string;
  correlationId?: string;
  runStatus?: string;
  failureKind?: string;
}

export interface RoomApprovalNotification {
  roomId: string;
  agent: string;
  requestId: string;
  method: string;
}

/** Fail-closed validation of GET /api/rooms/<id>/events. */
export function parseRoomEvents(json: unknown): RoomEventRecord[] {
  if (typeof json !== "object" || json === null || !("events" in json)) {
    throw new Error("unexpected /api/rooms/<id>/events response");
  }
  const events = (json as { events?: unknown }).events;
  if (!Array.isArray(events)) throw new Error("unexpected /api/rooms/<id>/events response");
  return events.map((entry) => parseEventRecord(entry));
}

function parseEventRecord(entry: unknown): RoomEventRecord {
  if (typeof entry !== "object" || entry === null) throw new Error("unexpected room event record");
  const record = entry as Record<string, unknown>;
  for (const field of ["id", "roomId", "created", "authorKind", "author", "kind", "body", "path"] as const) {
    if (typeof record[field] !== "string" || (record[field] as string) === "") {
      throw new Error(`unexpected room event record (${field})`);
    }
  }
  const parsed: RoomEventRecord = {
    id: record.id as string,
    roomId: record.roomId as string,
    created: record.created as string,
    authorKind: record.authorKind as string,
    author: record.author as string,
    kind: record.kind as string,
    body: record.body as string,
    path: record.path as string,
  };
  // exactOptionalPropertyTypes: assign optional fields only when defined.
  if (typeof record.addressedAgent === "string") parsed.addressedAgent = record.addressedAgent;
  if (typeof record.correlationId === "string") parsed.correlationId = record.correlationId;
  if (typeof record.runStatus === "string") parsed.runStatus = record.runStatus;
  if (typeof record.failureKind === "string") parsed.failureKind = record.failureKind;
  return parsed;
}

/** One parsed SSE frame (event name + joined data payload). */
export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Incremental text/event-stream parser. Buffers partial chunks, splits on
 * blank lines, joins multi-line data, and ignores comment lines (`: ...`,
 * including the gateway's `: heartbeat`). Comment-only blocks yield no
 * frame. Never throws.
 */
export function createSseParser(): { push: (text: string) => SseFrame[] } {
  let buffer = "";
  return {
    push(text: string): SseFrame[] {
      buffer += text;
      const frames: SseFrame[] = [];
      let index: number;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const frame = parseBlock(block);
        if (frame !== null) frames.push(frame);
      }
      return frames;
    },
  };
}

function parseBlock(block: string): SseFrame | null {
  let event = "";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue; // comment (heartbeat)
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trimStart();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
    // id:/retry:/unknown fields are ignored (no client-side replay truth).
  }
  if (dataLines.length === 0) return null; // comment-only block
  return { event, data: dataLines.join("\n") };
}

/** One immutable timeline display item. Error items are non-authoritative. */
export type TimelineItem =
  | { type: "event"; id: string; event: RoomEventRecord }
  | { type: "approval"; id: string; approval: RoomApprovalNotification }
  | { type: "error"; id: string; message: string };

/**
 * Map one SSE frame to a display item. Never throws: malformed or unknown
 * frames become non-authoritative error items; heartbeat/comment-only
 * frames return null.
 */
export function frameToTimelineItem(frame: SseFrame): TimelineItem | null {
  if (frame.event === "" && frame.data === "") return null;
  if (frame.event === "room_event") {
    try {
      const parsed = parseEventRecord(JSON.parse(frame.data));
      return { type: "event", id: parsed.id, event: parsed };
    } catch {
      return { type: "error", id: `error-${frameIdHint(frame)}`, message: "unreadable room_event frame (non-authoritative)" };
    }
  }
  if (frame.event === "approval") {
    try {
      const approval = parseApproval(JSON.parse(frame.data));
      return { type: "approval", id: `approval-${approval.requestId}`, approval };
    } catch {
      return { type: "error", id: `error-${frameIdHint(frame)}`, message: "unreadable approval frame (non-authoritative)" };
    }
  }
  return { type: "error", id: `error-${frameIdHint(frame)}`, message: `unknown SSE event '${frame.event}' (non-authoritative)` };
}

function parseApproval(json: unknown): RoomApprovalNotification {
  if (typeof json !== "object" || json === null) throw new Error("unexpected approval frame");
  const record = json as Record<string, unknown>;
  for (const field of ["roomId", "agent", "requestId", "method"] as const) {
    if (typeof record[field] !== "string" || (record[field] as string) === "") {
      throw new Error(`unexpected approval frame (${field})`);
    }
  }
  return {
    roomId: record.roomId as string,
    agent: record.agent as string,
    requestId: record.requestId as string,
    method: record.method as string,
  };
}

function frameIdHint(frame: SseFrame): string {
  // Stable display key for a malformed frame (no vault identity is invented).
  let hash = 0;
  for (let index = 0; index < frame.data.length; index += 1) {
    hash = (hash * 31 + frame.data.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Append a valid live item in arrival order. Event/approval items dedupe by
 * id (no duplicate live records on re-read/reconnect); error items are
 * per-frame diagnostics and are always appended.
 */
export function appendLiveItem(items: TimelineItem[], item: TimelineItem): TimelineItem[] {
  if (item.type !== "error" && items.some((existing) => existing.id === item.id && existing.type !== "error")) {
    return items;
  }
  return [...items, item];
}

/**
 * Replace the timeline's event/approval items with the durable historic
 * sequence (server-chronological) after a fresh whole-history reread.
 * Non-authoritative error markers are preserved in place; the fresh events
 * are appended in their durable order with no client-generated ordering.
 */
export function replaceHistoricWithEvents(items: TimelineItem[], events: RoomEventRecord[]): TimelineItem[] {
  const errors = items.filter((item) => item.type === "error");
  return [...errors, ...events.map((event) => ({ type: "event" as const, id: event.id, event }))];
}
