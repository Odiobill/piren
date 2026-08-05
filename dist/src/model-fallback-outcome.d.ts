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
export type RunOutcomeCategory = "completed" | "aborted" | "ambiguous" | "provider_error_transient_exhausted" | "provider_error_other";
export interface RunOutcome {
    category: RunOutcomeCategory;
    /** Deterministic non-secret detail; never raw error text or model ids. */
    detail: string;
}
/** The two fully-settled zero-side-effect provider-error categories. */
export type ProviderErrorOutcome = Extract<RunOutcome, {
    category: "provider_error_transient_exhausted" | "provider_error_other";
}>;
/**
 * True ONLY for fully settled zero-side-effect provider-error categories
 * (the design's `provider_error_zero_side_effect` eligibility predicate).
 * `completed`, `aborted`, `ambiguous`, and the ADR-0038 `launch_failure`
 * concept can never pass: they are distinct categories outside this set.
 */
export declare function isFallbackEligibleOutcome(outcome: RunOutcome): outcome is ProviderErrorOutcome;
/**
 * Classify one logical run's event sequence. Total and deterministic: every
 * sequence maps to exactly one category.
 */
export declare function classifyRunOutcome(events: readonly RpcEvent[]): RunOutcome;
