function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function nestedToolPayload(event) {
    const candidates = [event, event.toolCall, event.tool, event.toolExecution, event.call];
    for (const candidate of candidates) {
        if (!isRecord(candidate))
            continue;
        const name = candidate.name ?? candidate.toolName;
        const args = candidate.args ?? candidate.arguments ?? candidate.input;
        if (typeof name === "string" && name.trim() !== "")
            return { name, args };
    }
    return {};
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
export function piEventToSse(event) {
    switch (event.type) {
        case "message_update": {
            const inner = event.assistantMessageEvent;
            if (isRecord(inner) && inner.type === "text_delta" && typeof inner.delta === "string") {
                return { type: "token", data: { text: inner.delta } };
            }
            return null;
        }
        case "tool_execution_start": {
            const tool = nestedToolPayload(event);
            return {
                type: "tool",
                data: { phase: "start", name: tool.name, args: tool.args },
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
//# sourceMappingURL=gateway-bridge.js.map