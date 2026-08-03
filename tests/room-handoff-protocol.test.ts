import { describe, expect, it } from "vitest";
import type { RpcEvent } from "../src/gateway-rpc.js";
import {
  ROOM_HANDOFF_MAX_TEXT_LENGTH,
  ROOM_HANDOFF_PROTOCOL_VERSION,
  ROOM_HANDOFF_REQUEST_TITLE,
  ROOM_HANDOFF_RESULT_STATUSES,
  isHandoffInputRequest,
  parseHandoffInputRequest,
  parseHandoffResultValue,
  renderHandoffResultValue,
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
