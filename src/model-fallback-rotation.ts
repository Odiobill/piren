/**
 * TB3 — pure model-fallback rotation planner and handoff prompt
 * (filesystem/Pi-auth-free).
 *
 * See Projects/Piren/model-fallbacks-design.md §4.3 and §5. This module is
 * PURE CORE ONLY: it plans the next fallback attempt after an already
 * classified eligible outcome and renders the continuation handoff. It never
 * performs runtime fallback — no `set_model`, no prompt, no RPC, no session
 * mutation, no persistence, queues, retries, catalog probing, or agent
 * rerouting. Same-agent/session-affinity is pure planning state held by the
 * caller (per incident), never stored here.
 *
 * `planFallbackAttempt` is deterministic and total: every input maps to exactly
 * one `FallbackPlanResult`. Gate precedence (highest first): aborted incident,
 * explicit steward model selection, auto-switch disabled, non-eligible outcome.
 * Eligible incidents select configured fallback models strictly in declaration
 * order, never choosing the current (just-failed) model or any model already
 * attempted in this incident; exhaustion is a distinct result, not a retry or
 * loop. Attempt numbering is deterministic and evidence fields never carry
 * error text.
 *
 * `buildFallbackHandoffPrompt` renders the design §4.3 handoff: it names only
 * the prior model ID and the eligible category, states the prior run produced
 * no output or tools, preserves the original request verbatim, and instructs
 * durable-evidence inspection / no repetition of uncertain side effects. It
 * never includes provider error text, credentials, or an implicit new request.
 */

import { isFallbackEligibleOutcome, type RunOutcome } from "./model-fallback-outcome.js";

export type NoAttemptReason =
  | "auto-switch-disabled"
  | "explicit-model-selected"
  | "aborted"
  | "not-eligible";

export type FallbackPlanResult =
  | { kind: "no-attempt"; reason: NoAttemptReason }
  | { kind: "attempt"; modelId: string; attemptNumber: number }
  | { kind: "exhausted"; attemptedCount: number };

export interface PlanFallbackAttemptInput {
  /** Configured fallback models in declaration order (exact provider/modelId). */
  configuredFallbacks: readonly string[];
  /** Whether automatic switching is enabled (`model.fallback.auto_switch`). */
  autoSwitch: boolean;
  /** An explicit steward model selection for the session disables automatic fallback. */
  explicitModelSelected: boolean;
  /** The incident was aborted/cancelled by the steward; no automatic attempt. */
  aborted: boolean;
  /** The classified outcome of the just-finished run (eligible or not). */
  outcome: RunOutcome;
  /** The active model of the run that just failed (primary or a prior fallback). */
  currentModelId: string;
  /** Fallback models already attempted in this incident, in order. Optional. */
  attemptedModelIds?: readonly string[];
}

/**
 * Plan the next fallback attempt for one incident. Deterministic and total.
 * Gate precedence (highest first): aborted, explicit selection, auto-switch
 * disabled, non-eligible outcome. Eligible incidents pick the first configured
 * fallback not equal to the current model and not already attempted
 * (at-most-once, declaration order); exhaustion is a distinct result.
 */
export function planFallbackAttempt(input: PlanFallbackAttemptInput): FallbackPlanResult {
  if (input.aborted) {
    return { kind: "no-attempt", reason: "aborted" };
  }
  if (input.explicitModelSelected) {
    return { kind: "no-attempt", reason: "explicit-model-selected" };
  }
  if (!input.autoSwitch) {
    return { kind: "no-attempt", reason: "auto-switch-disabled" };
  }
  if (!isFallbackEligibleOutcome(input.outcome)) {
    return { kind: "no-attempt", reason: "not-eligible" };
  }

  const attemptedModelIds = input.attemptedModelIds ?? [];
  const skip = new Set<string>([input.currentModelId, ...attemptedModelIds]);

  for (const modelId of input.configuredFallbacks) {
    if (!skip.has(modelId)) {
      return { kind: "attempt", modelId, attemptNumber: attemptedModelIds.length + 1 };
    }
  }

  return { kind: "exhausted", attemptedCount: attemptedModelIds.length };
}

/**
 * Render the design §4.3 continuation handoff. The original prompt is appended
 * VERBATIM after the handoff header (no trimming or modification). `category`
 * is one of the two eligible provider-error categories; `fromModelId` is the
 * exact prior model id. Neither the header nor the appended prompt ever carries
 * provider error text or credentials from this function's inputs.
 */
export function buildFallbackHandoffPrompt(
  originalPrompt: string,
  fromModelId: string,
  category: "provider_error_other" | "provider_error_transient_exhausted",
): string {
  const header = [
    `[model fallback: your previous run on ${fromModelId} ended with a provider error`,
    ` (${category}) before producing any output or running any tool. Continue the`,
    " original request exactly. Inspect durable task/conversation evidence before",
    " acting and do not repeat uncertain side effects. The request is unchanged:]",
  ].join("\n");
  return `${header}\n${originalPrompt}`;
}
