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
const NORMAL_STOP_REASONS = new Set(["stop", "length", "toolUse"]);
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isAssistantRecord(value) {
    return isRecord(value) && value.role === "assistant";
}
/**
 * True ONLY for fully settled zero-side-effect provider-error categories
 * (the design's `provider_error_zero_side_effect` eligibility predicate).
 * `completed`, `aborted`, `ambiguous`, and the ADR-0038 `launch_failure`
 * concept can never pass: they are distinct categories outside this set.
 */
export function isFallbackEligibleOutcome(outcome) {
    return outcome.category === "provider_error_transient_exhausted" || outcome.category === "provider_error_other";
}
/**
 * Classify one logical run's event sequence. Total and deterministic: every
 * sequence maps to exactly one category.
 */
export function classifyRunOutcome(events) {
    let sawSettled = false;
    let sawTextDelta = false;
    let sawTool = false;
    let sawUiRequest = false;
    let sawRetryExhausted = false;
    let lastAssistantMessage;
    for (const event of events) {
        switch (event.type) {
            case "agent_settled":
                sawSettled = true;
                break;
            case "message_update": {
                const inner = event.assistantMessageEvent;
                if (isRecord(inner) && inner.type === "text_delta")
                    sawTextDelta = true;
                break;
            }
            case "tool_execution_start":
            case "tool_execution_update":
            case "tool_execution_end":
                sawTool = true;
                break;
            case "extension_ui_request":
                sawUiRequest = true;
                break;
            case "auto_retry_end":
                if (event.success === false)
                    sawRetryExhausted = true;
                break;
            case "message_start":
            case "message_end": {
                const message = event.message;
                if (isAssistantRecord(message))
                    lastAssistantMessage = message;
                break;
            }
            case "turn_end": {
                // turn_end.message is the terminal assistant message record.
                if (isRecord(event.message))
                    lastAssistantMessage = event.message;
                break;
            }
            case "agent_end": {
                // Keep the last assistant record in Pi's per-run messages array.
                const messages = event.messages;
                if (Array.isArray(messages)) {
                    for (const message of messages) {
                        if (isAssistantRecord(message))
                            lastAssistantMessage = message;
                    }
                }
                break;
            }
            default:
                // agent_start, compaction_*, summarization_retry_*, queue_update,
                // model_changed, extension responses, etc. are non-terminal and
                // non-side-effect for this classification.
                break;
        }
    }
    if (!sawSettled) {
        return { category: "ambiguous", detail: "the run did not settle (no agent_settled event)." };
    }
    if (lastAssistantMessage === undefined) {
        // Settled run with no structured assistant terminal message: normal
        // completion (the TB0 ordinary fixture shape, or a side-effect-bearing run).
        return { category: "completed", detail: "the run settled with no terminal assistant error." };
    }
    const stopReason = lastAssistantMessage.stopReason;
    if (typeof stopReason !== "string") {
        return { category: "ambiguous", detail: "the final assistant message has no structured stop reason." };
    }
    if (stopReason === "error") {
        if (typeof lastAssistantMessage.errorMessage !== "string") {
            return { category: "ambiguous", detail: "the provider error run has no structured errorMessage field." };
        }
        if (sawTextDelta || sawTool || sawUiRequest) {
            return {
                category: "ambiguous",
                detail: "the provider error run produced assistant text, tool execution, or an extension UI request.",
            };
        }
        if (sawRetryExhausted) {
            return {
                category: "provider_error_transient_exhausted",
                detail: "provider error after Pi exhausted its automatic retries (auto_retry_end success:false) with zero side effects.",
            };
        }
        return {
            category: "provider_error_other",
            detail: "provider error with zero side effects and no observed transient-retry exhaustion.",
        };
    }
    if (stopReason === "aborted") {
        return { category: "aborted", detail: "the run settled with an aborted terminal stop reason." };
    }
    if (NORMAL_STOP_REASONS.has(stopReason)) {
        return { category: "completed", detail: `the run settled with a normal terminal stop reason (${stopReason}).` };
    }
    return { category: "ambiguous", detail: "the final assistant message has an unknown stop reason." };
}
//# sourceMappingURL=model-fallback-outcome.js.map