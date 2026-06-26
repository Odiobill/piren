import { PiRpcClient, type RpcSpawnTarget } from "./gateway-rpc.js";
import type { RpcTargetBuilder } from "./gateway-http.js";
export interface TransportRpcClient {
    start(): Promise<void>;
    stop(): Promise<void>;
    abort(): Promise<void>;
}
export interface TransportSession<TClient extends TransportRpcClient = PiRpcClient> {
    transport: string;
    conversationId: string;
    agent: string;
    client: TClient;
    lastUsedAt: number;
}
export interface TransportSessionManagerOptions<TClient extends TransportRpcClient = PiRpcClient> {
    runnableAgents: string[];
    defaultAgent?: string | undefined;
    targetBuilder: RpcTargetBuilder;
    clientFactory?: ((target: RpcSpawnTarget) => TClient) | undefined;
    now?: (() => number) | undefined;
}
/**
 * Owns one Pi RPC client per messaging-platform conversation.
 *
 * Messaging platforms such as Telegram and Discord can have many concurrent
 * chats, channels, or threads. Each conversation keeps one active Piren agent
 * selected from the local runnable set, with its own RPC child process. This
 * keeps platform identities separate from Piren agent identities per ADR-0016.
 */
export declare class TransportSessionManager<TClient extends TransportRpcClient = PiRpcClient> {
    private readonly runnableAgents;
    private readonly defaultAgent;
    private readonly targetBuilder;
    private readonly clientFactory;
    private readonly now;
    private readonly sessions;
    constructor(options: TransportSessionManagerOptions<TClient>);
    getSession(transport: string, conversationId: string, agent?: string): Promise<TransportSession<TClient>>;
    switchAgent(transport: string, conversationId: string, agent: string): Promise<TransportSession<TClient>>;
    abort(transport: string, conversationId: string): Promise<boolean>;
    getActiveAgent(transport: string, conversationId: string): string | null;
    closeIdleSessions(maxIdleMs: number): Promise<number>;
    closeAll(): Promise<void>;
    private assertRunnable;
}
