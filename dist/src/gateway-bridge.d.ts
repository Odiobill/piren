import type { RpcEvent } from "./gateway-rpc.js";
/**
 * A single Server-Sent Event to forward to the browser. `data` is always a JSON
 * object serialized onto one `data:` line.
 */
export interface SseEvent {
    type: string;
    data: Record<string, unknown>;
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
export declare function piEventToSse(event: RpcEvent): SseEvent | null;
