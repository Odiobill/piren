/**
 * U2 — Conversation details + rename Workbench pure core (accepted
 * `conversation-details-rename-contract.md` §U2 UI contract / §Gateway).
 *
 * Fail-closed parsing of the authenticated rename envelope and bounded
 * errors, a mirror of the server's bounded title validation (used only for
 * the truthful Save-disable rule and pre-submit copy), and the bounded
 * presentation vocabulary for the details modal. The browser never writes or
 * derives titles, events, lock state, or routing — it sends the raw title to
 * the existing authenticated route, then the navigator re-reads/re-gates.
 */
import { parseConversationRecord, type ConversationRecord } from "./conversations.js";

/** Evidence event echoed by a completed rename (safe shape + both titles). */
export interface RenameEventEvidence {
  id: string;
  conversationId: string;
  kind: string;
  created: string;
  previousTitle: string;
  title: string;
}

export type RenameResponse =
  | { renamed: true; conversation: ConversationRecord; event: RenameEventEvidence }
  | { renamed: false; conversation: ConversationRecord };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function parseRenameEvent(json: unknown): RenameEventEvidence {
  if (!isRecord(json)) throw new Error("unexpected rename event");
  for (const field of ["id", "conversationId", "kind", "created", "previousTitle", "title"] as const) {
    if (!isNonEmptyString(json[field])) {
      throw new Error(`unexpected rename event (${field})`);
    }
  }
  if (json.kind !== "conversation_renamed") {
    throw new Error("unexpected rename event (kind)");
  }
  return {
    id: json.id as string,
    conversationId: json.conversationId as string,
    kind: json.kind as string,
    created: json.created as string,
    previousTitle: json.previousTitle as string,
    title: json.title as string,
  };
}

/**
 * Fail-closed validation of the rename success envelopes: a safe Conversation
 * plus `renamed`; the `event` is REQUIRED exactly when `renamed:true` and
 * FORBIDDEN when false (a same-title repeat writes nothing and appends no
 * event). The event must carry both bounded titles as evidence.
 */
export function parseRenameResponse(json: unknown): RenameResponse {
  if (!isRecord(json)) throw new Error("unexpected rename response");
  const renamed = json.renamed;
  if (renamed !== true && renamed !== false) {
    throw new Error("unexpected rename response (renamed)");
  }
  const conversation = parseConversationRecord(json.conversation);
  if (renamed === true) {
    return { renamed, conversation, event: parseRenameEvent(json.event) };
  }
  // A same-title no-op appends no event: a present `event` on a false rename
  // is contradictory and fails closed.
  if (json.event !== undefined) {
    throw new Error("unexpected rename response (event)");
  }
  return { renamed, conversation };
}

export type RenameErrorKind = "invalid-title" | "not-found" | "conflict" | "server" | "network";

/** Bounded rename error (never fabricates a title or a server outcome). */
export interface RenameError {
  kind: RenameErrorKind;
  message: string;
}

const RENAME_FALLBACK_MESSAGES: Record<"not-found" | "conflict" | "server", string> = {
  "not-found": "conversation not found",
  conflict: "The conversation is busy; retry after it completes.",
  server: "The rename request failed on the server.",
};

/**
 * Map a rename HTTP status + body to a typed bounded error. The server's
 * bounded `{error}` text is reused when present (400 invalid-title, 409
 * conflict); a 404 is deterministic; a 500 body is never echoed raw (the
 * renamed manifest may already be authoritative).
 */
export function parseRenameHttpError(status: number, json: unknown): RenameError {
  if (status === 400) {
    return {
      kind: "invalid-title",
      message: isRecord(json) && typeof json.error === "string" && json.error.trim() !== "" ? json.error.trim().slice(0, 200) : "conversation title is required",
    };
  }
  if (status === 404) {
    return { kind: "not-found", message: RENAME_FALLBACK_MESSAGES["not-found"] };
  }
  const kind: RenameErrorKind = status === 409 ? "conflict" : "server";
  if (isRecord(json) && typeof json.error === "string" && json.error.trim() !== "" && kind !== "server") {
    return { kind, message: json.error.trim().slice(0, 200) };
  }
  return { kind, message: RENAME_FALLBACK_MESSAGES[kind] };
}

/** Bounded title rule mirror (server-authoritative; client uses it for UX only). */
export type ConversationTitleValidation =
  | { ok: true; title: string }
  | { ok: false; reason: "empty" | "control-or-newline" | "too-long" };

export const CONVERSATION_TITLE_MAX = 120;

/** Mirror of the server's trim-normalized single-line 1–120 code-unit rule. */
export function normalizeConversationTitle(raw: string): ConversationTitleValidation {
  const title = raw.trim();
  if (title === "") return { ok: false, reason: "empty" };
  for (let index = 0; index < title.length; index += 1) {
    const code = title.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) {
      return { ok: false, reason: "control-or-newline" };
    }
  }
  if (title.length > CONVERSATION_TITLE_MAX) return { ok: false, reason: "too-long" };
  return { ok: true, title };
}

/** Polite status announcement after an accepted rename (uses the returned title). */
export function renameAnnouncement(title: string): string {
  return `Conversation renamed: ${title}`;
}
