import { type RpcSpawnTarget } from "./gateway-rpc.js";
/**
 * Send a single prompt to a Pi agent over RPC and return the assembled
 * assistant text. Tokens are delivered live through the onToken callback
 * as they stream in.
 *
 * This is the core of `piren ask`: a CLI one-shot wrapper around the same
 * PiRpcClient the gateway uses. It starts Pi in --mode rpc, subscribes for
 * events, sends the prompt, and streams text_delta tokens until agent_end.
 */
export declare function askAgent(target: RpcSpawnTarget, message: string, onToken?: (token: string) => void): Promise<string>;
