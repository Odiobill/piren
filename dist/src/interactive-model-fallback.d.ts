import type { RpcEvent } from "./gateway-rpc.js";
import { type RunOutcome } from "./model-fallback-outcome.js";
/**
 * Narrow, Pi-extension-facing adapter for the existing RPC outcome classifier.
 * It owns no model, session, or retry state: it only records one interactive
 * turn's documented lifecycle evidence and fails closed before selection.
 */
export interface InteractiveFallbackIncident {
    readonly events: RpcEvent[];
    malformed: boolean;
}
export type InteractiveFallbackEventName = "message_start" | "message_update" | "message_end" | "turn_end" | "agent_end" | "agent_settled" | "tool_execution_start" | "tool_execution_update" | "tool_execution_end" | "extension_ui_request" | "auto_retry_end";
export declare function createInteractiveFallbackIncident(): InteractiveFallbackIncident;
/**
 * Copy only the extension event's own structured fields and bind its type from
 * the registered lifecycle name; unstructured input taints the incident rather
 * than creating terminal evidence.
 */
export declare function recordInteractiveFallbackEvent(incident: InteractiveFallbackIncident, type: InteractiveFallbackEventName, event: unknown): void;
/**
 * `agent_settled` alone is insufficient in the TUI: another extension may have
 * started a run first. Preserve the existing classifier's zero-side-effect gate
 * and make a non-idle or malformed adapter state unconditionally ambiguous.
 */
export declare function settleInteractiveFallbackIncident(incident: InteractiveFallbackIncident, input: {
    isIdle: boolean;
}): {
    outcome: RunOutcome;
};
