import { PiRpcClient } from "./gateway-rpc.js";
/**
 * Send a single prompt to a Pi agent over RPC and return the assembled
 * assistant text. Tokens are delivered live through the onToken callback
 * as they stream in.
 *
 * This is the core of `piren ask`: a CLI one-shot wrapper around the same
 * PiRpcClient the gateway uses. It starts Pi in --mode rpc, subscribes for
 * events, sends the prompt, and streams text_delta tokens until agent_end.
 */
export async function askAgent(target, message, onToken) {
    const client = new PiRpcClient(target);
    await client.start();
    try {
        return await new Promise((resolve, reject) => {
            let text = "";
            const unsubscribe = client.onEvent((event) => {
                if (event.type === "message_update" &&
                    typeof event.assistantMessageEvent === "object" &&
                    event.assistantMessageEvent !== null) {
                    const inner = event.assistantMessageEvent;
                    if (inner.type === "text_delta" && typeof inner.delta === "string") {
                        text += inner.delta;
                        onToken?.(inner.delta);
                    }
                }
                if (event.type === "agent_end") {
                    unsubscribe();
                    resolve(text);
                }
            });
            client.prompt(message).catch((err) => {
                unsubscribe();
                reject(err);
            });
        });
    }
    finally {
        await client.stop();
    }
}
//# sourceMappingURL=ask.js.map