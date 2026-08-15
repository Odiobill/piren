/**
 * C3-A: raw-text Conversation composer core.
 *
 * The Conversation composer sends RAW text to the accepted C2 follow-up
 * route (`POST /api/conversations/<id>/messages`). The gateway alone parses
 * and validates `@`-mentions against the local runnable set (C1 server
 * authority; C0 §6): the browser NEVER scans, resolves, or derives dispatch
 * recipients from `@text`. The request body is exactly `{text}` — there is
 * no recipient/agent field anywhere. ADR-0044: the browser-local draft
 * first-message path is removed; new Conversations start via the Dashboard's
 * `POST /api/conversations/start` (see conversation-start.ts).
 */

/** The only request body shape the composer ever builds. */
export interface ConversationMessageRequest {
  text: string;
}

/**
 * U3 — bounded auto-grow composer geometry (accepted 0.2.0 UX plan §U3).
 * The runtime path reads the textarea `scrollHeight` and clamps it into this
 * range; the estimate is the deterministic SSR/static fallback.
 */
export const COMPOSER_MIN_HEIGHT_PX = 44;
export const COMPOSER_MAX_HEIGHT_PX = 200;
export const COMPOSER_LINE_HEIGHT_PX = 22;
export const COMPOSER_CHARS_PER_LINE = 60;

/** Clamp a content height into the bounded composer range. */
export function clampComposerHeight(height: number, min: number, max: number): number {
  return Math.min(Math.max(height, min), max);
}

/**
 * Deterministic estimated content height in px (newlines + a conservative
 * wrap at `charsPerLine`), clamped into the bounded composer range. Used as
 * the static/SSR fallback; the DOM `scrollHeight` path refines it at runtime.
 */
export function estimateComposerHeightPx(
  text: string,
  options?: { charsPerLine?: number; lineHeightPx?: number },
): number {
  const charsPerLine = options?.charsPerLine ?? COMPOSER_CHARS_PER_LINE;
  const lineHeightPx = options?.lineHeightPx ?? COMPOSER_LINE_HEIGHT_PX;
  const lines = text.split("\n");
  const total = lines.reduce(
    (sum, line) => sum + Math.max(1, Math.ceil(line.length / Math.max(1, charsPerLine))),
    0,
  );
  return clampComposerHeight(total * lineHeightPx, COMPOSER_MIN_HEIGHT_PX, COMPOSER_MAX_HEIGHT_PX);
}

/**
 * U3 + P1 — keyboard submit decision. Two page-local policies (accepted
 * workbench chat-surface polish plan P1): `enter` submits on a plain Enter
 * (Shift/Ctrl/Meta+Enter insert a newline); `ctrl-enter` submits only on
 * Ctrl+Enter (Enter/Shift+Enter insert newlines). ANY IME/composition state
 * must prevent a premature submit in either mode.
 */
export type ConversationSubmitPolicy = "enter" | "ctrl-enter";

/** The full key state needed for a deterministic submit decision. */
export interface ConversationSubmitKeyState {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

export function shouldSubmitForPolicy(state: ConversationSubmitKeyState, policy: ConversationSubmitPolicy): boolean {
  if (state.key !== "Enter" || state.isComposing) return false;
  if (policy === "enter") {
    return !state.shiftKey && !state.ctrlKey && !state.metaKey;
  }
  return state.ctrlKey && !state.shiftKey && !state.metaKey;
}

/** Accessible name that discloses the currently selected submit policy. */
export function submitPolicyAccessibleName(policy: ConversationSubmitPolicy): string {
  return policy === "enter" ? "Submit with Enter" : "Submit with Ctrl+Enter";
}

/** Tooltip that discloses the exact key semantics of the selected policy. */
export function submitPolicyTooltip(policy: ConversationSubmitPolicy): string {
  return policy === "enter"
    ? "Enter sends the message; Shift+Enter inserts a newline."
    : "Ctrl+Enter sends the message; Enter inserts a newline.";
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
