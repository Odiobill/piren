import { PiRpcClient, type RpcCompaction, type RpcNewSession, type RpcSpawnTarget } from "./gateway-rpc.js";
import type { RpcTargetBuilder } from "./gateway-http.js";
export interface TransportRpcClient {
    start(): Promise<void>;
    stop(): Promise<void>;
    abort(): Promise<void>;
    /** Pi-native fresh session in the same process. Rejects on RPC failure. */
    newSession(): Promise<RpcNewSession>;
    /** Pi-native manual compaction. Rejects on RPC failure. */
    compact(): Promise<RpcCompaction>;
}
/**
 * Outcome of a conversation-scoped `newSession` control. `no-active-session`
 * means the conversation has no live Pi RPC client (nothing was created);
 * `cancelled` means a Pi extension declined the fresh session; `completed`
 * means Pi started the fresh session. Client/RPC errors always reject.
 */
export type TransportNewSessionOutcome = {
    status: "no-active-session";
} | {
    status: "completed";
} | {
    status: "cancelled";
};
/**
 * Outcome of a conversation-scoped `compact` control. Token figures are
 * Pi's heuristic estimates (null when Pi omits them); raw summary/transcript
 * data is never surfaced.
 */
export type TransportCompactOutcome = {
    status: "no-active-session";
} | {
    status: "completed";
    tokensBefore: number | null;
    estimatedTokensAfter: number | null;
};
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
    /**
     * Start a fresh Pi session for an existing conversation through Pi's
     * native `new_session` control. Never creates a client when none is
     * active; the active agent and RPC client identity are preserved (no
     * process restart or swap). RPC errors reject.
     */
    newSession(transport: string, conversationId: string): Promise<TransportNewSessionOutcome>;
    /**
     * Manually compact an existing conversation's Pi session through Pi's
     * native `compact` control. Never creates a client when none is active and
     * does not change automatic-compaction policy. RPC errors reject.
     */
    compact(transport: string, conversationId: string): Promise<TransportCompactOutcome>;
    closeIdleSessions(maxIdleMs: number): Promise<number>;
    closeAll(): Promise<void>;
    private assertRunnable;
}
