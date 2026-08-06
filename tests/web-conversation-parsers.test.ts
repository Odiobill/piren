import { describe, expect, it } from "vitest";
import {
  parseConversationEnvelope,
  parseConversationEvents,
  parseConversationList,
  parseConversationRecord,
  type ConversationEventRecord,
  type ConversationRecord,
} from "../web/src/conversations.js";
import {
  classifyAudienceMembers,
  parseAttachResponse,
  resolveAttachPresentation,
  type AttachGate,
} from "../web/src/attach.js";
import {
  parseConversationCreateResponse,
  parseConversationMessageResponse,
  toConversationMessageRequest,
  validateConversationText,
} from "../web/src/conversation-composer.js";
import {
  appendConversationLiveItem,
  conversationFrameToItem,
  replaceConversationHistoric,
} from "../web/src/conversation-timeline.js";
import { createSseParser } from "../web/src/timeline.js";

/**
 * C3-A: pure web Conversation surface cores (fake-Pi/node-testable, no live
 * auth). Fail-closed parsers for the accepted C2 `/api/conversations*`
 * family plus the C3-A attach gate presentation decision. The browser never
 * scans, resolves, or derives dispatch recipients from `@text`: the composer
 * builds a raw `{text}` body only, and the attach presentation is decided by
 * the server-authoritative attach response.
 */

function conversation(overrides: Partial<ConversationRecord>): ConversationRecord {
  return {
    id: "20260806T000000000Z-sync",
    path: "collaboration/conversations/20260806T000000000Z-sync",
    title: "Conversation 2026-08-06 00:00 - sync",
    createdBy: "steward",
    audience: ["dipu"],
    status: "open",
    created: "2026-08-06T00:00:00.000Z",
    updated: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

function event(overrides: Partial<ConversationEventRecord>): ConversationEventRecord {
  return {
    id: "20260806T000000000Z-e1",
    conversationId: "20260806T000000000Z-sync",
    kind: "steward_message",
    authorKind: "steward",
    author: "steward",
    created: "2026-08-06T00:00:00.000Z",
    sequence: 1,
    mentions: [],
    body: "hello",
    path: "collaboration/conversations/20260806T000000000Z-sync/events/00000001.md",
    ...overrides,
  };
}

describe("conversation record parsers (fail-closed)", () => {
  it("accepts the documented conversation record shape", () => {
    const record = conversation({});
    expect(parseConversationRecord(record)).toEqual(record);
  });

  it("rejects malformed records fail-closed", () => {
    expect(() => parseConversationRecord(null)).toThrow();
    expect(() => parseConversationRecord({})).toThrow();
    expect(() => parseConversationRecord({ id: "" })).toThrow();
    expect(() => parseConversationRecord({ id: "x", title: "t", status: "open", audience: "nope" })).toThrow();
    expect(() => parseConversationRecord({ id: "x", title: "t", status: "open", audience: [7] })).toThrow();
  });

  it("accepts list and envelope wrappers and rejects malformed ones", () => {
    expect(parseConversationList({ conversations: [conversation({})] })).toEqual({ conversations: [conversation({})] });
    expect(parseConversationList({ conversations: [] })).toEqual({ conversations: [] });
    expect(() => parseConversationList(null)).toThrow();
    expect(() => parseConversationList({})).toThrow();
    expect(() => parseConversationList({ conversations: "nope" })).toThrow();
    expect(parseConversationEnvelope({ conversation: conversation({}) })).toEqual(conversation({}));
    expect(() => parseConversationEnvelope({})).toThrow();
    expect(() => parseConversationEnvelope(null)).toThrow();
  });

  it("accepts the documented event record shape with optional fields", () => {
    const parsed = parseConversationEvents({ events: [event({ runStatus: "completed" }), event({ id: "e2", sequence: 2, failureKind: "ambiguous" })] });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.runStatus).toBe("completed");
    expect(parsed[1]?.failureKind).toBe("ambiguous");
  });

  it("rejects malformed event records fail-closed", () => {
    expect(() => parseConversationEvents(null)).toThrow();
    expect(() => parseConversationEvents({})).toThrow();
    expect(() => parseConversationEvents({ events: "nope" })).toThrow();
    expect(() => parseConversationEvents({ events: [{ id: "x" }] })).toThrow();
    expect(() => parseConversationEvents({ events: [event({ sequence: 0 })] })).toThrow();
    expect(() => parseConversationEvents({ events: [event({ mentions: "nope" as unknown as string[] })] })).toThrow();
  });
});

describe("attach response parsing and presentation (pure eligibility)", () => {
  const okGate: AttachGate = { ok: true, missing: [], malformed: [] };
  const rejectedGate: AttachGate = { ok: false, missing: ["ghost"], malformed: [] };

  it("parses an attached response and resolves the active presentation", () => {
    const parsed = parseAttachResponse({ conversation: conversation({}), attached: true, gate: okGate });
    if (parsed.attached !== true) throw new Error("expected attached response");
    expect(parsed.conversation.id).toBe(conversation({}).id);
    expect(resolveAttachPresentation(parsed)).toBe("active");
  });

  it("parses a rejected response and resolves the read-only presentation", () => {
    const parsed = parseAttachResponse({ attached: false, error: "not runnable", gate: rejectedGate });
    if (parsed.attached) throw new Error("expected rejected response");
    expect(parsed.error).toMatch(/not runnable/);
    expect(parsed.gate.missing).toEqual(["ghost"]);
    expect(resolveAttachPresentation(parsed)).toBe("read-only");
  });

  it("rejects malformed attach responses fail-closed", () => {
    expect(() => parseAttachResponse(null)).toThrow();
    expect(() => parseAttachResponse({})).toThrow();
    expect(() => parseAttachResponse({ attached: true })).toThrow();
    expect(() => parseAttachResponse({ error: "x" })).toThrow();
    expect(() => parseAttachResponse({ attached: false, error: "x", gate: { ok: true } })).toThrow();
    expect(() => parseAttachResponse({ conversation: conversation({}), attached: true, gate: { ok: "yes" } })).toThrow();
  });

  it("classifies durable audience members against the local roster", () => {
    const roster = [
      { name: "dipu", online: true },
      { name: "kimi", online: false },
    ];
    expect(classifyAudienceMembers(["dipu", "kimi", "sam"], roster)).toEqual([
      { name: "dipu", runnable: true },
      { name: "kimi", runnable: false },
      { name: "sam", runnable: false },
    ]);
    expect(classifyAudienceMembers([], roster)).toEqual([]);
  });
});

describe("raw-text conversation composer core (never derives recipients)", () => {
  it("requires non-empty trimmed text", () => {
    expect(validateConversationText("")).toEqual({ ok: false, reason: "text required" });
    expect(validateConversationText("   ")).toEqual({ ok: false, reason: "text required" });
    expect(validateConversationText("please review @dipu")).toEqual({ ok: true });
  });

  it("builds a raw {text} request body only — no recipient/agent field ever", () => {
    const request = toConversationMessageRequest("  please review @dipu  ");
    expect(request).toEqual({ text: "please review @dipu" });
    expect(Object.keys(request)).toEqual(["text"]);
  });

  it("parses the message response envelope with optional dispatch", () => {
    const base = { event: { id: "e1", conversationId: "c1", kind: "steward_message", created: "2026-08-06T00:00:00.000Z" } };
    expect(parseConversationMessageResponse(base)).toEqual({ event: base.event });
    expect(
      parseConversationMessageResponse({ ...base, dispatch: [{ agent: "dipu", status: "completed" }] }),
    ).toEqual({ event: base.event, dispatch: [{ agent: "dipu", status: "completed" }] });
  });

  it("rejects malformed message responses fail-closed", () => {
    expect(() => parseConversationMessageResponse(null)).toThrow();
    expect(() => parseConversationMessageResponse({})).toThrow();
    expect(() => parseConversationMessageResponse({ event: { id: "x" } })).toThrow();
  });

  it("parses the create response envelope (conversation + event + optional dispatch)", () => {
    const record = conversation({});
    const event = { id: "e1", conversationId: record.id, kind: "steward_message", created: "2026-08-06T00:00:00.000Z" };
    const parsed = parseConversationCreateResponse({ conversation: record, event });
    expect(parsed.conversation.id).toBe(record.id);
    expect(parsed.event.kind).toBe("steward_message");
    expect("dispatch" in parsed).toBe(false);
    expect(() => parseConversationCreateResponse({ event })).toThrow();
  });
});

describe("conversation timeline core (immutable, live-only after attach)", () => {
  it("maps a live conversation_event SSE frame to a display item", () => {
    const parser = createSseParser();
    const frames = parser.push(`event: conversation_event\ndata: ${JSON.stringify(event({ kind: "agent_message" }))}\n\n`);
    const item = conversationFrameToItem(frames[0] as { event: string; data: string });
    expect(item).not.toBeNull();
    if (item !== null && item.type === "event") {
      expect(item.event.kind).toBe("agent_message");
    }
  });

  it("malformed or unknown frames become non-authoritative error items, never crashes", () => {
    const bad = conversationFrameToItem({ event: "conversation_event", data: "{not json" });
    expect(bad).not.toBeNull();
    if (bad !== null) expect(bad.type).toBe("error");
    const unknown = conversationFrameToItem({ event: "something_else", data: "{}" });
    if (unknown !== null) expect(unknown.type).toBe("error");
  });

  it("live items dedupe by id; historic replacement renders the durable sequence", () => {
    const e1 = event({ id: "e1" });
    const e2 = event({ id: "e2", sequence: 2, kind: "run_finished", runStatus: "completed" });
    const base = appendConversationLiveItem([], { type: "event", id: e1.id, event: e1 });
    expect(appendConversationLiveItem(base, { type: "event", id: e1.id, event: e1 })).toHaveLength(1);
    expect(appendConversationLiveItem(base, { type: "event", id: e2.id, event: e2 })).toHaveLength(2);
    expect(replaceConversationHistoric([e1, e2])).toHaveLength(2);
  });
});
