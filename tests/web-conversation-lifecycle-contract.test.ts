import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  lifecycleAnnouncement,
  lifecycleTransitionLabel,
  parseLifecycleActionResponse,
  parseLifecycleHttpError,
  type LifecycleActionError,
} from "../web/src/conversation-lifecycle.js";
import { parseConversationEvents, type ConversationEventRecord } from "../web/src/conversations.js";

/**
 * L3 — Conversation lifecycle Workbench controls + fresh SSE re-gating over
 * the accepted L1/L2 lifecycle surface. Pure parsing/eligibility of the L2
 * envelope and bounded errors, optional lifecycleState event parsing with
 * fail-closed rejection, timeline label mapping, and static pins for the
 * minimal first-party controls (Archive/Reopen + non-modal confirmation),
 * gateway-authoritative fresh re-gating, and the absence of forbidden
 * browser/routing/backend behavior.
 */
const webSrc = join(process.cwd(), "web", "src");

function conversationRecord(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "20260806T000000000Z-sync",
    path: "collaboration/conversations/20260806T000000000Z-sync",
    title: "Conversation 2026-08-06 00:00 - sync",
    createdBy: "steward",
    audience: [],
    status: "archived",
    created: "2026-08-06T00:00:00.000Z",
    updated: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

function lifecycleEvent(overrides?: Partial<ConversationEventRecord>): ConversationEventRecord {
  return {
    id: "20260806T000000000Z-lc1",
    conversationId: "20260806T000000000Z-sync",
    kind: "lifecycle_transition",
    authorKind: "steward",
    author: "steward",
    created: "2026-08-06T00:00:00.000Z",
    sequence: 2,
    mentions: [],
    body: "Archived by steward.",
    path: "collaboration/conversations/20260806T000000000Z-sync/events/00000002.md",
    ...overrides,
  };
}

describe("L2 lifecycle action envelope parsing (pure, fail-closed)", () => {
  it("accepts a transitioned:true response with the required safe event", () => {
    const parsed = parseLifecycleActionResponse({
      conversation: conversationRecord(),
      transitioned: true,
      event: { id: "e1", conversationId: "c1", kind: "lifecycle_transition", created: "2026-08-06T00:00:00.000Z" },
    });
    if (parsed.transitioned !== true) throw new Error("expected transitioned");
    expect(parsed.conversation.id).toBe("20260806T000000000Z-sync");
    expect(parsed.event.kind).toBe("lifecycle_transition");
  });

  it("accepts a transitioned:false response with NO event", () => {
    const parsed = parseLifecycleActionResponse({ conversation: conversationRecord({ status: "open" }), transitioned: false });
    if (parsed.transitioned !== false) throw new Error("expected no-op");
    expect(parsed.conversation.status).toBe("open");
    expect("event" in parsed).toBe(false);
  });

  it("rejects a true transition without an event and a false transition with an event", () => {
    expect(() => parseLifecycleActionResponse({ conversation: conversationRecord(), transitioned: true })).toThrow(/event/i);
    expect(() =>
      parseLifecycleActionResponse({
        conversation: conversationRecord(),
        transitioned: false,
        event: { id: "e1", conversationId: "c1", kind: "lifecycle_transition", created: "x" },
      }),
    ).toThrow(/event/i);
  });

  it("rejects malformed envelopes fail-closed", () => {
    expect(() => parseLifecycleActionResponse(null)).toThrow();
    expect(() => parseLifecycleActionResponse({})).toThrow();
    expect(() => parseLifecycleActionResponse({ conversation: conversationRecord(), transitioned: "yes" })).toThrow();
    expect(() => parseLifecycleActionResponse({ transitioned: true, event: {} })).toThrow();
  });

  it("rejects a transitioned event with a missing conversation id or wrong kind", () => {
    const base = {
      conversation: conversationRecord(),
      transitioned: true,
      event: { id: "e1", conversationId: "c1", kind: "lifecycle_transition", created: "2026-08-06T00:00:00.000Z" },
    };
    expect(() => parseLifecycleActionResponse({ ...base, event: { ...base.event, conversationId: "" } })).toThrow(/event/i);
    expect(() => parseLifecycleActionResponse({ ...base, event: { ...base.event, kind: "steward_message" } })).toThrow(/event/i);
  });
});

describe("bounded L2 error parsing (typed, non-secret, no status fabrication)", () => {
  it("maps 404 / 409 / 500 to typed kinds with bounded messages", () => {
    expect(parseLifecycleHttpError(404, { error: "conversation not found" })).toEqual({
      kind: "not-found",
      message: "conversation not found",
    });
    const conflict = parseLifecycleHttpError(409, { error: "Conversation 'x' is busy (another update holds the lock); retry after it completes." });
    expect(conflict.kind).toBe("conflict");
    expect(conflict.message).toMatch(/busy/i);
    expect(parseLifecycleHttpError(500, { error: "internal error" })).toEqual({
      kind: "server",
      message: "The conversation lifecycle request failed on the server.",
    });
  });

  it("falls back to a bounded message when the body is absent or malformed", () => {
    expect(parseLifecycleHttpError(409, null).kind).toBe("conflict");
    expect(parseLifecycleHttpError(409, {})).toMatchObject({ kind: "conflict" });
    expect(parseLifecycleHttpError(500, null)).toMatchObject({ kind: "server" });
    expect(parseLifecycleHttpError(404, null)).toEqual({ kind: "not-found", message: "conversation not found" });
    // A 500 body is never echoed raw into the UI.
    expect(parseLifecycleHttpError(500, { error: "ENOENT secret stack" }).message).not.toContain("ENOENT");
  });

  it("never fabricates a status from error responses", () => {
    const error: LifecycleActionError = parseLifecycleHttpError(500, null);
    expect("status" in error).toBe(false);
    expect("transitioned" in error).toBe(false);
  });
});

describe("lifecycleState event parsing + timeline labels", () => {
  it("parses optional lifecycleState open|archived on events", () => {
    const events = parseConversationEvents({ events: [lifecycleEvent({ lifecycleState: "archived" }), lifecycleEvent({ id: "e2", sequence: 3, lifecycleState: "open", body: "Reopened by steward." })] });
    expect(events[0]?.lifecycleState).toBe("archived");
    expect(events[1]?.lifecycleState).toBe("open");
  });

  it("rejects a present-but-invalid lifecycleState fail-closed", () => {
    expect(() => parseConversationEvents({ events: [lifecycleEvent({ lifecycleState: "bogus" as never })] })).toThrow(/lifecycleState/i);
    expect(() => parseConversationEvents({ events: [lifecycleEvent({ lifecycleState: 7 as never })] })).toThrow(/lifecycleState/i);
  });

  it("absent lifecycleState stays absent (backwards compatible)", () => {
    const events = parseConversationEvents({ events: [lifecycleEvent({})] });
    expect(events[0]?.lifecycleState).toBeUndefined();
  });

  it("maps lifecycleState to clear human labels with a bounded fallback", () => {
    expect(lifecycleTransitionLabel("archived")).toBe("Conversation archived");
    expect(lifecycleTransitionLabel("open")).toBe("Conversation reopened");
    expect(lifecycleTransitionLabel(undefined)).toBe("Lifecycle change");
  });

  it("builds the polite status announcements", () => {
    expect(lifecycleAnnouncement("archive")).toBe("Conversation archived.");
    expect(lifecycleAnnouncement("reopen")).toBe("Conversation reopened.");
  });
});

describe("static pins: minimal first-party lifecycle controls (L3)", () => {
  async function readAllTs(): Promise<Map<string, string>> {
    const files = await readdir(webSrc, { recursive: true });
    const sources = new Map<string, string>();
    for (const f of files) {
      if (typeof f === "string" && (f.endsWith(".ts") || f.endsWith(".tsx"))) {
        sources.set(f, await readFile(join(webSrc, f), "utf8"));
      }
    }
    return sources;
  }

  it("the transport calls exactly the two fixed L2 endpoints with the in-memory Bearer", async () => {
    const api = await readFile(join(webSrc, "api.ts"), "utf8");
    expect(api).toContain("/archive");
    expect(api).toContain("/reopen");
    // Only the fixed verbs; no body fields or derived state are sent.
    expect(api).toMatch(/archiveConversation\(id: string, token: string\)/);
    expect(api).toMatch(/reopenConversation\(id: string, token: string\)/);
    expect(api).not.toMatch(/\.status\s*=\s*[^=]/);
  });

  it("the details modal shows Archive on open (active or read-only) and Reopen only on archived inspection, with a non-modal confirmation", async () => {
    // U2 relocated the lifecycle controls INTO the details modal; the routine
    // conversation flow no longer renders them directly.
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    const modal = await readFile(join(webSrc, "ConversationDetailsModal.tsx"), "utf8");
    expect(modal).toContain("Archive");
    expect(modal).toContain("Reopen");
    expect(modal).toContain("Confirm archive");
    expect(modal).toContain("Cancel");
    // The navigator renders the controls only inside the modal.
    expect(navigator).toContain("ConversationDetailsModal");
    // No native/browser modal confirmation anywhere in the surface.
    for (const content of [navigator, modal]) {
      expect(content).not.toContain("window.confirm");
      expect(content).not.toContain("confirm(");
    }
  });

  it("no browser status/membership/event writes or mention derivation in the lifecycle surface", async () => {
    const sources = await readAllTs();
    for (const name of ["conversation-lifecycle.ts", "ConversationNavigator.tsx", "ConversationTimeline.tsx", "conversation-timeline.ts"]) {
      const content = sources.get(name) ?? "";
      expect(content.length).toBeGreaterThan(0);
      // No client-side state derivation: no status assignment, membership
      // mutation, event fabrication, or mention scanning.
      expect(content, `${name} must not assign conversation status`).not.toMatch(/\.status\s*=\s*[^=]/);
      expect(content, `${name} must not fabricate events`).not.toMatch(/lifecycle_transition\s*:|\{\s*type:\s*"lifecycle_transition"/);
      expect(content, `${name} must not scan mentions`).not.toMatch(/match\(\s*\/@/);
      // The browser only ever sends the fixed action + id (no body fields).
      expect(content, `${name} must not write lifecycle bodies`).not.toMatch(/body:\s*JSON\.stringify\(\{[^}]*action|body:\s*JSON\.stringify\(\{[^}]*status/);
    }
  });

  it("the lifecycle announcement seam never survives a failed action or navigation (Kimi review fix)", async () => {
    // lifecycleNoticeRef carries the polite announcement intent to the
    // selection effect. If it is not cleared on failure/navigation paths, a
    // stale intent mis-announces a lifecycle change ("Conversation
    // archived.") on an unrelated later selection — a false screen-reader
    // state claim. Pin the clearing points: resetLifecycleControls, the
    // explicit action's failure branches, and the open flow's failure catch.
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    const resetStart = navigator.indexOf("function resetLifecycleControls()");
    const resetBody = navigator.slice(resetStart, resetStart + 400);
    expect(resetBody).toContain("lifecycleNoticeRef.current = null");
    const actionStart = navigator.indexOf("async function handleLifecycleAction");
    const actionBody = navigator.slice(actionStart, navigator.indexOf("const handleLifecycleEvent"));
    const actionClears = actionBody.match(/lifecycleNoticeRef\.current = null/g) ?? [];
    // 404 branch + conflict branch + network branch (the 500 branch keeps its
    // "derived" intent because it re-gates before presenting any status).
    expect(actionClears.length).toBeGreaterThanOrEqual(3);
    const openStart = navigator.indexOf("const openConversationById");
    const openBody = navigator.slice(openStart, navigator.indexOf("// Initial hash navigation"));
    expect(openBody).toContain("lifecycleNoticeRef.current = null");
  });

  it("the timeline wires the lifecycle SSE re-gate request and a clear label", async () => {
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    const timelineCore = await readFile(join(webSrc, "conversation-timeline.ts"), "utf8");
    expect(timeline).toContain("onLifecycleTransition");
    expect(timeline).toContain("lifecycle_transition");
    // The lifecycle label is wired through the pure timeline label core
    // (C5-4 moved the event labels into the testable pure module).
    expect(timelineCore).toContain("lifecycleTransitionLabel");
    // The re-gate is requested only from the LIVE stream path (no re-gate in
    // the inspection/read-only branch).
    expect(timeline).toContain("live");
  });

  it("forbidden behavior/strings are absent from the lifecycle surface and repo-wide web scans", async () => {
    const sources = await readAllTs();
    for (const [name, content] of sources) {
      // C3-C3 (2026-08-07) authorizes /approve and /abort on the
      // Conversation surface; they are no longer repo-wide forbidden.
      for (const forbidden of ["localStorage", "sessionStorage", "new EventSource", "/api/chat", "/api/vault", "thinking", "window.confirm"]) {
        expect(content, `${name} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("the lifecycle module never references rooms, backend routes, or new endpoints", async () => {
    const lifecycle = await readFile(join(webSrc, "conversation-lifecycle.ts"), "utf8");
    for (const forbidden of ["/api/rooms", "/api/conversations", "/api/chat", "/api/vault"]) {
      expect(lifecycle, `conversation-lifecycle.ts must not reference ${forbidden}`).not.toContain(forbidden);
    }
    const api = await readFile(join(webSrc, "api.ts"), "utf8");
    // Only the two fixed lifecycle verbs beyond the pre-existing family.
    const archiveMatches = api.match(/\/conversations\/\$\{encodeURIComponent\(id\)\}\/(archive|reopen)/g) ?? [];
    expect(new Set(archiveMatches).size).toBeLessThanOrEqual(2);
  });
});
