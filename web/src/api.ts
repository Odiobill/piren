import { parseAuthInfo, buildAuthHeaders, type AuthInfoResponse } from "./auth";
import {
  parseRoomAgents,
  parseRoomEnvelope,
  parseRoomList,
  type RoomAgentsResponse,
  type RoomListResponse,
  type RoomRecord,
} from "./rooms";

/**
 * Typed fetch client for the existing gateway /api/* surface. R3b-2 consumes
 * the public auth-info probe plus the authenticated room-agents roster and
 * room list/create/read routes; later separately-authorized bullets add their
 * own endpoints. Every protected call carries the in-memory Bearer token and
 * surfaces 401 truthfully via UnauthorizedError (never silently retried).
 */
export class UnauthorizedError extends Error {
  constructor() {
    super("the gateway rejected the bearer token");
    this.name = "UnauthorizedError";
  }
}

export async function fetchAuthInfo(signal?: AbortSignal): Promise<AuthInfoResponse> {
  // exactOptionalPropertyTypes: never pass { signal: undefined } as init.
  const init = signal === undefined ? undefined : { signal };
  const res = await fetch("/api/auth/info", init);
  if (!res.ok) throw new Error(`auth info HTTP ${res.status}`);
  return parseAuthInfo(await res.json());
}

async function authedFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {
    ...buildAuthHeaders(token),
    ...((init?.headers ?? {}) as Record<string, string>),
  };
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) throw new UnauthorizedError();
  return res;
}

/** GET /api/room-agents — local-policy roster (online = locally runnable). */
export async function fetchRoomAgents(token: string, signal?: AbortSignal): Promise<RoomAgentsResponse> {
  const res = await authedFetch("/api/room-agents", token, signal === undefined ? undefined : { signal });
  if (!res.ok) throw new Error(`room agents HTTP ${res.status}`);
  return parseRoomAgents(await res.json());
}

/** GET /api/rooms — durable room list. */
export async function fetchRooms(token: string, signal?: AbortSignal): Promise<RoomListResponse> {
  const res = await authedFetch("/api/rooms", token, signal === undefined ? undefined : { signal });
  if (!res.ok) throw new Error(`rooms HTTP ${res.status}`);
  return parseRoomList(await res.json());
}

/** GET /api/rooms/<id> — room detail (metadata only; timeline arrives later). */
export async function fetchRoom(id: string, token: string, signal?: AbortSignal): Promise<RoomRecord> {
  const res = await authedFetch(`/api/rooms/${encodeURIComponent(id)}`, token, signal === undefined ? undefined : { signal });
  if (!res.ok) throw new Error(`room ${id} HTTP ${res.status}`);
  return parseRoomEnvelope(await res.json());
}

/** POST /api/rooms — create with immutable participants (D7). */
export async function createRoom(token: string, title: string, participants: string[]): Promise<RoomRecord> {
  const res = await authedFetch("/api/rooms", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, participants }),
  });
  if (!res.ok) {
    let reason = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error !== "") reason = body.error;
    } catch {
      // keep the HTTP status reason
    }
    throw new Error(reason);
  }
  return parseRoomEnvelope(await res.json());
}
