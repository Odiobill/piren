import { parseAuthInfo, buildAuthHeaders, type AuthInfoResponse } from "./auth";
import {
  parseRoomAgents,
  parseRoomEnvelope,
  parseRoomList,
  type RoomAgentsResponse,
  type RoomListResponse,
  type RoomRecord,
} from "./rooms";
import { createSseParser, parseRoomEvents, type RoomEventRecord, type SseFrame } from "./timeline";
import { parseDispatchOutcome, parseMessageError } from "./composer";
import {
  parseConversationCreateResponse,
  parseConversationMessageResponse,
  type ConversationCreateResponse,
  type ConversationMessageResponse,
} from "./conversation-composer";
import {
  parseConversationEnvelope,
  parseConversationEvents,
  parseConversationList,
  type ConversationEventRecord,
  type ConversationListResponse,
  type ConversationRecord,
} from "./conversations";
import { parseAttachResponse, type AttachResponse } from "./attach";
import {
  parseLifecycleActionResponse,
  parseLifecycleHttpError,
  type ConversationLifecycleAction,
  type LifecycleActionResponse,
} from "./conversation-lifecycle";
import {
  buildConversationApproveBody,
  parseConversationAbortOutcome,
  parseConversationControlHttpError,
  type ApprovalResponse,
  type ConversationAbortOutcome,
} from "./conversation-controls";

/** Typed bounded lifecycle action error (L2 404/409/500 / network). */
export class LifecycleHttpError extends Error {
  readonly kind: "not-found" | "conflict" | "server" | "network";

  constructor(kind: "not-found" | "conflict" | "server" | "network", message: string) {
    super(message);
    this.name = "LifecycleHttpError";
    this.kind = kind;
  }
}

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

/** GET /api/rooms/<id>/events — whole durable event history (no replay). */
export async function fetchRoomEvents(id: string, token: string, signal?: AbortSignal): Promise<RoomEventRecord[]> {
  const res = await authedFetch(`/api/rooms/${encodeURIComponent(id)}/events`, token, signal === undefined ? undefined : { signal });
  if (!res.ok) throw new Error(`room events HTTP ${res.status}`);
  return parseRoomEvents(await res.json());
}

export interface RoomEventStreamHandlers {
  onFrame: (frame: SseFrame) => void;
  onOpen?: () => void;
}

/**
 * GET /api/rooms/<id>/events/stream — scoped SSE read, consumed with fetch so
 * the in-memory Bearer header is carried (the native SSE client cannot set
 * headers). Resolves when the stream ends; the caller decides the reconnect
 * policy (whole-history reread + re-subscription). Aborted via the signal.
 */
export async function streamRoomEvents(
  id: string,
  token: string,
  handlers: RoomEventStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const res = await authedFetch(`/api/rooms/${encodeURIComponent(id)}/events/stream`, token, { signal });
  if (!res.ok) throw new Error(`room stream HTTP ${res.status}`);
  handlers.onOpen?.();
  const body = res.body;
  if (body === null) throw new Error("room stream has no body");
  const reader = body.getReader();
  const parser = createSseParser();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        handlers.onFrame(frame);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** POST /api/rooms/<id>/messages — structured dispatch (R3b-4/W1). */
export async function sendRoomMessage(
  roomId: string,
  agent: string,
  text: string,
  token: string,
): Promise<import("./composer.js").RoomDispatchOutcome> {
  const res = await authedFetch(`/api/rooms/${encodeURIComponent(roomId)}/messages`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent, text }),
  });
  if (!res.ok) {
    let reason = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as unknown;
      const message = parseMessageError(body);
      if (message !== null) reason = message;
    } catch {
      // keep the HTTP status reason
    }
    throw new Error(reason);
  }
  return parseDispatchOutcome(await res.json());
}

// ---------------------------------------------------------------------------
// C3-A — Conversation surface transport over the accepted C2 API family
// ---------------------------------------------------------------------------

/** GET /api/conversations — durable conversation list, newest-first. */
export async function fetchConversations(token: string, signal?: AbortSignal): Promise<ConversationListResponse> {
  const res = await authedFetch("/api/conversations", token, signal === undefined ? undefined : { signal });
  if (!res.ok) throw new Error(`conversations HTTP ${res.status}`);
  return parseConversationList(await res.json());
}

/** GET /api/conversations/<id> — read one conversation manifest. */
export async function fetchConversation(id: string, token: string, signal?: AbortSignal): Promise<ConversationRecord> {
  const res = await authedFetch(`/api/conversations/${encodeURIComponent(id)}`, token, signal === undefined ? undefined : { signal });
  if (!res.ok) throw new Error(`conversation ${id} HTTP ${res.status}`);
  return parseConversationEnvelope(await res.json());
}

/** POST /api/conversations — create + activate with the first raw-text message. */
export async function createConversation(token: string, text: string): Promise<ConversationCreateResponse> {
  const res = await authedFetch("/api/conversations", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
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
  return parseConversationCreateResponse(await res.json());
}

/**
 * POST /api/conversations/<id>/attach — the C1/runnable-roster-gated attach.
 * The gateway applies `checkActiveGate` against the local runnable set; the
 * response decides the presentation (active vs read-only inspection). This
 * route is stateless server-side.
 */
export async function attachConversation(id: string, token: string): Promise<AttachResponse> {
  const res = await authedFetch(`/api/conversations/${encodeURIComponent(id)}/attach`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (res.status === 409) return parseAttachResponse(await res.json());
  if (!res.ok) throw new Error(`attach HTTP ${res.status}`);
  return parseAttachResponse(await res.json());
}

/** POST /api/conversations/<id>/messages — raw-text follow-up composer. */
export async function sendConversationMessage(
  id: string,
  text: string,
  token: string,
): Promise<ConversationMessageResponse> {
  const res = await authedFetch(`/api/conversations/${encodeURIComponent(id)}/messages`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
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
  return parseConversationMessageResponse(await res.json());
}

async function postLifecycleAction(
  id: string,
  action: ConversationLifecycleAction,
  token: string,
): Promise<LifecycleActionResponse> {
  const res = await authedFetch(`/api/conversations/${encodeURIComponent(id)}/${action}`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (res.status === 200) return parseLifecycleActionResponse(await res.json());
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // keep the typed fallback
  }
  const parsed = parseLifecycleHttpError(res.status, json);
  throw new LifecycleHttpError(parsed.kind, parsed.message);
}

/** POST /api/conversations/<id>/archive — L2 lifecycle action (state-only). */
export async function archiveConversation(id: string, token: string): Promise<LifecycleActionResponse> {
  return postLifecycleAction(id, "archive", token);
}

/** POST /api/conversations/<id>/reopen — L2 lifecycle action (state-only). */
export async function reopenConversation(id: string, token: string): Promise<LifecycleActionResponse> {
  return postLifecycleAction(id, "reopen", token);
}

/** Typed bounded error from the C3-C2 approve/abort routes. */
export class ConversationControlHttpError extends Error {
  readonly kind: "bad-request" | "not-found" | "stale" | "server" | "network";

  constructor(kind: "bad-request" | "not-found" | "stale" | "server" | "network", message: string) {
    super(message);
    this.name = "ConversationControlHttpError";
    this.kind = kind;
  }
}

/**
 * POST /api/conversations/<id>/approve — forward one exactly-one approval
 * response to the exact pending conversation×agent request. Success is
 * delivery acceptance only; the browser never fabricates an agent outcome.
 */
export async function approveConversationApproval(
  id: string,
  agent: string,
  requestId: string,
  response: ApprovalResponse,
  token: string,
): Promise<void> {
  const res = await authedFetch(`/api/conversations/${encodeURIComponent(id)}/approve`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildConversationApproveBody(agent, requestId, response)),
  });
  if (res.status === 200) return;
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // keep the typed fallback
  }
  const parsed = parseConversationControlHttpError(res.status, json);
  throw new ConversationControlHttpError(parsed.kind, parsed.message);
}

/**
 * POST /api/conversations/<id>/abort — abort the active run for exactly one
 * conversation×agent key; returns the bounded cancelled|no-active-run outcome.
 */
export async function abortConversationRun(id: string, agent: string, token: string): Promise<ConversationAbortOutcome> {
  const res = await authedFetch(`/api/conversations/${encodeURIComponent(id)}/abort`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent }),
  });
  if (res.status === 200) return parseConversationAbortOutcome(await res.json());
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // keep the typed fallback
  }
  const parsed = parseConversationControlHttpError(res.status, json);
  throw new ConversationControlHttpError(parsed.kind, parsed.message);
}

/** GET /api/conversations/<id>/events — whole durable history (no replay). */
export async function fetchConversationEvents(id: string, token: string, signal?: AbortSignal): Promise<ConversationEventRecord[]> {
  const res = await authedFetch(`/api/conversations/${encodeURIComponent(id)}/events`, token, signal === undefined ? undefined : { signal });
  if (!res.ok) throw new Error(`conversation events HTTP ${res.status}`);
  return parseConversationEvents(await res.json());
}

export interface ConversationEventStreamHandlers {
  onFrame: (frame: SseFrame) => void;
  onOpen?: () => void;
}

/**
 * GET /api/conversations/<id>/events/stream — scoped live SSE consumed with
 * fetch so the in-memory Bearer header is carried. Resolves when the stream
 * ends; the caller decides the reconnect policy (whole-history reread +
 * re-subscription). Used ONLY after a successful attach.
 */
export async function streamConversationEvents(
  id: string,
  token: string,
  handlers: ConversationEventStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const res = await authedFetch(`/api/conversations/${encodeURIComponent(id)}/events/stream`, token, { signal });
  if (!res.ok) throw new Error(`conversation stream HTTP ${res.status}`);
  handlers.onOpen?.();
  const body = res.body;
  if (body === null) throw new Error("conversation stream has no body");
  const reader = body.getReader();
  const parser = createSseParser();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        handlers.onFrame(frame);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
