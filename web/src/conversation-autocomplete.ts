/**
 * U3 — server-authoritative mention autocomplete pure core (accepted 0.2.0
 * UX plan §U3).
 *
 * The `@` convenience list is sourced ONLY from the locally runnable roster
 * (local policy `online` — never a live presence or membership derivation).
 * This module detects a caret-local `@token` to offer completions and edits
 * the draft TEXT ONLY (`@name ` insertion). It never parses, resolves, or
 * derives dispatch recipients, membership, or routing — the gateway remains
 * the sole mention parser, recipient resolver, and atomic invalid-mention
 * rejector. The request body the browser sends stays exactly `{text}`.
 */
import type { ConversationAgentEntry } from "./conversation-agents.js";

export interface MentionTrigger {
  /** Index of the `@` that starts the token. */
  start: number;
  /** The partial name between `@` and the caret (possibly empty). */
  token: string;
}

export type MentionTriggerResult = { ok: true; trigger: MentionTrigger } | { ok: false };

function isWordChar(ch: string): boolean {
  return ch !== "" && ch !== "@" && ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r";
}

/**
 * Find the `@` immediately preceding the caret within the current word
 * (no whitespace between the `@` and the caret). Never a regex-match over the
 * text — purely caret-local detection for the convenience picker.
 */
export function findMentionTrigger(text: string, caret: number): MentionTriggerResult {
  if (caret <= 0) return { ok: false };
  let cursor = caret - 1;
  if (text[cursor] === "@") return { ok: true, trigger: { start: cursor, token: "" } };
  if (!isWordChar(text[cursor] ?? "")) return { ok: false };
  while (cursor >= 0 && isWordChar(text[cursor] ?? "")) cursor -= 1;
  if (cursor < 0 || text[cursor] !== "@") return { ok: false };
  return { ok: true, trigger: { start: cursor, token: text.slice(cursor + 1, caret) } };
}

/**
 * Runnable-only convenience list: locally runnable roster entries whose name
 * starts with the token (case-insensitive), deterministically sorted. An
 * offline/excluded agent is never offered.
 */
export function filterRunnableCompletions(roster: readonly ConversationAgentEntry[], token: string): string[] {
  const needle = token.toLowerCase();
  return roster
    .filter((entry) => entry.online)
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().startsWith(needle))
    .sort();
}

export interface AppliedCompletion {
  text: string;
  /** Caret position after the inserted `@name ` span. */
  caret: number;
}

/** Replace the `@token` span with `@name ` and move the caret after it (text only). */
export function applyMentionCompletion(text: string, caret: number, triggerStart: number, name: string): AppliedCompletion {
  const before = text.slice(0, triggerStart);
  const after = text.slice(caret);
  return { text: `${before}@${name} ${after}`, caret: before.length + name.length + 2 };
}

/** Wrapped index navigation over the visible completion list (safe for empty lists). */
export function nextCompletionIndex(active: number, count: number, delta: number): number {
  if (count <= 0) return -1;
  if (active < 0) return delta > 0 ? 0 : count - 1;
  return (active + delta + count) % count;
}
