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
 *   assistant record is malformed terminal evidence that taints the ENTIRE
 *   fallback path — when the final `agent_end` has no assistant records, the
 *   result is `ambiguous` (never `completed`, never eligible) even if an
 *   earlier `message_start`/`message_end` carried an assistant record. When
 *   the final `agent_end` HAS assistant records, they are authoritative and a
 *   malformed `turn_end` is irrelevant as designed.
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

export type RunOutcome =
  | { category: "completed"; detail: string }
  | { category: "aborted"; detail: string }
  | { category: "ambiguous"; detail: string }
  | { category: "provider_error_transient_exhausted"; detail: string }
  | { category: "provider_error_other"; detail: string };

/** The two fully-settled zero-side-effect provider-error categories. */
export type ProviderErrorOutcome =
  | { category: "provider_error_transient_exhausted"; detail: string }
  | { category: "provider_error_other"; detail: string };

const NORMAL_STOP_REASONS = new Set(["stop", "length", "toolUse"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAssistantRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.role === "assistant";
}

/**
 * True ONLY for fully settled zero-side-effect provider-error categories
 * (the design's `provider_error_zero_side_effect` eligibility predicate).
 * `completed`, `aborted`, `ambiguous`, and the ADR-0038 `launch_failure`
 * concept can never pass: they are distinct categories outside this set.
 * Narrows a `RunOutcome` to the genuine `ProviderErrorOutcome` discriminated
 * subtype (never `never`).
 */
export function isFallbackEligibleOutcome(outcome: RunOutcome): outcome is ProviderErrorOutcome {
  return outcome.category === "provider_error_transient_exhausted" || outcome.category === "provider_error_other";
}

/**
 * Classify one logical run's event sequence. Total and deterministic: every
 * sequence maps to exactly one category.
 */
export function classifyRunOutcome(events: readonly RpcEvent[]): RunOutcome {
  let sawSettled = false;
  let sawTextDelta = false;
  let sawTool = false;
  let sawUiRequest = false;
  let sawRetryExhausted = false;
  /** messages array of the LAST agent_end event (the authoritative final run). */
  let lastAgentEndMessages: unknown;
  /** Last assistant record from message events; used only when the final run has none. */
  let fallbackTerminalMessage: Record<string, unknown> | undefined;
  /** A turn_end carried a non-assistant/malformed terminal record. */
  let sawMalformedTerminal = false;

  for (const event of events) {
    switch (event.type) {
      case "agent_settled":
        sawSettled = true;
        break;
      case "message_update": {
        const inner = event.assistantMessageEvent;
        if (isRecord(inner) && inner.type === "text_delta") sawTextDelta = true;
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
        if (event.success === false) sawRetryExhausted = true;
        break;
      case "message_start":
      case "message_end": {
        const message = event.message;
        if (isAssistantRecord(message)) fallbackTerminalMessage = message;
        break;
      }
      case "turn_end": {
        // turn_end.message is protocol-defined as the terminal assistant
        // message record. RpcEvent is deliberately loose (raw JSONL is cast
        // into it), so the assistant-role check is a runtime requirement here
        // exactly as for message_start/message_end: a non-assistant or
        // malformed turn_end message is malformed terminal evidence and must
        // never satisfy the structured assistant-message requirement.
        const message = event.message;
        if (isAssistantRecord(message)) {
          fallbackTerminalMessage = message;
        } else if ("message" in event) {
          sawMalformedTerminal = true;
        }
        break;
      }
      case "agent_end":
        // Keep ONLY the last agent_end: earlier low-level runs (willRetry:true)
        // are historical and never authoritative for the conflict policy.
        lastAgentEndMessages = event.messages;
        break;
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

  // Authoritative final-run assistant records.
  const authoritativeRecords: Record<string, unknown>[] = [];
  if (Array.isArray(lastAgentEndMessages)) {
    for (const message of lastAgentEndMessages) {
      if (isAssistantRecord(message)) authoritativeRecords.push(message);
    }
  }

  if (authoritativeRecords.length === 0) {
    // No assistant records in the final agent_end: the message-event fallback
    // path applies. A malformed/non-assistant turn_end taints the ENTIRE
    // fallback path — fail closed BEFORE any earlier assistant
    // message_start/message_end record can classify (terminal corruption is
    // never overridden by prior fallback evidence). When the final agent_end
    // has assistant records, it remains authoritative and the malformed
    // turn_end is irrelevant as designed.
    if (sawMalformedTerminal) {
      return { category: "ambiguous", detail: "a malformed non-assistant turn_end terminal record taints the fallback path." };
    }
    if (fallbackTerminalMessage !== undefined) {
      authoritativeRecords.push(fallbackTerminalMessage);
    }
  }

  if (authoritativeRecords.length === 0) {
    // Settled run with no terminal assistant message and no malformed
    // terminal: normal completion (the TB0 ordinary fixture shape, or a
    // side-effect-bearing run).
    return { category: "completed", detail: "the run settled with no terminal assistant error." };
  }

  const errorRecords = authoritativeRecords.filter((record) => record.stopReason === "error");
  if (errorRecords.length > 0) {
    if (!errorRecords.every((record) => typeof record.errorMessage === "string")) {
      return { category: "ambiguous", detail: "the provider error run has no structured errorMessage field." };
    }
    // Conflict fail-closed: any other assistant record in the same authoritative
    // final run contradicts the provider error (normal or aborted terminal).
    if (authoritativeRecords.length > errorRecords.length) {
      return {
        category: "ambiguous",
        detail: "the authoritative final run mixes a provider error with conflicting terminal records.",
      };
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

  const terminal = authoritativeRecords[authoritativeRecords.length - 1];
  if (terminal === undefined) {
    return { category: "ambiguous", detail: "the authoritative final run has no terminal assistant record." };
  }
  const stopReason = terminal.stopReason;
  if (typeof stopReason !== "string") {
    return { category: "ambiguous", detail: "the final assistant message has no structured stop reason." };
  }
  if (stopReason === "aborted") {
    return { category: "aborted", detail: "the run settled with an aborted terminal stop reason." };
  }
  if (NORMAL_STOP_REASONS.has(stopReason)) {
    return { category: "completed", detail: `the run settled with a normal terminal stop reason (${stopReason}).` };
  }
  return { category: "ambiguous", detail: "the final assistant message has an unknown stop reason." };
}
