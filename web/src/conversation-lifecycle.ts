/**
 * L3 — Conversation lifecycle Workbench pure core.
 *
 * Fail-closed parsing of the accepted L2 archive/reopen envelopes and bounded
 * errors, plus the minimal presentation vocabulary (labels, announcements,
 * confirmation copy) for the first-party Workbench controls. The browser
 * never writes or derives `status`, membership, events, lock state, routing,
 * or an active-session decision — it only sends the fixed action + selected
 * id to the existing L2 routes, then re-runs the C4-A fresh manifest/attach
 * gate before deciding active/read-only.
 */
import { parseConversationRecord, type ConversationRecord } from "./conversations.js";

/** The only two lifecycle actions the Workbench ever sends. */
export type ConversationLifecycleAction = "archive" | "reopen";

export interface LifecycleTransitionEvent {
  id: string;
  conversationId: string;
  kind: string;
  created: string;
}

export type LifecycleActionResponse =
  | { transitioned: true; conversation: ConversationRecord; event: LifecycleTransitionEvent }
  | { transitioned: false; conversation: ConversationRecord };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseLifecycleEvent(json: unknown): LifecycleTransitionEvent {
  if (!isRecord(json)) throw new Error("unexpected lifecycle event");
  const event = json as Partial<LifecycleTransitionEvent>;
  if (typeof event.id !== "string" || event.id === "" || typeof event.kind !== "string" || typeof event.created !== "string") {
    throw new Error("unexpected lifecycle event");
  }
  return {
    id: event.id,
    conversationId: typeof event.conversationId === "string" ? event.conversationId : "",
    kind: event.kind,
    created: event.created,
  };
}

/**
 * Fail-closed validation of the L2 lifecycle success envelopes: a safe
 * Conversation plus `transitioned`; the `event` is REQUIRED exactly when
 * `transitioned:true` and FORBIDDEN when false (a same-target repeat writes
 * nothing and appends no event).
 */
export function parseLifecycleActionResponse(json: unknown): LifecycleActionResponse {
  if (!isRecord(json)) throw new Error("unexpected lifecycle response");
  const transitioned = json.transitioned;
  if (transitioned !== true && transitioned !== false) {
    throw new Error("unexpected lifecycle response (transitioned)");
  }
  const conversation = parseConversationRecord(json.conversation);
  if (transitioned === true) {
    return { transitioned, conversation, event: parseLifecycleEvent(json.event) };
  }
  // A same-target repeat appends no event: a present `event` on a false
  // transition is contradictory and fails closed.
  if (json.event !== undefined) {
    throw new Error("unexpected lifecycle response (event)");
  }
  return { transitioned, conversation };
}

export type LifecycleActionErrorKind = "not-found" | "conflict" | "server" | "network";

/** Bounded lifecycle action error (never fabricates a status). */
export interface LifecycleActionError {
  kind: LifecycleActionErrorKind;
  message: string;
}

const FALLBACK_MESSAGES: Record<"not-found" | "conflict" | "server", string> = {
  "not-found": "conversation not found",
  conflict: "The conversation lifecycle change is busy; retry after it completes.",
  server: "The conversation lifecycle request failed on the server.",
};

/**
 * Map an L2 lifecycle error HTTP status + body to a typed bounded error.
 * The server's bounded `{error}` text is reused when present; otherwise a
 * deterministic fallback. A 500 body is never echoed raw.
 */
export function parseLifecycleHttpError(status: number, json: unknown): LifecycleActionError {
  if (status === 404) {
    return { kind: "not-found", message: FALLBACK_MESSAGES["not-found"] };
  }
  const kind: LifecycleActionErrorKind = status === 409 ? "conflict" : "server";
  if (isRecord(json) && typeof json.error === "string" && json.error.trim() !== "") {
    const raw = json.error.trim();
    if (kind === "server") {
      // Bounded 500: never leak raw filesystem/typed internals; always the
      // deterministic message (the manifest may already have transitioned).
      return { kind, message: FALLBACK_MESSAGES.server };
    }
    return { kind, message: raw.slice(0, 200) };
  }
  return { kind, message: FALLBACK_MESSAGES[kind] };
}

/** Human label for a rendered lifecycle event (bounded neutral fallback). */
export function lifecycleTransitionLabel(lifecycleState: "open" | "archived" | undefined): string {
  if (lifecycleState === "archived") return "Conversation archived";
  if (lifecycleState === "open") return "Conversation reopened";
  return "Lifecycle change";
}

/** Polite status announcement after an accepted lifecycle action/re-gate. */
export function lifecycleAnnouncement(action: ConversationLifecycleAction): string {
  return action === "archive" ? "Conversation archived." : "Conversation reopened.";
}

/** Bounded copy for the non-modal archive confirmation card. */
export function archiveConfirmationCopy(): { intro: string; confirm: string; cancel: string } {
  return {
    intro: "Archiving this conversation makes it read-only: it stops accepting messages and cannot be attached as active until reopened. Runs already in flight are not aborted.",
    confirm: "Confirm archive",
    cancel: "Cancel",
  };
}
