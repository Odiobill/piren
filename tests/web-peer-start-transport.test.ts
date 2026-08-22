import { describe, expect, it } from "vitest";
import { parsePeerStartResponse, toPeerStartRequest } from "../web/src/conversation-start.js";

/**
 * P3.3 (workbench-ux-follow-up-design §1.5; accepted P2/P3.2) — typed
 * peer-audience start client core: the only request body is the exact P2
 * `{peers}` shape; the only accepted response is the 201 safe
 * `{conversation, event}` projection with dispatch ABSENT (peer creation
 * contacts no broker).
 */

const CONVERSATION = {
  id: "c9",
  title: "Conversation with 2 agents",
  audience: ["dipu", "kimi"],
  status: "open",
  path: "collaboration/conversations/c9/index.md",
  createdBy: "steward",
  created: "2026-08-22T13:00:00.000Z",
  updated: "2026-08-22T13:00:00.000Z",
};

describe("toPeerStartRequest", () => {
  it("builds exactly {peers} with a copy of the names", () => {
    const peers = ["dipu", "kimi"];
    expect(toPeerStartRequest(peers)).toEqual({ peers: ["dipu", "kimi"] });
  });
});

describe("parsePeerStartResponse", () => {
  it("parses the 201 safe {conversation, event} response", () => {
    const parsed = parsePeerStartResponse({
      conversation: CONVERSATION,
      event: { id: "e1", conversationId: "c9", kind: "conversation_start_requested", created: "2026-08-22T13:00:01.000Z" },
    });
    expect(parsed.conversation.id).toBe("c9");
    expect(parsed.event.kind).toBe("conversation_start_requested");
    expect("dispatch" in parsed).toBe(false);
  });

  it("fails closed when dispatch is present or the shape is wrong", () => {
    expect(() =>
      parsePeerStartResponse({ conversation: CONVERSATION, event: { id: "e1", kind: "k", created: "t" }, dispatch: [] }),
    ).toThrow();
    expect(() => parsePeerStartResponse({ conversation: CONVERSATION })).toThrow();
    expect(() => parsePeerStartResponse(null)).toThrow();
  });
});
