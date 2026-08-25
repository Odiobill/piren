import { describe, expect, it } from "vitest";
import {
  contextContinuityKey,
  createContextContinuityStore,
  formatObservedTime,
  type ContextContinuityStore,
} from "../web/src/context-continuity-store.js";
import type { ConversationTelemetryLiveFacts } from "../web/src/conversation-telemetry.js";

/**
 * VR-4 — session-only Context continuity store (accepted
 * Projects/Piren/workbench-video-capture-readiness-contract.md §7 VR-4).
 *
 * A module-scope browser-memory map keyed EXACTLY `${conversationId}::${agent}`.
 * Each entry holds only an already-validated telemetry facts projection plus
 * its observation time — no raw SSE, session id/path, transcript, tokens/
 * cost beyond the pre-existing allowlist, or durable record. Lives for the
 * open Workbench lifetime only: cleared by reload (fresh module), Workbench
 * unmount, and token-loss/401 handover — never persisted or reconstructed.
 */

const FACTS: ConversationTelemetryLiveFacts = {
  contextState: "ok",
  context: { tokens: 60000, contextWindow: 200000, percent: 30 },
  model: { provider: "anthropic", id: "claude-sonnet-4" },
  thinkingLevel: "high",
  autoCompactionEnabled: true,
};

function facts(percent: number): ConversationTelemetryLiveFacts {
  return { contextState: "ok", context: { tokens: 1000, contextWindow: 10000, percent } };
}

describe("contextContinuityKey", () => {
  it("keys exactly conversationId::agent (no ambiguity across pairs)", () => {
    expect(contextContinuityKey("c1", "a")).toBe("c1::a");
    expect(contextContinuityKey("c1", "b")).toBe("c1::b");
    expect(contextContinuityKey("c2", "a")).toBe("c2::a");
  });
});

describe("createContextContinuityStore", () => {
  function make(): ContextContinuityStore {
    return createContextContinuityStore();
  }

  it("remembers and recalls an entry for the exact key only", () => {
    const store = make();
    store.remember("c1", "a", FACTS, 1000);
    expect(store.recall("c1", "a")).toEqual({ facts: FACTS, observedAt: 1000 });
    // Cross-conversation and cross-agent isolation.
    expect(store.recall("c1", "b")).toBeNull();
    expect(store.recall("c2", "a")).toBeNull();
  });

  it("a later write replaces the exact key (live/refresh supersession)", () => {
    const store = make();
    store.remember("c1", "a", FACTS, 1000);
    store.remember("c1", "a", facts(42), 2000);
    expect(store.recall("c1", "a")).toEqual({ facts: facts(42), observedAt: 2000 });
  });

  it("independent pairs coexist and never leak into one another", () => {
    const store = make();
    store.remember("c1", "a", facts(10), 100);
    store.remember("c1", "b", facts(20), 200);
    store.remember("c2", "a", facts(30), 300);
    expect(store.recall("c1", "a")?.facts.context?.percent).toBe(10);
    expect(store.recall("c1", "b")?.facts.context?.percent).toBe(20);
    expect(store.recall("c2", "a")?.facts.context?.percent).toBe(30);
  });

  it("lists only the named conversation's entries in insertion order", () => {
    const store = make();
    store.remember("c1", "a", facts(1), 1);
    store.remember("c1", "b", facts(2), 2);
    store.remember("c2", "z", facts(9), 9);
    expect(store.listConversation("c1").map((e) => e.agent)).toEqual(["a", "b"]);
    expect(store.listConversation("c2").map((e) => e.agent)).toEqual(["z"]);
  });

  it("forget removes one exact key; clear removes all entries", () => {
    const store = make();
    store.remember("c1", "a", FACTS, 1);
    store.remember("c1", "b", FACTS, 2);
    store.forget("c1", "a");
    expect(store.recall("c1", "a")).toBeNull();
    expect(store.recall("c1", "b")).not.toBeNull();
    store.clear();
    expect(store.listConversation("c1")).toEqual([]);
  });

  it("the store holds ONLY the closed facts projection plus observation time", () => {
    const store = make();
    store.remember("c1", "a", FACTS, 1000);
    const entry = store.recall("c1", "a")!;
    expect(Object.keys(entry).sort()).toEqual(["facts", "observedAt"]);
    expect(typeof entry.observedAt).toBe("number");
  });
});

describe("formatObservedTime", () => {
  it("produces a stable UTC HH:MM:SS label (locale-independent, testable)", () => {
    // 2026-08-25T14:03:22.000Z -> "14:03:22"
    expect(formatObservedTime(Date.UTC(2026, 7, 25, 14, 3, 22))).toBe("14:03:22");
  });
});

// --- Static boundary pins (VR-4): memory-only, no persistence/reconstruction ---
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("VR-4 static boundaries", () => {
  it("the continuity store uses browser memory only — no storage/cookie/timer/polling/history reconstruction", async () => {
    const store = await readFile(join(process.cwd(), "web", "src", "context-continuity-store.ts"), "utf8");
    for (const forbidden of [
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "document.cookie",
      "setInterval",
      "setTimeout",
      "fetch(",
      "get_messages",
      "WebSocket",
      "EventSource",
      "EventTarget",
    ]) {
      expect(store, `store must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("the store holds only the validated facts projection plus an observation timestamp", async () => {
    const store = await readFile(join(process.cwd(), "web", "src", "context-continuity-store.ts"), "utf8");
    expect(store).toContain("facts: ConversationTelemetryLiveFacts");
    expect(store).toContain("observedAt: number");
    // No raw/session/path/transcript/token/cost fields may be declared.
    expect(store).not.toContain("sessionFile");
    expect(store).not.toContain("sessionId");
    expect(store).not.toContain("transcript");
    expect(store).not.toContain("cost");
  });
});
