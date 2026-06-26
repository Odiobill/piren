import { type RpcEvent, type RpcSpawnTarget } from "./gateway-rpc.js";
import { type TransportRpcClient } from "./transport-session-manager.js";
import type { RpcTargetBuilder } from "./gateway-http.js";
/**
 * Discord's message hard limit per message (documented as 2000).
 */
export declare const DISCORD_MESSAGE_LIMIT = 2000;
/**
 * Split a long assistant response into chunks that each fit Discord's message
 * length limit. Reuses the proven newline/word/hard-split algorithm from the
 * Telegram transport with the Discord-specific limit.
 */
export declare function chunkDiscordMessage(text: string, limit?: number): string[];
export interface DiscordMessage {
    guild_id?: string;
    channel_id?: string;
    thread_id?: string;
    content?: string;
}
export interface DiscordBotApi {
    createMessage(channelId: string, text: string): Promise<void>;
}
export declare class DiscordBotApiHttpClient implements DiscordBotApi {
    private readonly botToken;
    private readonly fetchImpl;
    constructor(botToken: string, fetchImpl?: typeof fetch);
    createMessage(channelId: string, text: string): Promise<void>;
    private describeError;
}
export interface DiscordPromptClient extends TransportRpcClient {
    promptAndWait(message: string): Promise<RpcEvent[]>;
}
export interface DiscordTransportOptions<TClient extends DiscordPromptClient> {
    transportName?: string | undefined;
    allowedGuildIds: Array<number | string>;
    allowedChannelIds: Array<number | string>;
    allowedThreadIds?: Array<number | string> | undefined;
    runnableAgents: string[];
    defaultAgent?: string | undefined;
    targetBuilder: RpcTargetBuilder;
    clientFactory: (target: RpcSpawnTarget) => TClient;
    api: DiscordBotApi;
}
/**
 * Minimal Discord transport over the shared Pi RPC client.
 *
 * Discord bot identity is a transport identity, not a Piren agent identity, per
 * ADR-0016. One Discord application can expose the local runnable-agent set,
 * and each allowlisted guild+channel (plus optional thread) conversation keeps
 * its own active Piren agent through TransportSessionManager.
 */
export declare class DiscordTransport<TClient extends DiscordPromptClient> {
    private readonly transportName;
    private readonly allowedGuildIds;
    private readonly allowedChannelIds;
    private readonly allowedThreadIds;
    private readonly runnableAgents;
    private readonly defaultAgent;
    private readonly api;
    private readonly sessions;
    constructor(options: DiscordTransportOptions<TClient>);
    handleMessage(message: DiscordMessage): Promise<void>;
    close(): Promise<void>;
    private handleAgentCommand;
}
/**
 * A minimal gateway socket abstraction. The production implementation wraps the
 * native `WebSocket`; tests inject a fake. The loop only needs the standard
 * event-handler properties plus `send`/`close`.
 */
export interface DiscordGatewaySocket {
    onopen: ((ev: unknown) => void) | null;
    onmessage: ((ev: {
        data: string;
    }) => void) | null;
    onclose: ((ev: unknown) => void) | null;
    onerror: ((ev: unknown) => void) | null;
    send(data: string): void;
    close(): void;
}
/** Loose shape of a Discord gateway payload. Narrowed structurally in the loop. */
export interface GatewayMessage {
    op?: number;
    t?: string | null;
    s?: number | null;
    d?: unknown;
}
export interface RunDiscordGatewayOptions<TClient extends DiscordPromptClient> {
    botToken: string;
    applicationId: string;
    intents: number;
    transport: DiscordTransport<TClient>;
    socketFactory: () => Promise<DiscordGatewaySocket>;
    /** Overrides the Hello heartbeat_interval. Mainly for fast tests. */
    heartbeatIntervalMs?: number | undefined;
    onReady?: (() => void) | undefined;
    onError?: ((error: Error) => void) | undefined;
}
export interface DiscordGatewayHandle {
    /** Resolves once the Identify payload has been sent (after Hello). */
    identified(): Promise<void>;
    /** Resolves after one microtask, letting a pending dispatch settle. */
    idle(): Promise<void>;
    /** Closes the gateway and stops the transport. */
    close(): Promise<void>;
}
/**
 * Drive a Discord gateway connection: open the socket, send Identify on Hello,
 * dispatch MESSAGE_CREATE events to the transport, and heartbeat at the
 * negotiated interval echoing the last sequence number.
 *
 * Discord requires a persistent WebSocket *client* connection (the Piren
 * process dials out to Discord). This is categorically different from adding a
 * WebSocket server to Piren's web UI (which stays SSE plus POST per ADR-0012).
 */
export declare function runDiscordGateway<TClient extends DiscordPromptClient>(options: RunDiscordGatewayOptions<TClient>): DiscordGatewayHandle;
/**
 * Production gateway socket factory: connects to the Discord gateway using the
 * native WebSocket (Node >= 22) and adapts it to the `DiscordGatewaySocket`
 * interface the loop consumes.
 */
export declare function createNativeDiscordGatewaySocket(url: string, WebSocketImpl?: typeof WebSocket): Promise<DiscordGatewaySocket>;
