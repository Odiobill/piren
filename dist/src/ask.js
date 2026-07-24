import { PiRpcClient } from "./gateway-rpc.js";
function errorMessage(error) {
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
export async function askAgentClassified(target, message, options = {}) {
    const clientFactory = options.clientFactory ?? ((t) => new PiRpcClient(t));
    const client = clientFactory(target);
    try {
        await client.start();
    }
    catch (error) {
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
        return await new Promise((resolve) => {
            let text = "";
            let sawAgentEvent = false;
            let settled = false;
            const unsubscribeEvent = client.onEvent((event) => {
                sawAgentEvent = true;
                if (event.type === "message_update" &&
                    typeof event.assistantMessageEvent === "object" &&
                    event.assistantMessageEvent !== null) {
                    const inner = event.assistantMessageEvent;
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
            function finish(outcome) {
                if (settled)
                    return;
                settled = true;
                unsubscribeEvent();
                unsubscribeExit();
                resolve(outcome);
            }
            client.prompt(message).catch((error) => {
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
    finally {
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
export async function askAgent(target, message, onToken) {
    const options = {};
    if (onToken !== undefined)
        options.onToken = onToken;
    const outcome = await askAgentClassified(target, message, options);
    if (!outcome.ok) {
        throw new Error(outcome.failure.detail);
    }
    return outcome.text;
}
//# sourceMappingURL=ask.js.map