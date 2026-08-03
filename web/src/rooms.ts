/**
 * Room navigator data types and fail-closed parsers (ADR-0041 R3b-2).
 * Pure and framework-free so the wire contract is directly unit-testable.
 * `online` in the roster is local installation policy only (membership in
 * this gateway's runnable set), never a live presence or auth probe.
 */
export interface RoomAgentEntry {
  name: string;
  online: boolean;
}

export interface RoomAgentsResponse {
  agents: RoomAgentEntry[];
}

export interface RoomRecord {
  id: string;
  title: string;
  status: string;
  participants: string[];
  path: string;
  createdBy: string;
  created: string;
  updated: string;
}

export interface RoomListResponse {
  rooms: RoomRecord[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** Fail-closed validation of GET /api/room-agents. */
export function parseRoomAgents(json: unknown): RoomAgentsResponse {
  if (typeof json !== "object" || json === null || !("agents" in json)) {
    throw new Error("unexpected /api/room-agents response");
  }
  const agents = (json as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) throw new Error("unexpected /api/room-agents response");
  for (const entry of agents) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !isNonEmptyString((entry as { name?: unknown }).name) ||
      typeof (entry as { online?: unknown }).online !== "boolean"
    ) {
      throw new Error("unexpected /api/room-agents response");
    }
  }
  return { agents: agents as RoomAgentEntry[] };
}

/** Fail-closed validation of a single room record (list/read/create). */
export function parseRoomRecord(json: unknown): RoomRecord {
  if (typeof json !== "object" || json === null) throw new Error("unexpected room record");
  const record = json as Partial<RoomRecord>;
  if (
    !isNonEmptyString(record.id) ||
    typeof record.title !== "string" ||
    typeof record.status !== "string" ||
    !Array.isArray(record.participants) ||
    record.participants.some((p) => typeof p !== "string")
  ) {
    throw new Error("unexpected room record");
  }
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    participants: record.participants as string[],
    path: typeof record.path === "string" ? record.path : "",
    createdBy: typeof record.createdBy === "string" ? record.createdBy : "",
    created: typeof record.created === "string" ? record.created : "",
    updated: typeof record.updated === "string" ? record.updated : "",
  };
}

/** Fail-closed validation of GET /api/rooms. */
export function parseRoomList(json: unknown): RoomListResponse {
  if (typeof json !== "object" || json === null || !("rooms" in json)) {
    throw new Error("unexpected /api/rooms response");
  }
  const rooms = (json as { rooms?: unknown }).rooms;
  if (!Array.isArray(rooms)) throw new Error("unexpected /api/rooms response");
  return { rooms: rooms.map((room) => parseRoomRecord(room)) };
}

/** Fail-closed validation of {room: ...} wrappers (read/create). */
export function parseRoomEnvelope(json: unknown): RoomRecord {
  if (typeof json !== "object" || json === null || !("room" in json)) {
    throw new Error("unexpected room response");
  }
  return parseRoomRecord((json as { room?: unknown }).room);
}
