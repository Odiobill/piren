import type { RpcEvent } from "./gateway-rpc.js";

/**
 * A single Server-Sent Event to forward to the browser. `data` is always a JSON
 * object serialized onto one `data:` line.
 */
export interface SseEvent {
  type: string;
  data: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Translate a Pi RPC event into an SSE event for the browser.
 *
 * This is the mechanical bridge layer described in gateway-web-ui.md. It
 * translates the v1 content events only: token deltas (nested inside
 * message_update), tool execution, and turn completion. Thinking deltas,
 * queue updates, and approval requests are intentionally deferred to later
 * tracer bullets and return null here.
 *
 * Internal lifecycle events (agent_start) also return null: they do not map to
 * a browser-facing SSE event in v1.
 */
export function piEventToSse(event: RpcEvent): SseEvent | null {
  switch (event.type) {
    case "message_update": {
      const inner = event.assistantMessageEvent;
      if (isRecord(inner) && inner.type === "text_delta" && typeof inner.delta === "string") {
        return { type: "token", data: { text: inner.delta } };
      }
      return null;
    }
    case "tool_execution_start": {
      return {
        type: "tool",
        data: { phase: "start", name: event.name, args: event.args },
      };
    }
    case "tool_execution_end": {
      return {
        type: "tool",
        data: { phase: "end", result: event.result, isError: event.isError },
      };
    }
    case "agent_end": {
      const messages = Array.isArray(event.messages) ? event.messages : [];
      return { type: "done", data: { messages } };
    }
    case "model_changed": {
      return { type: "model_changed", data: { model: event.model } };
    }
    case "thinking_level_changed": {
      return { type: "thinking_changed", data: { level: event.level } };
    }
    case "queue_update": {
      const steering = Array.isArray(event.steering) ? event.steering : [];
      const followUp = Array.isArray(event.followUp) ? event.followUp : [];
      return { type: "queue", data: { steering, followUp } };
    }
    case "extension_ui_request": {
      // Forward confirm/select/input to the browser as approval events.
      // Other methods (notify, setStatus, editor, etc.) are deferred.
      if (event.method === "confirm" || event.method === "select" || event.method === "input") {
        const { type: _type, ...rest } = event;
        return { type: "approval", data: { ...rest } };
      }
      return null;
    }
    default:
      return null;
  }
}
