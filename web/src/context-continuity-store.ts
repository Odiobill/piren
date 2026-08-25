/**
 * VR-4 — session-only Context telemetry continuity store (accepted
 * Projects/Piren/workbench-video-capture-readiness-contract.md §7 VR-4).
 *
 * A module-scope browser-memory map keyed EXACTLY `${conversationId}::${agent}`.
 * Each entry holds ONLY an already-validated telemetry facts projection plus
 * its observation time. It lives for the open Workbench lifetime: cleared on
 * page reload (a fresh module instance), Workbench unmount, and token-loss /
 * typed-401 handover. It is NEVER persisted and NEVER reconstructed from
 * durable history, polling, timers, or an open-time fetch.
 *
 * The store never validates telemetry: callers only write already-validated
 * `ConversationTelemetryLiveFacts` (the bounded T3/T4 allowlist — no private
 * session identity or billing facts, and no raw RPC payloads).
 */

import type { ConversationTelemetryLiveFacts } from "./conversation-telemetry.js";

export interface ContextContinuityEntry {
  facts: ConversationTelemetryLiveFacts;
  observedAt: number;
}

export interface ContextContinuityStore {
  remember(conversationId: string, agent: string, facts: ConversationTelemetryLiveFacts, observedAt: number): void;
  recall(conversationId: string, agent: string): ContextContinuityEntry | null;
  forget(conversationId: string, agent: string): void;
  /** Every stored entry for one conversation, in deterministic insertion order. */
  listConversation(conversationId: string): Array<{ agent: string; entry: ContextContinuityEntry }>;
  clear(): void;
}

/** The exact cross-conversation/agent-unambiguous key. */
export function contextContinuityKey(conversationId: string, agent: string): string {
  return `${conversationId}::${agent}`;
}

/** Stable, locale-independent UTC HH:MM:SS for the modal-only restored label. */
export function formatObservedTime(observedAt: number): string {
  return new Date(observedAt).toISOString().slice(11, 19);
}

export function createContextContinuityStore(): ContextContinuityStore {
  // A plain Map keeps insertion order for deterministic listing.
  const entries = new Map<string, ContextContinuityEntry>();
  return {
    remember(conversationId, agent, facts, observedAt) {
      entries.set(contextContinuityKey(conversationId, agent), { facts, observedAt });
    },
    recall(conversationId, agent) {
      return entries.get(contextContinuityKey(conversationId, agent)) ?? null;
    },
    forget(conversationId, agent) {
      entries.delete(contextContinuityKey(conversationId, agent));
    },
    listConversation(conversationId) {
      const prefix = `${conversationId}::`;
      const result: Array<{ agent: string; entry: ContextContinuityEntry }> = [];
      for (const [key, entry] of entries) {
        if (key.startsWith(prefix)) {
          result.push({ agent: key.slice(prefix.length), entry });
        }
      }
      return result;
    },
    clear() {
      entries.clear();
    },
  };
}

/**
 * The Workbench-lifetime default store instance. Cleared on unmount/token
 * handover by the navigator; a page reload naturally produces a fresh module
 * (and therefore a fresh store) — nothing is ever persisted.
 */
export const contextContinuityStore: ContextContinuityStore = createContextContinuityStore();
