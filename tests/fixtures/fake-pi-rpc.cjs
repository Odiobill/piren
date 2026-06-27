// Fake Pi RPC responder used by the gateway RPC client tests.
//
// This is a standalone Node process that mimics the JSONL stdin/stdout
// behavior of `pi --mode rpc` for the prompt flow, without requiring live
// model auth. It is the "separate process" the tracer bullet must prove the
// client can talk to.
//
// Protocol it speaks (matches verified @earendil-works/pi-coding-agent@0.79.9):
//   stdin:  LF-only JSONL commands, e.g. {type:"prompt", message, id}
//   stdout: LF-only JSONL responses and agent events
//
// On a prompt it emits:
//   {type:"response", command:"prompt", success:true, id}
//   {type:"agent_start"}
//   {type:"message_update", assistantMessageEvent:{type:"text_delta", delta:"Hel"}}
//   {type:"message_update", assistantMessageEvent:{type:"text_delta", delta:"lo"}}
//   {type:"agent_end", messages:[]}
//
// Token deltas are intentionally nested inside assistantMessageEvent, exactly
// like the real Pi RPC stream, so a client that looks for a flat token event
// will see nothing.

"use strict";

const process = require("node:process");

let buffer = "";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(cmd) {
  if (cmd.type === "prompt") {
    if (typeof cmd.message === "string" && cmd.message.includes("fail")) {
      emit({ type: "response", command: "prompt", success: false, id: cmd.id, error: "prompt rejected: fail trigger" });
      return;
    }
    emit({ type: "response", command: "prompt", success: true, id: cmd.id });
    emit({ type: "agent_start" });

    // If the message requests approval, emit an extension_ui_request before
    // completing the turn, so the approval round-trip can be tested.
    if (typeof cmd.message === "string" && cmd.message.includes("approve")) {
      emit({
        type: "extension_ui_request",
        id: "ui-req-" + Date.now(),
        method: "confirm",
        title: "Approve action?",
        message: "The agent wants to proceed.",
      });
    }

    emit({ type: "message_update", role: "assistant", assistantMessageEvent: { type: "text_delta", delta: "Hel" } });
    emit({ type: "message_update", role: "assistant", assistantMessageEvent: { type: "text_delta", delta: "lo" } });
    // Emit a queue_update so the steering bridge path is exercised.
    emit({ type: "queue_update", steering: [], followUp: [] });
    emit({ type: "agent_end", messages: [] });
    return;
  }
  if (cmd.type === "steer") {
    emit({ type: "response", command: "steer", success: true, id: cmd.id });
    return;
  }
  if (cmd.type === "follow_up") {
    emit({ type: "response", command: "follow_up", success: true, id: cmd.id });
    return;
  }
  if (cmd.type === "extension_ui_response") {
    // Pi resolves the pending request internally; no ack response is sent back.
    // The fake just swallows it to avoid hanging the client.
    return;
  }
  if (cmd.type === "get_state") {
    emit({ type: "response", command: "get_state", success: true, id: cmd.id, data: { sessionId: "fake-session", isStreaming: false, thinkingLevel: "off", messageCount: 0, pendingMessageCount: 0 } });
    return;
  }
  if (cmd.type === "get_available_models") {
    emit({
      type: "response",
      command: "get_available_models",
      success: true,
      id: cmd.id,
      data: {
        models: [
          { provider: "anthropic", id: "claude-sonnet-4-20250514", contextWindow: 200000, reasoning: true },
          { provider: "openai", id: "gpt-4.1", contextWindow: 128000, reasoning: false },
        ],
      },
    });
    return;
  }
  if (cmd.type === "set_model") {
    if (cmd.provider === "bogus" || cmd.modelId === "nope") {
      emit({ type: "response", command: "set_model", success: false, id: cmd.id, error: "model not found" });
      return;
    }
    emit({ type: "response", command: "set_model", success: true, id: cmd.id, data: { provider: cmd.provider, id: cmd.modelId } });
    emit({ type: "model_changed", model: { provider: cmd.provider, id: cmd.modelId } });
    return;
  }
  if (cmd.type === "set_thinking_level") {
    emit({ type: "response", command: "set_thinking_level", success: true, id: cmd.id });
    emit({ type: "thinking_level_changed", level: cmd.level });
    return;
  }
  if (cmd.type === "abort") {
    emit({ type: "response", command: "abort", success: true, id: cmd.id });
    // Model the real behavior: aborting a turn emits agent_end so the stream
    // drains and active SSE streams close cleanly.
    emit({ type: "agent_end", messages: [] });
    return;
  }
  if (cmd.type === "get_messages") {
    emit({
      type: "response",
      command: "get_messages",
      success: true,
      id: cmd.id,
      data: {
        messages: process.env.FAKE_PI_EMPTY_MESSAGES === "1" ? [] : [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there!" },
        ],
      },
    });
    return;
  }
  if (cmd.type === "switch_session") {
    // A sessionPath of "cancel" simulates the user cancelling the resume.
    const cancelled = cmd.sessionPath === "cancel";
    emit({ type: "response", command: "switch_session", success: true, id: cmd.id, data: { cancelled } });
    return;
  }
  emit({ type: "response", command: String(cmd.type), success: true, id: cmd.id });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // Ignore non-JSON lines, mirroring a tolerant reader.
    }
  }
});
process.stdin.on("end", () => process.exit(0));
