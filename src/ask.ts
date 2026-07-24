import { PiRpcClient, type RpcEvent, type RpcSpawnTarget } from "./gateway-rpc.js";

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
// Bounded-run failure classification (ADR-0038 revision 3)
//
// Classification derives from control-flow position ONLY — never from error
// text, exit codes, missing output, or output content. Exactly two positions
// may be `launch_failure`: `target_build` (the run target could not be
// constructed; executor-side) and `start_rejection` (`PiRpcClient.start()`
// rejected before the prompt handoff). The prompt handoff is the point of no
// return: every outcome at/after it is `ambiguous` and held.
// ---------------------------------------------------------------------------

export type BoundedRunMilestone =
  | "target_build"
  | "start_rejection"
  | "prompt_handoff"
  | "post_ack"
  | "mid_stream";

export type BoundedRunFailureKind = "launch_failure" | "ambiguous";

export interface BoundedRunFailure {
  kind: BoundedRunFailureKind;
  /** Control-flow position where the failure was observed. Optional only for
   * ambiguous failures from legacy/uninstrumented runners. */
  milestone?: BoundedRunMilestone;
  detail: string;
}

/** Outcome of one classified bounded ask. */
export type AskOutcome =
  | { ok: true; text: string }
  | { ok: false; failure: BoundedRunFailure };

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    return await new Promise<AskOutcome>((resolve) => {
      let text = "";
      let sawAgentEvent = false;
      let settled = false;

      const unsubscribeEvent = client.onEvent((event) => {
        sawAgentEvent = true;
        if (
          event.type === "message_update" &&
          typeof event.assistantMessageEvent === "object" &&
          event.assistantMessageEvent !== null
        ) {
          const inner = event.assistantMessageEvent as {
            type?: unknown;
            delta?: unknown;
          };
          if (inner.type === "text_delta" && typeof inner.delta === "string") {
            text += inner.delta;
            options.onToken?.(inner.delta);
          }
        }
        if (event.type === "agent_end") {
          finish({ ok: true, text });
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
            detail: "agent process terminated before agent_end",
          },
        });
      });

      function finish(outcome: AskOutcome): void {
        if (settled) return;
        settled = true;
        unsubscribeEvent();
        unsubscribeExit();
        resolve(outcome);
      }

      client.prompt(message).catch((error: unknown) => {
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
 */
export async function askAgent(
  target: RpcSpawnTarget,
  message: string,
  onToken?: (token: string) => void,
): Promise<string> {
  const options: AskAgentClassifiedOptions = {};
  if (onToken !== undefined) options.onToken = onToken;
  const outcome = await askAgentClassified(target, message, options);
  if (!outcome.ok) {
    throw new Error(outcome.failure.detail);
  }
  return outcome.text;
}
