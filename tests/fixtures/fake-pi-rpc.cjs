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
    emit({ type: "message_update", role: "assistant", assistantMessageEvent: { type: "text_delta", delta: "Hel" } });
    emit({ type: "message_update", role: "assistant", assistantMessageEvent: { type: "text_delta", delta: "lo" } });
    emit({ type: "agent_end", messages: [] });
    return;
  }
  if (cmd.type === "get_state") {
    emit({ type: "response", command: "get_state", success: true, id: cmd.id, data: { sessionId: "fake-session", isStreaming: false } });
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
