/**
 * C3-A: raw-text Conversation composer core.
 *
 * The Conversation composer sends RAW text to the accepted C2 routes
 * (`POST /api/conversations` and `POST /api/conversations/<id>/messages`).
 * The gateway alone parses and validates `@`-mentions against the local
 * runnable set (C1 server authority; C0 §6): the browser NEVER scans,
 * resolves, or derives dispatch recipients from `@text`. The request body
 * is exactly `{text}` — there is no recipient/agent field anywhere.
 */
import { parseConversationRecord, type ConversationRecord } from "./conversations.js";

/** The only request body shape the composer ever builds. */
export interface ConversationMessageRequest {
  text: string;
}

export type ConversationComposerValidation = { ok: true } | { ok: false; reason: "text required" };

/** Send-enable gate: the trimmed raw text must be non-empty. */
export function validateConversationText(text: string): ConversationComposerValidation {
  if (text.trim() === "") return { ok: false, reason: "text required" };
  return { ok: true };
}

/** Build the raw request body with trimmed text (never a recipient field). */
export function toConversationMessageRequest(text: string): ConversationMessageRequest {
  return { text: text.trim() };
}

export interface ConversationMessageEvent {
  id: string;
  conversationId: string;
  kind: string;
  created: string;
}

export interface ConversationDispatchEntry {
  agent: string;
  status: string;
}

export interface ConversationMessageResponse {
  event: ConversationMessageEvent;
  dispatch?: ConversationDispatchEntry[];
}

export interface ConversationCreateResponse {
  conversation: ConversationRecord;
  event: ConversationMessageEvent;
  dispatch?: ConversationDispatchEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseMessageEvent(json: unknown): ConversationMessageEvent {
  if (!isRecord(json)) throw new Error("unexpected conversation event");
  const event = json as Partial<ConversationMessageEvent>;
  if (typeof event.id !== "string" || event.id === "" || typeof event.kind !== "string" || typeof event.created !== "string") {
    throw new Error("unexpected conversation event");
  }
  return {
    id: event.id,
    conversationId: typeof event.conversationId === "string" ? event.conversationId : "",
    kind: event.kind,
    created: event.created,
  };
}

function parseDispatch(json: unknown): ConversationDispatchEntry[] | undefined {
  if (json === undefined) return undefined;
  if (!Array.isArray(json) || json.some((entry) => !isRecord(entry) || typeof entry.agent !== "string" || typeof entry.status !== "string")) {
    throw new Error("unexpected conversation dispatch");
  }
  return json.map((entry) => ({ agent: entry.agent as string, status: entry.status as string }));
}

/** Fail-closed validation of POST /api/conversations/<id>/messages. */
export function parseConversationMessageResponse(json: unknown): ConversationMessageResponse {
  if (!isRecord(json)) throw new Error("unexpected /api/conversations/<id>/messages response");
  const parsed: ConversationMessageResponse = { event: parseMessageEvent(json.event) };
  const dispatch = parseDispatch(json.dispatch);
  if (dispatch !== undefined) parsed.dispatch = dispatch;
  return parsed;
}

/** Fail-closed validation of POST /api/conversations (create + first message). */
export function parseConversationCreateResponse(json: unknown): ConversationCreateResponse {
  if (!isRecord(json) || !isRecord(json.conversation)) {
    throw new Error("unexpected /api/conversations response");
  }
  const parsed: ConversationCreateResponse = {
    conversation: parseConversationRecord(json.conversation),
    event: parseMessageEvent(json.event),
  };
  const dispatch = parseDispatch(json.dispatch);
  if (dispatch !== undefined) parsed.dispatch = dispatch;
  return parsed;
}
