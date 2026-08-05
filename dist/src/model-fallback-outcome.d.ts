/**
 * TB2 — pure Pi run-outcome classifier and zero-side-effect gate
 * (filesystem/Pi-auth-free).
 *
 * See Projects/Piren/model-fallbacks-design.md §3.1. Given a readonly RPC event
 * sequence for ONE logical run (the events a PiRpcClient consumer collects
 * between the prompt ack and terminal settlement), returns exactly one typed
 * outcome category plus a non-secret detail.
 *
 * Contract:
 * - `agent_settled` is MANDATORY for any normal terminal classification. No
 *   settled event => `ambiguous`, regardless of `agent_end` (including
 *   `willRetry:false`), retry, compaction, or summarization traffic. TB0/G1
 *   made this the sole terminal boundary for all consumers.
 * - Only structured event/message fields are parsed. `errorMessage` TEXT is
 *   never inspected and HTTP statuses are never inferred. A provider-error
 *   candidate requires a final structured assistant message with
 *   `stopReason: "error"` AND a string `errorMessage` field, observed in a
 *   settled stream.
 * - The zero-side-effect gate is conservative: ANY text delta, `tool_execution_*`
 *   event, or `extension_ui_request` makes a provider error `ambiguous` (never
 *   completed, never fallback-safe).
 * - `provider_error_transient_exhausted` requires the safe provider-error gate
 *   AND a structured `auto_retry_end` with `success:false`. An `auto_retry_start`
 *   alone or `auto_retry_end success:true` never proves exhaustion; a safe
 *   provider error without the marker is `provider_error_other` (honestly
 *   non-transient). These two final categories are non-overlapping; the design's
 *   `provider_error_zero_side_effect` notion is realized as the shared
 *   eligibility predicate `isFallbackEligibleOutcome` over both.
 * - `completed` requires settlement with a normal stop reason (`stop`, `length`,
 *   `toolUse`) or no terminal assistant error record; `aborted` requires a
 *   structured `stopReason: "aborted"`. Unknown/malformed/conflicting final
 *   messages, missing `errorMessage`, and maintenance failure fail closed as
 *   `ambiguous`.
 *
 * Authoritative final-record scope (conflict policy):
 * - The authoritative terminal assistant records come from the messages array
 *   of the LAST `agent_end` event — the final low-level run. Earlier `agent_end`
 *   events (`willRetry:true` retries) are historical earlier low-level runs and
 *   are NEVER treated as conflicts: an earlier retry error followed by a later
 *   final normal stop remains `completed`.
 * - If no `agent_end` exists (or its messages are empty), the single fallback
 *   terminal record is the last ASSISTANT record from `message_start` /
 *   `message_end` / `turn_end` (they all carry the terminal message). The
 *   assistant-role check is a runtime requirement on every carrier because
 *   `RpcEvent` is deliberately loose: a `turn_end` whose `message` is not an
 *   assistant record is malformed terminal evidence and fails closed as
 *   `ambiguous` (never `completed`, never eligible).
 * - WITHIN the authoritative final run, if any assistant record has
 *   `stopReason:"error"` (with a structured `errorMessage`) alongside ANY other
 *   assistant record, the run is `ambiguous` (conflicting terminal records fail
 *   closed — never `completed`, never fallback-eligible). Multiple consistent
 *   error records are NOT a conflict. A normal `toolUse`->`stop` sequence in a
 *   final run with no error record is NOT a conflict and stays `completed`.
 * - Compaction and `summarization_retry_*` are maintenance-only: never
 *   provider-error proof and never an independent trigger. Settled normal
 *   completion after overflow compaction remains `completed`.
 * - ADR-0038 `launch_failure` (target_build / start_rejection) is control-flow
 *   classification that lives OUTSIDE this event-only core and is unchanged.
 *   Process exit / timeout / prompt rejection are external to this core: they
 *   surface to the caller, not as events, and are not classified here.
 *
 * Details are deterministic, non-secret, and never carry raw error text or model
 * IDs.
 */
import type { RpcEvent } from "./gateway-rpc.js";
export type RunOutcome = {
    category: "completed";
    detail: string;
} | {
    category: "aborted";
    detail: string;
} | {
    category: "ambiguous";
    detail: string;
} | {
    category: "provider_error_transient_exhausted";
    detail: string;
} | {
    category: "provider_error_other";
    detail: string;
};
/** The two fully-settled zero-side-effect provider-error categories. */
export type ProviderErrorOutcome = {
    category: "provider_error_transient_exhausted";
    detail: string;
} | {
    category: "provider_error_other";
    detail: string;
};
/**
 * True ONLY for fully settled zero-side-effect provider-error categories
 * (the design's `provider_error_zero_side_effect` eligibility predicate).
 * `completed`, `aborted`, `ambiguous`, and the ADR-0038 `launch_failure`
 * concept can never pass: they are distinct categories outside this set.
 * Narrows a `RunOutcome` to the genuine `ProviderErrorOutcome` discriminated
 * subtype (never `never`).
 */
export declare function isFallbackEligibleOutcome(outcome: RunOutcome): outcome is ProviderErrorOutcome;
/**
 * Classify one logical run's event sequence. Total and deterministic: every
 * sequence maps to exactly one category.
 */
export declare function classifyRunOutcome(events: readonly RpcEvent[]): RunOutcome;
