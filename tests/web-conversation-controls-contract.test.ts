import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  abortAnnouncement,
  approvalRequestedAnnouncement,
  approvalResponseAnnouncement,
  buildConversationApproveBody,
  parseConversationAbortOutcome,
  parseConversationApprovalFrame,
  parseConversationControlHttpError,
  type ConversationApprovalMethod,
  type PendingApproval,
} from "../web/src/conversation-controls.js";

/**
 * C3-C3 — Conversation Workbench approval/abort controls over the accepted
 * C3-C2 HTTP/SSE surface. Pure fail-closed parsing of the scoped live
 * `approval` frame and the approve/abort envelopes, exactly-one request
 * body construction, bounded error vocabulary, announcement copy, and
 * static pins for the minimal active-only first-party surface (approval
 * card + per-member Abort, no inspection controls, no storage/EventSource/
 * mention authority, no model/config/secret UI).
 */
const webSrc = join(process.cwd(), "web", "src");

function approvalFrame(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    conversationId: "20260807T000000000Z-conv",
    agent: "zai",
    requestId: "ui-req-1",
    method: "confirm",
    payload: { title: "Approve action?", message: "The agent wants to proceed." },
    ...overrides,
  };
}

describe("approval frame parsing (pure, fail-closed)", () => {
  it("accepts a bounded live approval frame for confirm|select|input", () => {
    for (const method of ["confirm", "select", "input"] as ConversationApprovalMethod[]) {
      const parsed = parseConversationApprovalFrame(approvalFrame({ method }));
      expect(parsed).toMatchObject({ conversationId: "20260807T000000000Z-conv", agent: "zai", requestId: "ui-req-1", method });
      expect(parsed.payload).toEqual({ title: "Approve action?", message: "The agent wants to proceed." });
    }
  });

  it("rejects frames with missing, empty, or wrong-typed identity fields", () => {
    expect(() => parseConversationApprovalFrame(approvalFrame({ conversationId: "" }))).toThrow();
    expect(() => parseConversationApprovalFrame(approvalFrame({ agent: 7 }))).toThrow();
    expect(() => parseConversationApprovalFrame(approvalFrame({ requestId: undefined }))).toThrow();
    expect(() => parseConversationApprovalFrame(null)).toThrow();
    expect(() => parseConversationApprovalFrame("nope")).toThrow();
  });

  it("rejects unknown methods and non-object payloads fail-closed", () => {
    expect(() => parseConversationApprovalFrame(approvalFrame({ method: "notify" }))).toThrow(/method/i);
    expect(() => parseConversationApprovalFrame(approvalFrame({ method: 5 }))).toThrow(/method/i);
    expect(() => parseConversationApprovalFrame(approvalFrame({ payload: "text" }))).toThrow(/payload/i);
    expect(() => parseConversationApprovalFrame(approvalFrame({ payload: undefined }))).toThrow(/payload/i);
  });
});

describe("approve/abort request bodies (pure, exactly-one)", () => {
  it("builds exactly one of confirmed|value|cancelled for the declared route", () => {
    const confirmed = buildConversationApproveBody("zai", "ui-req-1", { confirmed: true });
    expect(confirmed).toEqual({ agent: "zai", request_id: "ui-req-1", confirmed: true });
    const cancelled = buildConversationApproveBody("zai", "ui-req-1", { cancelled: true });
    expect(cancelled).toEqual({ agent: "zai", request_id: "ui-req-1", cancelled: true });
    const value = buildConversationApproveBody("zai", "ui-req-1", { value: "pick me" });
    expect(value).toEqual({ agent: "zai", request_id: "ui-req-1", value: "pick me" });
    const responseKeys = (body: Record<string, unknown>): string[] =>
      Object.keys(body).filter((key) => key === "confirmed" || key === "value" || key === "cancelled");
    expect(responseKeys(confirmed)).toEqual(["confirmed"]);
    expect(responseKeys(cancelled)).toEqual(["cancelled"]);
    expect(responseKeys(value)).toEqual(["value"]);
  });

  it("parses the bounded abort outcome envelope", () => {
    expect(parseConversationAbortOutcome({ outcome: { status: "cancelled" } })).toEqual({ status: "cancelled" });
    expect(parseConversationAbortOutcome({ outcome: { status: "no-active-run" } })).toEqual({ status: "no-active-run" });
    expect(() => parseConversationAbortOutcome({ outcome: { status: "bogus" } })).toThrow();
    expect(() => parseConversationAbortOutcome({})).toThrow();
    expect(() => parseConversationAbortOutcome(null)).toThrow();
  });
});

describe("bounded control error parsing (typed, non-secret)", () => {
  it("maps 400 / 404 / 409 / 500 to typed kinds with bounded messages", () => {
    const bad = parseConversationControlHttpError(400, { error: "Exactly one of confirmed, value, or cancelled is required." });
    expect(bad.kind).toBe("bad-request");
    expect(bad.message).toContain("Exactly one of confirmed, value, or cancelled");
    const missing = parseConversationControlHttpError(404, { error: "conversation not found" });
    expect(missing).toEqual({ kind: "not-found", message: "conversation not found" });
    const stale = parseConversationControlHttpError(409, { error: "Unknown or stale approval request 'r' for conversation 'c' and agent 'a'." });
    expect(stale.kind).toBe("stale");
    expect(stale.message).toContain("Unknown or stale approval request");
    const server = parseConversationControlHttpError(500, { error: "internal error" });
    expect(server.kind).toBe("server");
  });

  it("never echoes a 500 body and falls back on malformed bodies", () => {
    expect(parseConversationControlHttpError(500, { error: "ENOENT secret stack" }).message).not.toContain("ENOENT");
    expect(parseConversationControlHttpError(409, null)).toMatchObject({ kind: "stale" });
    expect(parseConversationControlHttpError(400, null)).toMatchObject({ kind: "bad-request" });
    expect(parseConversationControlHttpError(404, null)).toEqual({ kind: "not-found", message: "conversation not found" });
  });
});

describe("announcement vocabulary", () => {
  it("builds the polite status announcements for card, response, and abort", () => {
    const approval: PendingApproval = {
      conversationId: "c",
      agent: "zai",
      requestId: "r",
      method: "confirm",
      payload: { title: "Approve action?" },
    };
    expect(approvalRequestedAnnouncement(approval)).toBe("Approval requested by zai.");
    expect(approvalResponseAnnouncement("zai")).toBe("Approval response sent to zai.");
    expect(abortAnnouncement({ status: "cancelled" })).toBe("Run aborted.");
    expect(abortAnnouncement({ status: "no-active-run" })).toBe("No active run.");
  });
});

describe("static pins: minimal approval/abort Workbench controls (C3-C3)", () => {
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

  it("the transport calls exactly the two C3-C2 endpoints with fixed bodies", async () => {
    const api = await readFile(join(webSrc, "api.ts"), "utf8");
    expect(api).toContain("/approve");
    expect(api).toContain("/abort");
    // The approve body carries agent, request_id, and exactly one response
    // field built by the pure core; the abort body is exactly { agent }.
    expect(api).toMatch(/buildConversationApproveBody/);
    expect(api).toMatch(/JSON\.stringify\(\{\s*agent\s*\}/);
    // No undeclared conversation control verbs are called by the transport.
    expect(api).not.toMatch(/\/conversations\/\$\{[^}]+\}\/(cancel|dispatch|approvals|abort-all)/);
  });

  it("the navigator shows the approval card and Abort only on the ACTIVE surface", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    const activeBranch = navigator.slice(navigator.indexOf("active ? ("), navigator.indexOf(") : ("));
    const readOnlyBranch = navigator.slice(navigator.indexOf(") : ("), navigator.indexOf("attach-banner"));
    expect(activeBranch).toContain("ApprovalCard");
    expect(activeBranch).toContain("Abort");
    expect(readOnlyBranch).not.toContain("ApprovalCard");
    expect(readOnlyBranch).not.toContain("Abort");
  });

  it("no browser storage, EventSource, native confirm, or model/config/secret UI in the controls", async () => {
    const sources = await readAllTs();
    for (const name of ["conversation-controls.ts", "ConversationNavigator.tsx", "ConversationTimeline.tsx", "api.ts"]) {
      const content = sources.get(name) ?? "";
      expect(content.length).toBeGreaterThan(0);
      expect(content, `${name} must not use storage`).not.toMatch(/localStorage|sessionStorage|serviceWorker/);
      expect(content, `${name} must not use native EventSource`).not.toMatch(/new EventSource|EventSource\(/);
      expect(content, `${name} must not use native confirm`).not.toMatch(/window\.confirm|confirm\(/);
      // No model/thinking/provider/key UI or token persistence code patterns
      // (prose words like "non-secret" in comments are not flagged).
      expect(content, `${name} must not expose model/config/secret UI`).not.toMatch(
        /setModel\(|set_thinking|thinkingLevel|api[_-]?key\s*[:=]|localStorage\.setItem\([^)]*token/,
      );
    }
  });

  it("the controls never scan mentions, invent recipients, or derive request ids", async () => {
    const controls = await readFile(join(webSrc, "conversation-controls.ts"), "utf8");
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    expect(controls).not.toMatch(/match\(\s*\/@/);
    expect(navigator).not.toMatch(/match\(\s*\/@/);
    // request ids and agents only ever come from the parsed frame / fixed members.
    expect(controls).toMatch(/requestId/);
    expect(navigator).not.toMatch(/crypto\.randomUUID|Date\.now\(\).*requestId/);
  });

  it("a manual approval Retry re-sends the exact attempted response, never a flipped intent", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    // The submit error state carries the attempted response so a failed
    // Cancel is retried as Cancel, never silently flipped to Confirm/Submit.
    expect(navigator).toContain('phase: "error"; requestId: string; attempted: ApprovalResponse;');
    expect(navigator).toContain("attempted: response,");
    // The card's Retry dispatches the attempted response, not the primary
    // action (a failed Cancel must never retry as Confirm).
    expect(navigator).toContain("onClick={() => onRespond(approval, failure.attempted)}");
  });

  it("the timeline forwards live approval frames and never renders them as durable timeline entries", async () => {
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    const timelineCore = await readFile(join(webSrc, "conversation-timeline.ts"), "utf8");
    expect(timeline).toContain("onApproval");
    expect(timeline).toContain('frame.event === "approval"');
    // The timeline item model has no approval entry type (approvals are
    // live-only, never part of the durable history).
    expect(timelineCore).not.toMatch(/type: "approval"/);
  });
});
