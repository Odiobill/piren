import { type RpcEvent, type RpcSpawnTarget } from "./gateway-rpc.js";
import { type GatewayFallbackPolicy } from "./model-fallback-gateway.js";
/**
 * Send a single prompt to a Pi agent over RPC and return the assembled
 * assistant text. Tokens are delivered live through the onToken callback
 * as they stream in.
 *
 * This is the core of `piren ask`: a CLI one-shot wrapper around the same
 * PiRpcClient the gateway uses. It starts Pi in --mode rpc, subscribes for
 * events, sends the prompt, and streams text_delta tokens until agent_end.
 */
export type BoundedRunMilestone = "target_build" | "start_rejection" | "prompt_handoff" | "post_ack" | "mid_stream";
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
export type AskOutcome = {
    ok: true;
    text: string;
} | {
    ok: false;
    failure: BoundedRunFailure;
};
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
export declare function askAgentClassified(target: RpcSpawnTarget, message: string, options?: AskAgentClassifiedOptions): Promise<AskOutcome>;
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
export declare function askAgent(target: RpcSpawnTarget, message: string, onToken?: (token: string) => void, options?: AskAgentOptions): Promise<string>;
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
