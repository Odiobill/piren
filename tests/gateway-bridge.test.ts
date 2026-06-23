import { describe, expect, it } from "vitest";
import { piEventToSse, type SseEvent } from "../src/gateway-bridge.js";
import type { RpcEvent } from "../src/gateway-rpc.js";

describe("piEventToSse bridge translation", () => {
  it("translates a nested text_delta message_update into a token event", () => {
    const event: RpcEvent = {
      type: "message_update",
      role: "assistant",
      assistantMessageEvent: { type: "text_delta", delta: "Hel" },
    };

    expect(piEventToSse(event)).toEqual({ type: "token", data: { text: "Hel" } });
  });

  it("defers thinking_delta to a later bullet by returning null", () => {
    const event: RpcEvent = {
      type: "message_update",
      role: "assistant",
      assistantMessageEvent: { type: "thinking_delta", delta: "reasoning" },
    };

    expect(piEventToSse(event)).toBeNull();
  });

  it("translates a tool_execution_start into a tool start event", () => {
    const event: RpcEvent = {
      type: "tool_execution_start",
      name: "vault_read",
      args: { path: "steward-directives.md" },
    };

    expect(piEventToSse(event)).toEqual({
      type: "tool",
      data: { phase: "start", name: "vault_read", args: { path: "steward-directives.md" } },
    });
  });

  it("translates a tool_execution_end into a tool end event", () => {
    const event: RpcEvent = {
      type: "tool_execution_end",
      result: "ok",
      isError: false,
    };

    expect(piEventToSse(event)).toEqual({
      type: "tool",
      data: { phase: "end", result: "ok", isError: false },
    });
  });

  it("translates agent_end into a done event carrying messages", () => {
    const messages = [{ role: "user", content: "hi" }];
    const event: RpcEvent = { type: "agent_end", messages };

    expect(piEventToSse(event)).toEqual({ type: "done", data: { messages } });
  });

  it("returns null for internal and untranslated events", () => {
    const cases: RpcEvent[] = [
      { type: "agent_start" },
      { type: "queue_update", steering: [], followUp: [] },
      { type: "something_unknown" },
    ];

    for (const event of cases) {
      expect(piEventToSse(event)).toBeNull();
    }
  });

  it("ensures agent_end without messages still yields an array", () => {
    const event: RpcEvent = { type: "agent_end" };
    const result: SseEvent | null = piEventToSse(event);

    expect(result).toEqual({ type: "done", data: { messages: [] } });
  });
});
