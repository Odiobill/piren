import { describe, expect, it } from "vitest";
import { CONVERSATION_HANDOFF_PROTOCOL_VERSION } from "../src/conversation-handoff.js";
import type { RpcEvent } from "../src/gateway-rpc.js";
import {
  CONVERSATION_HANDOFF_ENABLED_ENV_VAR,
  CONVERSATION_HANDOFF_REQUEST_TITLE,
  CONVERSATION_HANDOFF_RESULT_STATUSES,
  decorateConversationClientTarget,
  isConversationHandoffInputRequest,
  parseConversationHandoffInputRequest,
  parseConversationHandoffResultValue,
  renderConversationHandoffRequestPlaceholder,
  renderConversationHandoffResultValue,
  resolveConversationHandoffRole,
  resolveConversationHandoffToolResult,
  validateConversationHandoffArgs,
} from "../src/conversation-handoff-protocol.js";

/**
 * C5-3 — pure reserved Pi `extension_ui_request` / `input` control protocol
 * bridging the gated `conversation_handoff(to, text)` extension tool to the
 * ConversationBroker (room R2 transport precedent, conversation semantics).
 * No filesystem, network, or Pi auth.
 */

function envelopeEvent(overrides?: Record<string, unknown>): RpcEvent {
  return {
    type: "extension_ui_request",
    id: "conv-1",
    method: "input",
    title: CONVERSATION_HANDOFF_REQUEST_TITLE,
    placeholder: JSON.stringify({ v: 1, to: "dipu", text: "Please review" }),
    ...overrides,
  };
}

describe("resolveConversationHandoffRole (exact two-mode allowlist)", () => {
  it("accepts exactly root and workflow", () => {
    expect(resolveConversationHandoffRole({ [CONVERSATION_HANDOFF_ENABLED_ENV_VAR]: "root" })).toBe("root");
    expect(resolveConversationHandoffRole({ [CONVERSATION_HANDOFF_ENABLED_ENV_VAR]: "workflow" })).toBe("workflow");
  });

  it("registers no tool for absent, empty, or any other value", () => {
    for (const value of [undefined, "", "0", "1", "true", "yes", "ROOT", "root-extra", " Root"]) {
      const env: Record<string, string | undefined> = value === undefined ? {} : { [CONVERSATION_HANDOFF_ENABLED_ENV_VAR]: value };
      expect(resolveConversationHandoffRole(env)).toBeNull();
    }
  });
});

describe("isConversationHandoffInputRequest (structural discriminator)", () => {
  it("matches only an extension_ui_request with method input and the exact reserved title", () => {
    expect(isConversationHandoffInputRequest(envelopeEvent())).toBe(true);
    expect(isConversationHandoffInputRequest({ ...envelopeEvent(), method: "confirm" })).toBe(false);
    expect(isConversationHandoffInputRequest({ ...envelopeEvent(), title: "piren:room-handoff" })).toBe(false);
    expect(isConversationHandoffInputRequest({ ...envelopeEvent(), type: "agent_settled" })).toBe(false);
  });
});

describe("parseConversationHandoffInputRequest (bounded envelope)", () => {
  it("parses a valid versioned envelope with only to/text", () => {
    expect(parseConversationHandoffInputRequest(envelopeEvent())).toEqual({ ok: true, to: "dipu", text: "Please review" });
  });

  it("rejects missing, malformed, version-mismatched, blank, invalid, and oversized content", () => {
    const cases: Record<string, unknown>[] = [
      { placeholder: undefined },
      { placeholder: "" },
      { placeholder: "not json" },
      { placeholder: JSON.stringify({ v: 99, to: "dipu", text: "x" }) },
      { placeholder: JSON.stringify({ v: 1, to: "Bad Name", text: "x" }) },
      { placeholder: JSON.stringify({ v: 1, to: "dipu", text: "   " }) },
      { placeholder: JSON.stringify({ v: 1, to: "dipu", text: "x".repeat(4001) }) },
    ];
    for (const overrides of cases) {
      const parsed = parseConversationHandoffInputRequest(envelopeEvent(overrides));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toBeTruthy();
    }
  });
});

describe("renderConversationHandoffRequestPlaceholder", () => {
  it("carries only v/to/text (never ids, source, root, budget, or role)", () => {
    const placeholder = JSON.parse(renderConversationHandoffRequestPlaceholder("kimi", "Review the diff")) as Record<string, unknown>;
    expect(placeholder).toEqual({ v: CONVERSATION_HANDOFF_PROTOCOL_VERSION, to: "kimi", text: "Review the diff" });
    expect(Object.keys(placeholder).sort()).toEqual(["text", "to", "v"]);
  });
});

describe("conversation handoff result value (bounded non-secret wire shape)", () => {
  it("renders pending, ok, and rejected values", () => {
    expect(JSON.parse(renderConversationHandoffResultValue({ status: "pending" }))).toEqual({ v: 1, status: "pending" });
    expect(JSON.parse(renderConversationHandoffResultValue({ status: "ok" }))).toEqual({ v: 1, status: "ok" });
    expect(JSON.parse(renderConversationHandoffResultValue({ status: "rejected", reason: "nope" }))).toEqual({
      v: 1,
      status: "rejected",
      reason: "nope",
    });
  });

  it("round-trips through parseConversationHandoffResultValue and rejects malformed shapes", () => {
    for (const result of [
      { status: "pending" as const },
      { status: "ok" as const },
      { status: "rejected" as const, reason: "nope" },
    ]) {
      const parsed = parseConversationHandoffResultValue(renderConversationHandoffResultValue(result));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.result).toEqual(result);
    }
    for (const value of ["not json", JSON.stringify({ v: 2, status: "pending" }), JSON.stringify({ v: 1, status: "maybe" }), JSON.stringify({ v: 1, status: "rejected" })]) {
      expect(parseConversationHandoffResultValue(value).ok).toBe(false);
    }
    expect(CONVERSATION_HANDOFF_RESULT_STATUSES).toEqual(["pending", "ok", "rejected"]);
  });

  it("maps the raw input response to a bounded non-secret tool outcome with no retry", () => {
    expect(resolveConversationHandoffToolResult(renderConversationHandoffResultValue({ status: "pending" }))).toEqual({
      ok: true,
      reply: "Conversation handoff gate requested; awaiting steward approval.",
    });
    expect(resolveConversationHandoffToolResult(renderConversationHandoffResultValue({ status: "ok" }))).toEqual({
      ok: true,
      reply: "Conversation handoff accepted; the child stage will launch after this run completes.",
    });
    const rejected = resolveConversationHandoffToolResult(renderConversationHandoffResultValue({ status: "rejected", reason: "budget exhausted: edges" }));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      // The broker reason is NEVER interpolated (no internal ids/reasons leak).
      expect(rejected.error).toMatch(/rejected by the conversation broker/);
      expect(rejected.error).not.toContain("budget");
      expect(rejected.error).not.toContain("collaboration/conversations");
    }
  });

  it("turns cancelled, no-value, malformed, and version-mismatched responses into explicit errors", () => {
    for (const value of [undefined, "{not json", JSON.stringify({ v: 99, status: "ok" })]) {
      const outcome = resolveConversationHandoffToolResult(value);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toBeTruthy();
    }
  });
});

describe("validateConversationHandoffArgs (pre-UI, no side effects)", () => {
  it("rejects invalid, blank, and oversized args with fixed messages", () => {
    expect(validateConversationHandoffArgs("Bad Name", "x")).toMatch(/must be a valid lowercase kebab-case agent name/);
    expect(validateConversationHandoffArgs("dipu", "   ")).toMatch(/must be non-blank/);
    expect(validateConversationHandoffArgs("dipu", "x".repeat(4001))).toMatch(/exceeds the maximum length/);
    expect(validateConversationHandoffArgs("dipu", "ok")).toBeNull();
  });
});

describe("decorateConversationClientTarget (broker-owned process capability only)", () => {
  it("returns a new target with a new env carrying the exact role, never mutating input or global env", () => {
    const baseEnv: NodeJS.ProcessEnv = { PATH: "/bin", OTHER: "x" };
    const input = { command: "pi", args: ["--mode", "rpc"], cwd: "/tmp", env: baseEnv };
    const beforeGlobal = { ...process.env };
    const root = decorateConversationClientTarget(input, "root");
    const workflow = decorateConversationClientTarget(input, "workflow");
    expect(root).not.toBe(input);
    expect(root.env).not.toBe(baseEnv);
    expect(root.env[CONVERSATION_HANDOFF_ENABLED_ENV_VAR]).toBe("root");
    expect(workflow.env[CONVERSATION_HANDOFF_ENABLED_ENV_VAR]).toBe("workflow");
    expect(input.env[CONVERSATION_HANDOFF_ENABLED_ENV_VAR]).toBeUndefined();
    expect(baseEnv[CONVERSATION_HANDOFF_ENABLED_ENV_VAR]).toBeUndefined();
    expect(process.env[CONVERSATION_HANDOFF_ENABLED_ENV_VAR]).toBeUndefined();
    expect(JSON.stringify(process.env)).toBe(JSON.stringify(beforeGlobal));
  });
});
