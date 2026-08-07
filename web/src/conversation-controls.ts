/**
 * C3-C3 — Conversation approval/abort Workbench pure core.
 *
 * Fail-closed parsing of the scoped live `approval` SSE frame and the
 * approve/abort route envelopes, exactly-one request body construction,
 * bounded non-secret error vocabulary, and the polite announcement copy for
 * the first-party Workbench controls. The browser never invents recipients,
 * request ids, or approval state — it only sends `{agent, request_id,
 * confirmed|value|cancelled}` (exactly one) or `{agent}` to the declared
 * C3-C2 routes, and never fabricates an agent outcome: a successful POST is
 * delivery acceptance only.
 */

/** The only three approvable Pi UI methods (contract §9.3). */
export type ConversationApprovalMethod = "confirm" | "select" | "input";

/** One pending approval card model, derived ONLY from a parsed live frame. */
export interface PendingApproval {
  conversationId: string;
  agent: string;
  requestId: string;
  method: ConversationApprovalMethod;
  /** Bounded Pi request payload (everything except type/id). */
  payload: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * Fail-closed validation of one scoped live `approval` SSE frame
 * (contract §7.2: `{conversationId, agent, requestId, method, payload}`).
 * Unknown methods and non-object payloads are rejected so a malformed frame
 * can never invent a card, recipient, or request id.
 */
export function parseConversationApprovalFrame(json: unknown): PendingApproval {
  if (!isRecord(json)) throw new Error("unexpected approval frame");
  const method = json.method;
  if (method !== "confirm" && method !== "select" && method !== "input") {
    throw new Error("unexpected approval frame (method)");
  }
  const payload = json.payload;
  if (!isRecord(payload)) throw new Error("unexpected approval frame (payload)");
  for (const field of ["conversationId", "agent", "requestId"] as const) {
    if (!isNonEmptyString(json[field])) {
      throw new Error(`unexpected approval frame (${field})`);
    }
  }
  return {
    conversationId: json.conversationId as string,
    agent: json.agent as string,
    requestId: json.requestId as string,
    method,
    payload,
  };
}

/** The room-precedent exactly-one response shapes (contract §4.2). */
export type ApprovalResponse =
  | { confirmed: boolean }
  | { value: string }
  | { cancelled: true };

/** Exact approve-route body: agent + request_id + exactly one response field. */
export type ConversationApproveBody =
  | { agent: string; request_id: string; confirmed: boolean }
  | { agent: string; request_id: string; value: string }
  | { agent: string; request_id: string; cancelled: true };

/** Build the fixed approve body; exactly-one by construction. */
export function buildConversationApproveBody(
  agent: string,
  requestId: string,
  response: ApprovalResponse,
): ConversationApproveBody {
  if ("confirmed" in response) {
    return { agent, request_id: requestId, confirmed: response.confirmed };
  }
  if ("value" in response) {
    return { agent, request_id: requestId, value: response.value };
  }
  return { agent, request_id: requestId, cancelled: true };
}

/** Bounded abort-route outcome envelope (contract §5.2). */
export type ConversationAbortOutcome = { status: "cancelled" } | { status: "no-active-run" };

/** Fail-closed validation of the abort route envelope. */
export function parseConversationAbortOutcome(json: unknown): ConversationAbortOutcome {
  if (!isRecord(json)) throw new Error("unexpected abort outcome");
  const outcome = json.outcome;
  if (!isRecord(outcome)) throw new Error("unexpected abort outcome");
  if (outcome.status === "cancelled") return { status: "cancelled" };
  if (outcome.status === "no-active-run") return { status: "no-active-run" };
  throw new Error("unexpected abort outcome (status)");
}

/** Bounded control error kinds; the browser never derives or repairs state. */
export type ConversationControlErrorKind = "bad-request" | "not-found" | "stale" | "server" | "network";

export interface ConversationControlError {
  kind: ConversationControlErrorKind;
  message: string;
}

const FALLBACK_MESSAGES: Record<"bad-request" | "not-found" | "stale" | "server", string> = {
  "bad-request": "The approval request body was rejected.",
  "not-found": "conversation not found",
  stale: "The approval request is no longer pending.",
  server: "The approval request failed on the server.",
};

/**
 * Map a C3-C2 control error HTTP status + body to a typed bounded error.
 * The server's bounded `{error}` text is reused when present (409 stale and
 * 400 body validation); a 500 body is never echoed raw.
 */
export function parseConversationControlHttpError(status: number, json: unknown): ConversationControlError {
  if (status === 404) {
    return { kind: "not-found", message: FALLBACK_MESSAGES["not-found"] };
  }
  const kind: ConversationControlErrorKind = status === 400 ? "bad-request" : status === 409 ? "stale" : "server";
  if (kind === "server") {
    // Bounded 500: never leak raw filesystem/typed internals.
    return { kind, message: FALLBACK_MESSAGES.server };
  }
  if (isRecord(json) && typeof json.error === "string" && json.error.trim() !== "") {
    return { kind, message: json.error.trim().slice(0, 200) };
  }
  return { kind, message: FALLBACK_MESSAGES[kind] };
}

/** Bounded network/transport failure (manual Retry only, never automatic). */
export function networkConversationControlError(cause: unknown): ConversationControlError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return { kind: "network", message: message.slice(0, 200) };
}

/** Human label for the Pi UI request method (bounded fallback). */
export function approvalMethodLabel(method: ConversationApprovalMethod): string {
  if (method === "confirm") return "confirmation";
  if (method === "select") return "selection";
  return "input";
}

/** Request title from the bounded payload (bounded fallback). */
export function approvalCardTitle(approval: PendingApproval): string {
  if (typeof approval.payload.title === "string" && approval.payload.title !== "") {
    return approval.payload.title;
  }
  return `Approval requested by ${approval.agent}.`;
}

/** Request message from the bounded payload (may be empty). */
export function approvalCardMessage(approval: PendingApproval): string {
  return typeof approval.payload.message === "string" ? approval.payload.message : "";
}

/** Polite status announcements (never raw internals). */
export function approvalRequestedAnnouncement(approval: PendingApproval): string {
  return `Approval requested by ${approval.agent}.`;
}

export function approvalResponseAnnouncement(agent: string): string {
  return `Approval response sent to ${agent}.`;
}

export function abortAnnouncement(outcome: ConversationAbortOutcome): string {
  return outcome.status === "cancelled" ? "Run aborted." : "No active run.";
}
