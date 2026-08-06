/**
 * C4-A: pure hash-route core for the sole durable route shape
 * `#conversation/<id>`.
 *
 * Deterministic parse/format of valid non-empty conversation ids; malformed
 * and unknown hash shapes are rejected WITHOUT any request. Exposes testable
 * intent/state helpers the Workbench navigator consumes. This module is
 * framework-free and never reads storage, local config, the vault, or the
 * network — the caller supplies the current location hash string.
 *
 * Grammar: the hash is `#conversation/<id>` where `<id>` matches the Piren
 * compact conversation id pattern `^[a-z0-9][a-z0-9-]*$`. Any other hash
 * (empty -> home; anything else -> invalid) is handled by the caller: an
 * invalid route fails truthfully to the Conversation list with a bounded
 * message and never performs a request, creates a draft, dispatches, or
 * mutates a Conversation.
 */

/** The exact hash prefix for the durable conversation route. */
export const CONVERSATION_HASH_PREFIX = "#conversation/";

/** Mirrors the server conversation id pattern (`src/conversations.ts`, case-insensitive). */
const CONVERSATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;

export type HashRoute =
  | { kind: "home" }
  | { kind: "conversation"; conversationId: string }
  | { kind: "invalid"; hash: string };

/** Strip exactly one leading `#` (the caller passes `location.hash`). */
function normalizeHash(hash: string): string {
  return hash.startsWith("#") ? hash.slice(1) : hash;
}

/**
 * Parse a raw location hash (with or without the leading `#`) into the
 * route model. Never throws and never issues a request: malformed and
 * unknown shapes are `invalid` (the caller shows the list with a bounded
 * message).
 */
export function parseHashRoute(hash: string): HashRoute {
  const value = normalizeHash(hash);
  if (value === "") return { kind: "home" };
  if (value.startsWith("conversation/")) {
    const conversationId = value.slice("conversation/".length);
    if (conversationId !== "" && CONVERSATION_ID_PATTERN.test(conversationId) && !conversationId.includes("/")) {
      return { kind: "conversation", conversationId };
    }
  }
  return { kind: "invalid", hash };
}

/**
 * Format the durable hash for a conversation id. Throws on an invalid id
 * (the caller only formats ids the server already validated).
 */
export function formatConversationHash(conversationId: string): string {
  if (conversationId === "" || !CONVERSATION_ID_PATTERN.test(conversationId) || conversationId.includes("/")) {
    throw new Error("Invalid conversation id for the #conversation/<id> route.");
  }
  return `${CONVERSATION_HASH_PREFIX}${conversationId}`;
}

/** True exactly for the valid durable conversation hash shape. */
export function isConversationHash(hash: string): boolean {
  return parseHashRoute(hash).kind === "conversation";
}

/**
 * Strip the fragment from a url string (used to clear the hash when
 * returning to the list). Pure: no browser/history access here.
 */
export function urlWithoutHash(url: string): string {
  const index = url.indexOf("#");
  return index === -1 ? url : url.slice(0, index);
}

/** Explicit intent model the navigator switches on. */
export type HashRouteIntent =
  | { kind: "show-home" }
  | { kind: "open-conversation"; conversationId: string }
  | { kind: "invalid-route"; hash: string };

/** Map a parsed route to its navigation intent (testable state helper). */
export function routeToIntent(route: HashRoute): HashRouteIntent {
  if (route.kind === "home") return { kind: "show-home" };
  if (route.kind === "conversation") return { kind: "open-conversation", conversationId: route.conversationId };
  return { kind: "invalid-route", hash: route.hash };
}
