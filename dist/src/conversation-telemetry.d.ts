import type { RpcSessionState, RpcSessionStats } from "./gateway-rpc.js";
/**
 * T3 — pure mapping from an exact live `conversation × agent` Pi session's
 * `get_session_stats` + `get_state` results to the bounded, browser-safe
 * live-only telemetry facts the broker publishes when a run settles
 * (workbench-task-handoff-and-agent-telemetry-contract §3).
 *
 * The output NEVER carries Pi session file paths, session ids, token/cost
 * totals, transcript content, raw provider errors, or raw RPC objects: only
 * the explicitly bounded fields below. The two documented context-unavailable
 * states stay distinct: an omitted `contextUsage` maps to `no_window` with no
 * `context` property, while a present object with null `tokens`/`percent`
 * maps to `post_compaction_pending` with the numeric window preserved.
 */
/** Truthful context availability for one exact live session. */
export type ConversationContextState = "ok" | "post_compaction_pending" | "no_window";
/**
 * Bounded context-window facts. `tokens`/`percent` are null exactly in the
 * documented post-compaction-pending state; `contextWindow` is always numeric
 * when this object exists.
 */
export interface ConversationTelemetryContext {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
}
/** Bounded model identity (never the raw RpcModel object). */
export interface ConversationTelemetryModel {
    provider?: string;
    id?: string;
}
/**
 * Bounded browser-safe telemetry facts for one exact conversation agent
 * session. Optional properties are present only when safely available.
 */
export interface ConversationTelemetryFacts {
    contextState: ConversationContextState;
    context?: ConversationTelemetryContext;
    model?: ConversationTelemetryModel;
    thinkingLevel?: string;
    autoCompactionEnabled?: boolean;
}
/**
 * Map typed T1 session stats plus session state to bounded telemetry facts.
 * The inputs are already narrowed by `PiRpcClient.getSessionStats()` /
 * `getState()`; this mapper adds the browser-safety boundary (allowlist of
 * fields) and the truthful three-state context projection.
 */
export declare function mapSessionTelemetryFacts(stats: RpcSessionStats, state: RpcSessionState): ConversationTelemetryFacts;
