import { describe, expect, it } from "vitest";
import type { RpcEvent } from "../src/gateway-rpc.js";
import {
  ROOM_HANDOFF_MAX_REPLY_LENGTH,
  ROOM_HANDOFF_MAX_TEXT_LENGTH,
  ROOM_HANDOFF_PROTOCOL_VERSION,
  ROOM_HANDOFF_REQUEST_TITLE,
  ROOM_HANDOFF_RESULT_STATUSES,
  ROOM_HANDOFF_TRUNCATION_MARKER,
  ROOM_MENTION_ENABLED_ENV_VAR,
  isHandoffInputRequest,
  isRoomMentionEnabled,
  parseHandoffInputRequest,
  parseHandoffResultValue,
  renderHandoffRequestPlaceholder,
  renderHandoffResultValue,
  resolveRoomMentionToolResult,
  truncateHandoffReply,
  validateRoomMentionArgs,
  type RoomHandoffResult,
} from "../src/room-handoff-protocol.js";

function requestEvent(overrides: Partial<RpcEvent> = {}): RpcEvent {
  return {
    type: "extension_ui_request",
    id: "req-1",
    method: "input",
    title: ROOM_HANDOFF_REQUEST_TITLE,
    placeholder: JSON.stringify({ v: 1, to: "thor", text: "Summarize the report." }),
    ...overrides,
  };
}

describe("room handoff protocol constants", () => {
  it("exports a fixed protocol version, a reserved request title, a fixed text budget, and the result statuses", () => {
    expect(ROOM_HANDOFF_PROTOCOL_VERSION).toBe(1);
    expect(typeof ROOM_HANDOFF_REQUEST_TITLE).toBe("string");
    expect(ROOM_HANDOFF_REQUEST_TITLE).not.toBe("");
    expect(ROOM_HANDOFF_MAX_TEXT_LENGTH).toBeGreaterThan(0);
    expect(ROOM_HANDOFF_RESULT_STATUSES).toEqual(["ok", "rejected", "failed", "timed_out", "cancelled"]);
  });
});

describe("isHandoffInputRequest", () => {
  it("matches a reserved method:input request with the exact reserved title", () => {
    expect(isHandoffInputRequest(requestEvent())).toBe(true);
  });

  it("rejects non-extension_ui_request events", () => {
    expect(isHandoffInputRequest({ type: "agent_end" })).toBe(false);
    expect(isHandoffInputRequest({ type: "message_update" })).toBe(false);
  });

  it("rejects confirm and select requests even with the reserved title", () => {
    expect(isHandoffInputRequest(requestEvent({ method: "confirm" }))).toBe(false);
    expect(isHandoffInputRequest(requestEvent({ method: "select" }))).toBe(false);
  });

  it("rejects an input request whose title is not the exact reserved discriminator", () => {
    expect(isHandoffInputRequest(requestEvent({ title: "Enter a value:" }))).toBe(false);
    expect(isHandoffInputRequest(requestEvent({ title: "piren:room-handoff:v2" }))).toBe(false);
    expect(isHandoffInputRequest({ type: "extension_ui_request", id: "r", method: "input" })).toBe(false);
  });
});

describe("parseHandoffInputRequest", () => {
  it("parses a valid versioned request into version, target, and text", () => {
    const parsed = parseHandoffInputRequest(requestEvent());
    expect(parsed).toEqual({ ok: true, version: 1, to: "thor", text: "Summarize the report." });
  });

  it("rejects a missing or non-string placeholder", () => {
    expect(parseHandoffInputRequest(requestEvent({ placeholder: undefined }))).toEqual({
      ok: false,
      reason: expect.any(String),
    });
    const missing = parseHandoffInputRequest(requestEvent({ placeholder: undefined }));
    if (!missing.ok) expect(missing.reason).toMatch(/placeholder/i);
    const nonString = parseHandoffInputRequest(requestEvent({ placeholder: 42 }));
    if (!nonString.ok) expect(nonString.reason).toMatch(/placeholder/i);
  });

  it("rejects a placeholder that is not valid JSON", () => {
    const parsed = parseHandoffInputRequest(requestEvent({ placeholder: "{not json" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/json/i);
  });

  it("rejects a placeholder that is valid JSON but not an object", () => {
    const parsed = parseHandoffInputRequest(requestEvent({ placeholder: JSON.stringify(["nope"]) }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/object/i);
  });

  it("rejects a version mismatch (wrong version and missing version)", () => {
    const wrong = parseHandoffInputRequest(
      requestEvent({ placeholder: JSON.stringify({ v: 2, to: "thor", text: "x" }) }),
    );
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toMatch(/version/i);
    const missing = parseHandoffInputRequest(
      requestEvent({ placeholder: JSON.stringify({ to: "thor", text: "x" }) }),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toMatch(/version/i);
  });

  it("rejects a missing, empty, or invalid target agent name", () => {
    const missing = parseHandoffInputRequest(requestEvent({ placeholder: JSON.stringify({ v: 1, text: "x" }) }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toMatch(/target|agent/i);
    const empty = parseHandoffInputRequest(
      requestEvent({ placeholder: JSON.stringify({ v: 1, to: "", text: "x" }) }),
    );
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toMatch(/target|agent/i);
    const invalid = parseHandoffInputRequest(
      requestEvent({ placeholder: JSON.stringify({ v: 1, to: "Bad Name", text: "x" }) }),
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.reason).toMatch(/target|agent/i);
  });

  it("rejects blank request text", () => {
    const parsed = parseHandoffInputRequest(
      requestEvent({ placeholder: JSON.stringify({ v: 1, to: "thor", text: "   " }) }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/blank|text/i);
  });

  it("rejects request text exceeding the fixed maximum length", () => {
    const oversized = "x".repeat(ROOM_HANDOFF_MAX_TEXT_LENGTH + 1);
    const parsed = parseHandoffInputRequest(
      requestEvent({ placeholder: JSON.stringify({ v: 1, to: "thor", text: oversized }) }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/length|size|maximum/i);
  });

  it("accepts request text exactly at the fixed maximum length", () => {
    const exact = "x".repeat(ROOM_HANDOFF_MAX_TEXT_LENGTH);
    const parsed = parseHandoffInputRequest(
      requestEvent({ placeholder: JSON.stringify({ v: 1, to: "thor", text: exact }) }),
    );
    expect(parsed.ok).toBe(true);
  });
});

describe("renderHandoffResultValue and parseHandoffResultValue", () => {
  const cases: RoomHandoffResult[] = [
    { status: "ok", reply: "Done: 42" },
    { status: "rejected", reason: "target not runnable" },
    { status: "failed", reason: "worker start failed", failureKind: "launch_failure" },
    { status: "failed", reason: "worker ended unexpectedly", failureKind: "ambiguous" },
    { status: "timed_out" },
    { status: "cancelled" },
  ];

  it("round-trips every result status with its bounded fields", () => {
    for (const result of cases) {
      const value = renderHandoffResultValue(result);
      expect(typeof value).toBe("string");
      const parsed = parseHandoffResultValue(value);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.version).toBe(ROOM_HANDOFF_PROTOCOL_VERSION);
        expect(parsed.result).toEqual(result);
      }
    }
  });

  it("renders a non-secret value object with the protocol version and status", () => {
    const value = renderHandoffResultValue({ status: "ok", reply: "hi" });
    const obj = JSON.parse(value) as Record<string, unknown>;
    expect(obj.v).toBe(ROOM_HANDOFF_PROTOCOL_VERSION);
    expect(obj.status).toBe("ok");
    expect(obj.reply).toBe("hi");
  });

  it("parse rejects invalid JSON, non-objects, version mismatch, and unknown status", () => {
    expect(parseHandoffResultValue("{nope").ok).toBe(false);
    expect(parseHandoffResultValue(JSON.stringify(["x"])).ok).toBe(false);
    expect(parseHandoffResultValue(JSON.stringify({ status: "ok" })).ok).toBe(false);
    expect(
      parseHandoffResultValue(JSON.stringify({ v: ROOM_HANDOFF_PROTOCOL_VERSION, status: "bogus" })).ok,
    ).toBe(false);
  });

  it("parse rejects an ok result without a reply, a rejected result without a reason, and a failed result without a failureKind", () => {
    expect(
      parseHandoffResultValue(JSON.stringify({ v: 1, status: "ok" })).ok,
    ).toBe(false);
    expect(
      parseHandoffResultValue(JSON.stringify({ v: 1, status: "rejected" })).ok,
    ).toBe(false);
    expect(
      parseHandoffResultValue(JSON.stringify({ v: 1, status: "failed", reason: "x" })).ok,
    ).toBe(false);
  });
});

describe("bounded handoff reply (R2a review)", () => {
  it("exports a fixed max reply length and a deterministic truncation marker", () => {
    expect(typeof ROOM_HANDOFF_MAX_REPLY_LENGTH).toBe("number");
    expect(ROOM_HANDOFF_MAX_REPLY_LENGTH).toBeGreaterThan(0);
    expect(typeof ROOM_HANDOFF_TRUNCATION_MARKER).toBe("string");
    expect(ROOM_HANDOFF_TRUNCATION_MARKER.length).toBeGreaterThan(0);
    expect(ROOM_HANDOFF_TRUNCATION_MARKER.length).toBeLessThan(ROOM_HANDOFF_MAX_REPLY_LENGTH);
  });

  it("truncateHandoffReply leaves a short reply unchanged", () => {
    const short = "All done.";
    expect(truncateHandoffReply(short)).toBe(short);
    const atCap = "x".repeat(ROOM_HANDOFF_MAX_REPLY_LENGTH);
    expect(truncateHandoffReply(atCap)).toBe(atCap);
  });

  it("truncateHandoffReply caps an oversized reply to the max length with the marker", () => {
    const oversized = "y".repeat(ROOM_HANDOFF_MAX_REPLY_LENGTH + 500);
    const truncated = truncateHandoffReply(oversized);
    expect(truncated.length).toBeLessThanOrEqual(ROOM_HANDOFF_MAX_REPLY_LENGTH);
    expect(truncated.endsWith(ROOM_HANDOFF_TRUNCATION_MARKER)).toBe(true);
    expect(truncated.startsWith("y".repeat(50))).toBe(true);
  });

  it("parseHandoffResultValue rejects an oversized ok.reply", () => {
    const oversized = "z".repeat(ROOM_HANDOFF_MAX_REPLY_LENGTH + 1);
    const value = JSON.stringify({ v: ROOM_HANDOFF_PROTOCOL_VERSION, status: "ok", reply: oversized });
    const parsed = parseHandoffResultValue(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/reply|length|maximum/i);
  });

  it("a broker-truncated reply at the cap round-trips through render and parse", () => {
    const oversized = "w".repeat(ROOM_HANDOFF_MAX_REPLY_LENGTH + 1000);
    const truncated = truncateHandoffReply(oversized);
    const value = renderHandoffResultValue({ status: "ok", reply: truncated });
    const parsed = parseHandoffResultValue(value);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.result.status).toBe("ok");
      if (parsed.result.status === "ok") {
        expect(parsed.result.reply).toBe(truncated);
        expect(parsed.result.reply.length).toBeLessThanOrEqual(ROOM_HANDOFF_MAX_REPLY_LENGTH);
      }
    }
  });
});

describe("room mention activation flag and request placeholder (R2b)", () => {
  it("exports the activation env var name and recognizes exactly the enabled value", () => {
    expect(ROOM_MENTION_ENABLED_ENV_VAR).toBe("PIREN_ROOM_MENTION_ENABLED");
    expect(isRoomMentionEnabled({ PIREN_ROOM_MENTION_ENABLED: "1" })).toBe(true);
    expect(isRoomMentionEnabled({ PIREN_ROOM_MENTION_ENABLED: "0" })).toBe(false);
    expect(isRoomMentionEnabled({ PIREN_ROOM_MENTION_ENABLED: "true" })).toBe(false);
    expect(isRoomMentionEnabled({})).toBe(false);
  });

  it("renders a versioned request placeholder carrying only to and text", () => {
    const placeholder = renderHandoffRequestPlaceholder("thor", "Summarize the report.");
    const parsed = JSON.parse(placeholder) as Record<string, unknown>;
    expect(parsed).toEqual({ v: ROOM_HANDOFF_PROTOCOL_VERSION, to: "thor", text: "Summarize the report." });
    // No source/room/root/correlation/budget/capability fields may be present.
    expect(Object.keys(parsed).sort()).toEqual(["text", "to", "v"]);
  });

  it("a rendered placeholder round-trips through the broker-side parser", () => {
    const placeholder = renderHandoffRequestPlaceholder("thor", "Do X");
    const event: RpcEvent = {
      type: "extension_ui_request",
      id: "req-1",
      method: "input",
      title: ROOM_HANDOFF_REQUEST_TITLE,
      placeholder,
    };
    expect(isHandoffInputRequest(event)).toBe(true);
    const parsed = parseHandoffInputRequest(event);
    expect(parsed).toEqual({ ok: true, version: ROOM_HANDOFF_PROTOCOL_VERSION, to: "thor", text: "Do X" });
  });

  it("validateRoomMentionArgs rejects invalid to/text before any UI operation", () => {
    expect(validateRoomMentionArgs("thor", "Do X")).toBeNull();
    expect(validateRoomMentionArgs("Bad Name", "Do X")).toMatch(/agent name/i);
    expect(validateRoomMentionArgs("", "Do X")).toMatch(/agent name/i);
    expect(validateRoomMentionArgs("thor", "   ")).toMatch(/blank|text/i);
    expect(validateRoomMentionArgs("thor", "x".repeat(ROOM_HANDOFF_MAX_TEXT_LENGTH + 1))).toMatch(/length|maximum/i);
  });

  it("resolveRoomMentionToolResult maps a valid ok to only the bounded reply", () => {
    const value = renderHandoffResultValue({ status: "ok", reply: "Worker says hi." });
    expect(resolveRoomMentionToolResult(value)).toEqual({ ok: true, reply: "Worker says hi." });
  });

  it("resolveRoomMentionToolResult turns cancelled/no-value/malformed/rejected/failed/timed_out into explicit errors", () => {
    // cancelled (undefined) and explicit no-value.
    expect(resolveRoomMentionToolResult(undefined).ok).toBe(false);
    expect(resolveRoomMentionToolResult(null).ok).toBe(false);
    // malformed value.
    expect(resolveRoomMentionToolResult("{not json").ok).toBe(false);
    // version mismatch.
    expect(resolveRoomMentionToolResult(JSON.stringify({ v: 999, status: "ok", reply: "x" })).ok).toBe(false);
    // rejected: the broker reason is never interpolated (R2b no-internal-id boundary).
    const rejected = resolveRoomMentionToolResult(renderHandoffResultValue({ status: "rejected", reason: "target not runnable" }));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error).toMatch(/rejected/i);
      expect(rejected.error).not.toContain("target not runnable");
    }
    // failed.
    const failed = resolveRoomMentionToolResult(renderHandoffResultValue({ status: "failed", reason: "x", failureKind: "ambiguous" }));
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toContain("ambiguous");
    // timed_out.
    expect(resolveRoomMentionToolResult(renderHandoffResultValue({ status: "timed_out" })).ok).toBe(false);
    // cancelled status.
    expect(resolveRoomMentionToolResult(renderHandoffResultValue({ status: "cancelled" })).ok).toBe(false);
  });
});

describe("room_mention tool error secrecy (R2b review)", () => {
  it("a rejected result never interpolates a broker reason that may contain a room id or correlation text", () => {
    const roomId = "20260803T110000000Z-secret-room-xyzzy";
    const leaky = renderHandoffResultValue({
      status: "rejected",
      reason: `a run is already active for room '${roomId}' and agent 'thor'`,
    });
    const outcome = resolveRoomMentionToolResult(leaky);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).not.toContain(roomId);
      expect(outcome.error).not.toContain("secret-room-xyzzy");
      // Fixed bounded non-secret error.
      expect(outcome.error).toMatch(/rejected/i);
    }

    const participantLeak = renderHandoffResultValue({
      status: "rejected",
      reason: `agent 'thor' is not a participant of room '${roomId}'`,
    });
    const outcome2 = resolveRoomMentionToolResult(participantLeak);
    expect(outcome2.ok).toBe(false);
    if (!outcome2.ok) {
      expect(outcome2.error).not.toContain(roomId);
    }
  });

  it("a failed result keeps its bounded failureKind and never interpolates a reason with internal ids", () => {
    const roomId = "20260803T110000000Z-secret-room-xyzzy";
    const value = renderHandoffResultValue({ status: "failed", reason: `worker failed in room '${roomId}'`, failureKind: "ambiguous" });
    const outcome = resolveRoomMentionToolResult(value);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("ambiguous");
      expect(outcome.error).not.toContain(roomId);
    }
  });
});
