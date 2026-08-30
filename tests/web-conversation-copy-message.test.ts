import { describe, expect, it } from "vitest";
import {
  COPY_FEEDBACK_VISIBLE_MS,
  copyFailureReason,
  copyMessageAccessibleName,
  copyMessagePayload,
  copyStateAfterFailure,
  copyStateAfterSuccess,
  isCopyableMessageRow,
  type CopyFeedbackState,
} from "../web/src/conversation-copy-message.js";
import type { ConversationTranscriptRow } from "../web/src/conversation-transcript.js";
import type { ConversationEventRecord } from "../web/src/conversations.js";

/**
 * W4 — pure eligibility/payload/feedback core for the copy control on
 * durable Conversation message cards (accepted
 * workbench-copy-conversation-message-contract.md). Only ordinary durable
 * steward_message and NON-handoff agent_message transcript rows are
 * eligible; C5 handoff rows (durable agent_message rendering as
 * transcript-handoff) are BINDINGLY excluded, as are all non-message rows.
 */

function event(overrides: Partial<ConversationEventRecord> = {}): ConversationEventRecord {
  return {
    id: "e1",
    conversationId: "c1",
    kind: "agent_message",
    authorKind: "agent",
    author: "dipu",
    created: "2026-08-30T10:00:00.000Z",
    sequence: 1,
    mentions: [],
    body: "hello **world**",
    path: "collaboration/conversations/c1/e1.md",
    ...overrides,
  };
}

function messageRow(overrides: Partial<ConversationEventRecord> = {}): ConversationTranscriptRow {
  return { type: "message", event: event(overrides), statuses: [] };
}

function evidenceRow(kind: string, overrides: Partial<ConversationEventRecord> = {}): ConversationTranscriptRow {
  return { type: "evidence", event: event({ kind, ...overrides }), reaction: null };
}

describe("W4 copy eligibility — full matrix", () => {
  it("accepts ordinary durable steward_message and agent_message cards", () => {
    expect(isCopyableMessageRow(messageRow({ kind: "steward_message", authorKind: "steward", author: "steward" }))).toBe(true);
    expect(isCopyableMessageRow(messageRow())).toBe(true);
  });

  it("BINDINGLY excludes C5 handoff rows even though their durable kind is agent_message", () => {
    const handoff = messageRow({ kind: "agent_message", addressedAgent: "zai" });
    expect(isCopyableMessageRow(handoff)).toBe(false);
  });

  it("excludes every non-message row: system, lifecycle, run, approval, tool, start-origin evidence rows and error rows", () => {
    expect(isCopyableMessageRow(evidenceRow("system"))).toBe(false);
    expect(isCopyableMessageRow(evidenceRow("lifecycle_transition"))).toBe(false);
    expect(isCopyableMessageRow(evidenceRow("run_started"))).toBe(false);
    expect(isCopyableMessageRow(evidenceRow("run_finished"))).toBe(false);
    expect(isCopyableMessageRow(evidenceRow("conversation_start_requested"))).toBe(false);
    expect(isCopyableMessageRow({ type: "error", id: "err", message: "unreadable" })).toBe(false);
  });

  it("fail-safe: a message row with an empty body is not eligible (the control would not render)", () => {
    expect(isCopyableMessageRow(messageRow({ body: "" }))).toBe(false);
  });
});

describe("W4 copy payload and accessible name", () => {
  it("payload is the byte-identical canonical stored body, including Markdown source", () => {
    const markdown = "# Title\n\n- item **bold** `code`\n\n```js\nconst x = 1;\n```";
    expect(copyMessagePayload(event({ body: markdown }))).toBe(markdown);
    const long = "x".repeat(50000);
    expect(copyMessagePayload(event({ body: long }))).toBe(long);
  });

  it("payload is exactly the one record's body — never enriched", () => {
    const body = "plain text";
    expect(copyMessagePayload(event({ body }))).toBe(body);
  });

  it("accessible name names the author exactly once", () => {
    expect(copyMessageAccessibleName(event())).toBe("Copy message from dipu");
    expect(copyMessageAccessibleName(event({ author: "steward", authorKind: "steward" }))).toBe("Copy message from steward");
  });
});

describe("W4 copy feedback state transitions", () => {
  it("success is transient with the 2-second bounded duration constant", () => {
    expect(COPY_FEEDBACK_VISIBLE_MS).toBe(2000);
    const idle: CopyFeedbackState = { kind: "idle" };
    expect(copyStateAfterSuccess(idle)).toEqual({ kind: "copied" });
  });

  it("failure carries only the bounded non-secret reason classes", () => {
    expect(copyFailureReason({ available: false })).toBe("clipboard unavailable");
    expect(copyFailureReason({ available: true, rejected: true })).toBe("clipboard rejected");
    expect(copyStateAfterFailure({ kind: "idle" }, { available: false })).toEqual({
      kind: "failed",
      reason: "clipboard unavailable",
    });
    expect(copyStateAfterFailure({ kind: "idle" }, { available: true, rejected: true })).toEqual({
      kind: "failed",
      reason: "clipboard rejected",
    });
  });

  it("a new gesture replaces the previous feedback state (latest gesture wins)", () => {
    const failed: CopyFeedbackState = { kind: "failed", reason: "clipboard rejected" };
    expect(copyStateAfterSuccess(failed)).toEqual({ kind: "copied" });
    const copied: CopyFeedbackState = { kind: "copied" };
    expect(copyStateAfterFailure(copied, { available: true, rejected: true })).toEqual({
      kind: "failed",
      reason: "clipboard rejected",
    });
  });
});
