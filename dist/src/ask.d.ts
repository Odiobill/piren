import { type RpcEvent, type RpcSpawnTarget } from "./gateway-rpc.js";
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
export type BoundedRunFailureKind = "launch_failure" | "ambiguous";
export interface BoundedRunFailure {
    kind: BoundedRunFailureKind;
    /** Control-flow position where the failure was observed. Optional only for
     * ambiguous failures from legacy/uninstrumented runners. */
    milestone?: BoundedRunMilestone;
    detail: string;
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
 * classified wait always settles when the process terminates.
 */
export interface PiRpcClientLike {
    start(): Promise<void>;
    stop(): Promise<void>;
    onEvent(listener: (event: RpcEvent) => void): () => void;
    onExit(listener: () => void): () => void;
    prompt(message: string): Promise<void>;
}
export interface AskAgentClassifiedOptions {
    onToken?: (token: string) => void;
    /** Injectable client factory; production defaults to `new PiRpcClient(target)`. */
    clientFactory?: (target: RpcSpawnTarget) => PiRpcClientLike;
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
 * - `agent_end` -> ok with the assembled text.
 */
export declare function askAgentClassified(target: RpcSpawnTarget, message: string, options?: AskAgentClassifiedOptions): Promise<AskOutcome>;
/**
 * Send a single prompt to a Pi agent over RPC and return the assembled
 * assistant text. Tokens are delivered live through the onToken callback
 * as they stream in.
 *
 * Thin compatibility wrapper over {@link askAgentClassified}: failures throw
 * with the classified detail, preserving the historical `piren ask` contract.
 */
export declare function askAgent(target: RpcSpawnTarget, message: string, onToken?: (token: string) => void): Promise<string>;
