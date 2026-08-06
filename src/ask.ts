import { PiRpcClient, type RpcEvent, type RpcSpawnTarget } from "./gateway-rpc.js";
import { classifyRunOutcome, isFallbackEligibleOutcome, type RunOutcome } from "./model-fallback-outcome.js";
import { planFallbackAttempt, buildFallbackHandoffPrompt } from "./model-fallback-rotation.js";
import { splitFallbackModelId, type GatewayFallbackPolicy } from "./model-fallback-gateway.js";

/**
 * Send a single prompt to a Pi agent over RPC and return the assembled
 * assistant text. Tokens are delivered live through the onToken callback
 * as they stream in.
 *
 * This is the core of `piren ask`: a CLI one-shot wrapper around the same
 * PiRpcClient the gateway uses. It starts Pi in --mode rpc, subscribes for
 * events, sends the prompt, and streams text_delta tokens until agent_end.
 */

// ---------------------------------------------------------------------------
// Bounded-run failure classification (ADR-0038 revision 3 + TB5 exhaustion)
//
// Classification derives from control-flow position ONLY — never from error
// text, exit codes, missing output, or output content. Exactly two positions
// may be `launch_failure`: `target_build` (the run target could not be
// constructed; executor-side) and `start_rejection` (`PiRpcClient.start()`
// rejected before the prompt handoff). The prompt handoff is the point of no
// return: every outcome at/after it is `ambiguous` and held.
//
// TB5 adds one distinct terminal kind, `exhausted`: a fully settled
// zero-side-effect eligible provider-error run with no remaining configured
// fallback (declaration-order at-most-once rotation exhausted). It carries
// safe evidence (category + last model id + attempted count) only, never raw
// provider error text. It is NOT a recategorization of launch_failure or
// ambiguous; the scheduler retry seam (launch_failure only) is untouched.
// ---------------------------------------------------------------------------

export type BoundedRunMilestone =
  | "target_build"
  | "start_rejection"
  | "prompt_handoff"
  | "post_ack"
  | "mid_stream";

export type BoundedRunFailureKind = "launch_failure" | "ambiguous" | "exhausted";

/** Safe, non-secret TB5 model-fallback exhaustion evidence. */
export interface AskFallbackExhaustion {
  /** The last eligible provider-error category observed before exhaustion. */
  category: "provider_error_other" | "provider_error_transient_exhausted";
  /** The model of the last failed run (evidence, never error text). */
  lastModelId: string;
  /** Number of configured fallback models attempted in this incident. */
  attemptedCount: number;
}

export interface BoundedRunFailure {
  kind: BoundedRunFailureKind;
  /** Control-flow position where the failure was observed. Optional only for
   * ambiguous failures from legacy/uninstrumented runners and for TB5
   * `exhausted` terminals (no single control-flow position). */
  milestone?: BoundedRunMilestone;
  detail: string;
  /** Present exactly when kind is `exhausted` (TB5): safe category/model
   * evidence only, never raw provider error text. */
  exhaustion?: AskFallbackExhaustion;
}

/** Outcome of one classified bounded ask. */
export type AskOutcome =
  | { ok: true; text: string }
  | { ok: false; failure: BoundedRunFailure };

/**
 * The subset of `PiRpcClient` the ask flow uses, injectable for tests. The
 * production client satisfies this structurally. Contract: exit listeners
 * fire on BOTH the child `exit` and the child `error` path (post-spawn), so a
 * classified wait always settles when the process terminates. `setModel` is
 * optional so existing fake clients and callers without fallback policy stay
 * valid; when a fallback attempt needs it and it is absent, the attempt fails
 * closed as an unavailable skip.
 */
export interface PiRpcClientLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent(listener: (event: RpcEvent) => void): () => void;
  onExit(listener: () => void): () => void;
  prompt(message: string): Promise<void>;
  setModel?(provider: string, modelId: string): Promise<unknown>;
}

export interface AskAgentClassifiedOptions {
  onToken?: (token: string) => void;
  /** Injectable client factory; production defaults to `new PiRpcClient(target)`. */
  clientFactory?: (target: RpcSpawnTarget) => PiRpcClientLike;
  /**
   * TB5: the resolved agent-local model-fallback policy. Resolved at the
   * CLI/runtime adapter boundary (never read here from files/YAML/RPC args).
   * Absent => inert single-run behavior; the scheduler `createAskRunner` does
   * not pass one, so it stays inert until TB8.
   */
  fallbackPolicy?: GatewayFallbackPolicy | undefined;
  /**
   * TB5: bounded non-secret advisory output (stdout lines) emitted before
   * each fallback handoff reply and for unavailable skips. Absent => silent.
   */
  onAdvisory?: (line: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type RunOnceResult =
  | { ok: true; events: RpcEvent[]; text: string }
  | { ok: false; failure: BoundedRunFailure };

/**
 * Run one prompt on the client and resolve with its event stream and text
 * once the logical run FULLY settles (`agent_settled` — the sole terminal
 * boundary since TB0/G1; an `agent_end` alone is never terminal). Prompt
 * rejection and process termination settle conservative ambiguous outcomes.
 */
function runOncePrompt(
  client: PiRpcClientLike,
  prompt: string,
  onToken: ((token: string) => void) | undefined,
): Promise<RunOnceResult> {
  return new Promise<RunOnceResult>((resolve) => {
    const events: RpcEvent[] = [];
    let text = "";
    let sawAgentEvent = false;
    let settled = false;

    function finish(result: RunOnceResult): void {
      if (settled) return;
      settled = true;
      unsubscribeEvent();
      unsubscribeExit();
      resolve(result);
    }

    const unsubscribeEvent = client.onEvent((event) => {
      sawAgentEvent = true;
      events.push(event);
      if (
        event.type === "message_update" &&
        typeof event.assistantMessageEvent === "object" &&
        event.assistantMessageEvent !== null
      ) {
        const inner = event.assistantMessageEvent as { type?: unknown; delta?: unknown };
        if (inner.type === "text_delta" && typeof inner.delta === "string") {
          text += inner.delta;
          onToken?.(inner.delta);
        }
      }
      // TB0/G1: only agent_settled is terminal. An agent_end (regardless of
      // willRetry, including false/absent) is never a completion: Pi may still
      // auto-retry, retry compaction, or drain queued follow-ups.
      if (event.type === "agent_settled") {
        finish({ ok: true, events, text });
      }
    });

    const unsubscribeExit = client.onExit(() => {
      // Post-handoff termination is ALWAYS ambiguous (ADR-0038 revision 3):
      // the prompt may already have been accepted.
      finish({
        ok: false,
        failure: {
          kind: "ambiguous",
          milestone: sawAgentEvent ? "mid_stream" : "post_ack",
          detail: "agent process terminated before agent_settled",
        },
      });
    });

    client.prompt(prompt).catch((error: unknown) => {
      finish({
        ok: false,
        failure: {
          kind: "ambiguous",
          milestone: "prompt_handoff",
          detail: errorMessage(error),
        },
      });
    });
  });
}

/**
 * Classified single-prompt ask. Returns a typed outcome instead of throwing:
 *
 * - `start()` rejection -> `launch_failure` at `start_rejection` (the only
 *   pre-handoff position this function can observe; `target_build` happens
 *   earlier, in the caller).
 * - Prompt rejection (write throw, preflight rejection, ack timeout) ->
 *   `ambiguous` at `prompt_handoff`.
 * - Process termination (exit OR error path) after the handoff -> `ambiguous`
 *   at `post_ack` (no agent-visible event observed) or `mid_stream` (at least
 *   one observed). The wait ALWAYS settles on termination: no hang.
 * - `agent_settled` -> ok with the assembled text.
 *
 * TB5 bounded same-live-client fallback: when a resolved `fallbackPolicy` is
 * provided and a settled run classifies as an eligible zero-side-effect
 * provider-error category, the SAME live client switches model via
 * `set_model(next)` and re-prompts with the TB3 verbatim-safe handoff wrapping
 * the ORIGINAL request. Rotation is declaration-order at-most-once through
 * `planFallbackAttempt`; a rejected `set_model` is an attempted unavailable
 * skip that keeps the settled outcome pending (never re-runs the request on
 * the just-failed model) and tries the next configured candidate; exhaustion
 * is a typed non-ok `exhausted` terminal with safe category/model evidence.
 * Absent/malformed/disabled policy is inert (single-run behavior). No CLI
 * model-selection surface exists for ask in TB5, so incidents are never
 * explicitly selected. No error-message/status parsing, no credentials, no
 * hidden state, no `switch_session`, no respawn, no blind replay.
 */
export async function askAgentClassified(
  target: RpcSpawnTarget,
  message: string,
  options: AskAgentClassifiedOptions = {},
): Promise<AskOutcome> {
  const clientFactory = options.clientFactory ?? ((t: RpcSpawnTarget) => new PiRpcClient(t));
  const client = clientFactory(target);

  try {
    await client.start();
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: "launch_failure",
        milestone: "start_rejection",
        detail: errorMessage(error),
      },
    };
  }

  try {
    const policy = options.fallbackPolicy ?? null;
    const config = policy !== null && policy.fallback.ok && policy.fallback.present ? policy.fallback.config : null;
    const onToken = options.onToken;
    const onAdvisory = options.onAdvisory;
    // Session model affinity: starts at the configured primary; every
    // successful set_model updates it; a successful fallback stays active for
    // this one live session (no primary restore).
    let currentModelId: string | null = policy !== null ? policy.primaryModelId : null;

    if (config === null) {
      // Inert policy (absent/malformed): the existing single-run contract — a
      // settled run is ok with whatever text it assembled, regardless of stop
      // reason. The scheduler createAskRunner never passes a policy, so it
      // stays inert here until TB8.
      const run = await runOncePrompt(client, message, onToken);
      if (!run.ok) return { ok: false, failure: run.failure };
      return { ok: true, text: run.text };
    }

    const attemptedModelIds: string[] = [];
    let prompt = message;
    // The last settled run awaiting a rotation decision. A rejected set_model
    // keeps it pending so the loop plans the NEXT configured fallback directly
    // (design §5.1/§7: skip with evidence, try the next) instead of re-running
    // the request on the just-failed model. Only a successful switch clears
    // it, triggering the handoff re-prompt.
    let pending: { outcome: RunOutcome; text: string } | null = null;
    let terminal: AskOutcome | null = null;

    while (terminal === null) {
      if (pending === null) {
        const run = await runOncePrompt(client, prompt, onToken);
        if (!run.ok) {
          terminal = { ok: false, failure: run.failure };
          break;
        }
        pending = { outcome: classifyRunOutcome(run.events), text: run.text };
      }

      const { outcome } = pending;
      const plan = planFallbackAttempt({
        configuredFallbacks: config.models,
        autoSwitch: config.autoSwitch,
        // TB5: ask has no explicit model-selection surface; the incident is
        // never explicitly selected.
        explicitModelSelected: false,
        // TB5: ask has no abort control plane.
        aborted: false,
        outcome,
        currentModelId: currentModelId ?? "",
        attemptedModelIds,
      });

      if (plan.kind === "no-attempt") {
        terminal = { ok: true, text: pending.text };
        break;
      }
      // planFallbackAttempt only reaches attempt/exhausted for eligible
      // outcomes; TS cannot see that correlation, so narrow explicitly and
      // fail closed if it ever disagrees.
      if (!isFallbackEligibleOutcome(outcome)) {
        terminal = { ok: true, text: pending.text };
        break;
      }

      if (plan.kind === "exhausted") {
        const exhaustion: AskFallbackExhaustion = {
          category: outcome.category,
          lastModelId: currentModelId ?? "",
          attemptedCount: plan.attemptedCount,
        };
        terminal = {
          ok: false,
          failure: {
            kind: "exhausted",
            detail: `model fallback exhausted after ${exhaustion.attemptedCount} attempt(s) on ${exhaustion.lastModelId} (${exhaustion.category}).`,
            exhaustion,
          },
        };
        break;
      }

      // A planned attempt: emit a bounded non-secret advisory before the
      // handoff reply, then switch on the same live client.
      onAdvisory?.(`[model fallback: ${currentModelId ?? ""} failed (${outcome.category}) → ${plan.modelId}]`);
      const split = splitFallbackModelId(plan.modelId);
      let switched = false;
      try {
        if (typeof client.setModel !== "function") {
          throw new Error("RPC client does not support set_model");
        }
        await client.setModel(split.provider, split.modelId);
        currentModelId = plan.modelId;
        switched = true;
      } catch {
        // Unavailable fallback: bounded attempted skip; never retried within
        // the incident and never re-prompts the just-failed model.
      }
      attemptedModelIds.push(plan.modelId);
      if (!switched) {
        onAdvisory?.(`[model fallback: ${plan.modelId} unavailable; skipping]`);
        // Keep the pending outcome so the next iteration plans the next
        // configured fallback directly (no re-prompt on the failed model).
        continue;
      }
      prompt = buildFallbackHandoffPrompt(message, plan.modelId, outcome.category);
      pending = null;
    }

    return terminal;
  } finally {
    await client.stop();
  }
}

/**
 * Send a single prompt to a Pi agent over RPC and return the assembled
 * assistant text. Tokens are delivered live through the onToken callback
 * as they stream in.
 *
 * Thin compatibility wrapper over {@link askAgentClassified}: failures throw
 * with the classified detail, preserving the historical `piren ask` contract.
 * Callers without fallback policy keep the exact existing behavior; TB5
 * callers may pass `options.fallbackPolicy`/`options.onAdvisory`.
 */
export async function askAgent(
  target: RpcSpawnTarget,
  message: string,
  onToken?: (token: string) => void,
  options: AskAgentOptions = {},
): Promise<string> {
  const classifiedOptions: AskAgentClassifiedOptions = {};
  if (onToken !== undefined) classifiedOptions.onToken = onToken;
  if (options.fallbackPolicy !== undefined) classifiedOptions.fallbackPolicy = options.fallbackPolicy;
  if (options.onAdvisory !== undefined) classifiedOptions.onAdvisory = options.onAdvisory;
  if (options.clientFactory !== undefined) classifiedOptions.clientFactory = options.clientFactory;
  const outcome = await askAgentClassified(target, message, classifiedOptions);
  if (!outcome.ok) {
    throw new Error(outcome.failure.detail);
  }
  return outcome.text;
}

/** TB5 askAgent options: the classified options minus the internal surface. */
export interface AskAgentOptions {
  onToken?: (token: string) => void;
  /** TB5: resolved agent-local fallback policy (inert when absent). */
  fallbackPolicy?: GatewayFallbackPolicy | undefined;
  /** TB5: bounded non-secret advisory output before fallback handoff replies. */
  onAdvisory?: (line: string) => void;
  /** Injectable client factory (tests). */
  clientFactory?: (target: RpcSpawnTarget) => PiRpcClientLike;
}
