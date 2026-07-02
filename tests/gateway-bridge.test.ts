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

  it("extracts tool names from nested Pi tool execution payloads", () => {
    const event: RpcEvent = {
      type: "tool_execution_start",
      toolCall: { name: "wiki_update_concept", args: { title: "GymSync" } },
    };

    expect(piEventToSse(event)).toEqual({
      type: "tool",
      data: { phase: "start", name: "wiki_update_concept", args: { title: "GymSync" } },
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
      { type: "extension_ui_request", id: "x", method: "notify", message: "hi" },
      { type: "something_unknown" },
    ];

    for (const event of cases) {
      expect(piEventToSse(event)).toBeNull();
    }
  });

  it("translates a model_changed event into a model_changed SSE event", () => {
    const event: RpcEvent = {
      type: "model_changed",
      model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
    };

    expect(piEventToSse(event)).toEqual({
      type: "model_changed",
      data: { model: { provider: "anthropic", id: "claude-sonnet-4-20250514" } },
    });
  });

  it("translates a thinking_level_changed event into a thinking_changed SSE event", () => {
    const event: RpcEvent = { type: "thinking_level_changed", level: "medium" };

    expect(piEventToSse(event)).toEqual({
      type: "thinking_changed",
      data: { level: "medium" },
    });
  });

  it("translates a queue_update event into a queue SSE event", () => {
    const event: RpcEvent = {
      type: "queue_update",
      steering: ["hold on"],
      followUp: ["and then this"],
    };

    expect(piEventToSse(event)).toEqual({
      type: "queue",
      data: { steering: ["hold on"], followUp: ["and then this"] },
    });
  });

  it("translates an extension_ui_request confirm into an approval SSE event", () => {
    const event: RpcEvent = {
      type: "extension_ui_request",
      id: "req-1",
      method: "confirm",
      title: "Proceed?",
      message: "Run vault_write?",
    };

    expect(piEventToSse(event)).toEqual({
      type: "approval",
      data: { id: "req-1", method: "confirm", title: "Proceed?", message: "Run vault_write?" },
    });
  });

  it("translates an extension_ui_request select into an approval SSE event", () => {
    const event: RpcEvent = {
      type: "extension_ui_request",
      id: "req-2",
      method: "select",
      title: "Pick one",
      options: ["a", "b"],
    };

    const result = piEventToSse(event);
    expect(result?.type).toBe("approval");
    expect(result?.data).toMatchObject({ id: "req-2", method: "select", options: ["a", "b"] });
  });

  it("translates an extension_ui_request input into an approval SSE event", () => {
    const event: RpcEvent = {
      type: "extension_ui_request",
      id: "req-3",
      method: "input",
      title: "Enter a value",
      placeholder: "...",
    };

    const result = piEventToSse(event);
    expect(result?.type).toBe("approval");
    expect(result?.data).toMatchObject({ id: "req-3", method: "input", placeholder: "..." });
  });

  it("ensures agent_end without messages still yields an array", () => {
    const event: RpcEvent = { type: "agent_end" };
    const result: SseEvent | null = piEventToSse(event);

    expect(result).toEqual({ type: "done", data: { messages: [] } });
  });
});
