/**
 * ADR-0044 — agent-first Conversation start request core. Pure and
 * framework-free so the wire contract is directly unit-testable.
 *
 * The Dashboard start action posts exactly `{agent}` — one explicit
 * steward-selected agent name and nothing else. The browser never derives a
 * recipient, synthesizes message text, or supplies a Conversation name,
 * membership, or mention: the gateway validates the selected agent against
 * the local runnable set and owns the durable origin event and dispatch.
 */
import { parseConversationRecord, type ConversationRecord } from "./conversations.js";

/** The only request body shape the Dashboard start action ever builds. */
export interface ConversationStartRequest {
  agent: string;
}

/** Build the exact start request body (one field, never anything else). */
export function toConversationStartRequest(agent: string): ConversationStartRequest {
  return { agent };
}

export interface ConversationStartEvent {
  id: string;
  conversationId: string;
  kind: string;
  created: string;
}

export interface ConversationStartDispatchEntry {
  agent: string;
  status: string;
}

export interface ConversationStartResponse {
  conversation: ConversationRecord;
  event: ConversationStartEvent;
  dispatch?: ConversationStartDispatchEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Fail-closed validation of POST /api/conversations/start. */
export function parseConversationStartResponse(json: unknown): ConversationStartResponse {
  if (!isRecord(json)) throw new Error("unexpected /api/conversations/start response");
  const event = json.event;
  if (
    !isRecord(event) ||
    typeof event.id !== "string" ||
    event.id === "" ||
    typeof event.kind !== "string" ||
    typeof event.created !== "string"
  ) {
    throw new Error("unexpected /api/conversations/start response (event)");
  }
  const parsed: ConversationStartResponse = {
    conversation: parseConversationRecord(json.conversation),
    event: {
      id: event.id,
      conversationId: typeof event.conversationId === "string" ? event.conversationId : "",
      kind: event.kind,
      created: event.created,
    },
  };
  const dispatch = json.dispatch;
  if (dispatch !== undefined) {
    if (
      !Array.isArray(dispatch) ||
      dispatch.some((entry) => !isRecord(entry) || typeof entry.agent !== "string" || typeof entry.status !== "string")
    ) {
      throw new Error("unexpected /api/conversations/start response (dispatch)");
    }
    parsed.dispatch = dispatch.map((entry) => ({ agent: entry.agent as string, status: entry.status as string }));
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// P3.3 — typed peer-audience start request core (accepted P2/P3.2). The only
// request body is the exact P2 {peers} shape; the only accepted response is
// the 201 safe {conversation, event} projection with dispatch ABSENT (peer
// creation contacts no broker).
// ---------------------------------------------------------------------------

/** The only request body shape the Dashboard peer start action ever builds. */
export interface PeerStartRequest {
  peers: string[];
}

/** Build the exact peer start request body (one field, never anything else). */
export function toPeerStartRequest(peers: readonly string[]): PeerStartRequest {
  return { peers: [...peers] };
}

export interface PeerStartResponse {
  conversation: ConversationRecord;
  event: ConversationStartEvent;
}

/** Fail-closed validation of POST /api/conversations/start-peer: a present dispatch field is a defect. */
export function parsePeerStartResponse(json: unknown): PeerStartResponse {
  if (!isRecord(json)) throw new Error("unexpected /api/conversations/start-peer response");
  if ("dispatch" in json) throw new Error("unexpected /api/conversations/start-peer response (dispatch must be absent)");
  const event = json.event;
  if (
    !isRecord(event) ||
    typeof event.id !== "string" ||
    event.id === "" ||
    typeof event.kind !== "string" ||
    typeof event.created !== "string"
  ) {
    throw new Error("unexpected /api/conversations/start-peer response (event)");
  }
  return {
    conversation: parseConversationRecord(json.conversation),
    event: {
      id: event.id,
      conversationId: typeof event.conversationId === "string" ? event.conversationId : "",
      kind: event.kind,
      created: event.created,
    },
  };
}
