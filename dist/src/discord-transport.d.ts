import { type RpcEvent, type RpcSpawnTarget } from "./gateway-rpc.js";
import { type TransportRpcClient } from "./transport-session-manager.js";
import type { RpcTargetBuilder } from "./gateway-http.js";
import { type TransportFeedbackConfig } from "./transport-feedback.js";
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
    id?: string;
    guild_id?: string;
    channel_id?: string;
    thread_id?: string;
    content?: string;
    /** Sender identity from the gateway payload. Never inferred from channel/guild IDs. */
    author?: {
        id?: string;
        bot?: boolean;
    };
}
/** Discord channel type for a one-to-one direct message. Group DMs are type 3. */
export declare const DISCORD_CHANNEL_TYPE_DM = 1;
/** Channel metadata used only for fail-closed DM authorization (ADR-0040 D1). */
export interface DiscordChannelMetadata {
    id?: string;
    type?: number;
}
export interface DiscordBotApi {
    createMessage(channelId: string, text: string): Promise<void>;
    /** Best-effort typing indicator. Discord typing expires after ~10s. */
    sendTyping(channelId: string): Promise<void>;
    /** Best-effort emoji reaction on a message. Must not throw on failure. */
    addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
    /**
     * Channel metadata lookup. The gateway MESSAGE_CREATE payload has no
     * authoritative channel-type discriminator, so DM authorization verifies
     * the channel type through this lookup (only Discord type 1 is accepted).
     * Called ONLY for non-guild messages whose sender is already in the DM
     * allowlist; never for guild traffic.
     */
    getChannel(channelId: string): Promise<DiscordChannelMetadata>;
}
export declare class DiscordBotApiHttpClient implements DiscordBotApi {
    private readonly botToken;
    private readonly fetchImpl;
    constructor(botToken: string, fetchImpl?: typeof fetch);
    createMessage(channelId: string, text: string): Promise<void>;
    sendTyping(channelId: string): Promise<void>;
    addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
    getChannel(channelId: string): Promise<DiscordChannelMetadata>;
    private authHeaders;
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
    /**
     * Explicit one-to-one DM user allowlist (ADR-0040 D1). Omitted or empty
     * means every direct message is denied. Never widens guild, ordinary
     * channel, or thread access.
     */
    allowedDmUserIds?: Array<number | string> | undefined;
    runnableAgents: string[];
    defaultAgent?: string | undefined;
    targetBuilder: RpcTargetBuilder;
    clientFactory: (target: RpcSpawnTarget) => TClient;
    api: DiscordBotApi;
    feedback?: TransportFeedbackConfig | undefined;
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
    private readonly allowedDmUserIds;
    private readonly runnableAgents;
    private readonly defaultAgent;
    private readonly api;
    private readonly feedback;
    private readonly sessions;
    constructor(options: DiscordTransportOptions<TClient>);
    handleMessage(message: DiscordMessage): Promise<void>;
    close(): Promise<void>;
    /**
     * Verify through the Bot API that a channel is a one-to-one DM (Discord
     * channel type 1). Any failure — group DM (type 3), unknown type, lookup
     * error, malformed response — fails closed.
     */
    private isDirectMessageChannel;
    private sendPromptFeedbackStart;
    private sendPromptFeedbackComplete;
    /**
     * `/new`: start a fresh Pi session for this conversation through Pi's
     * native control. Never creates a session; failures are acknowledged
     * generically so raw RPC error text, paths, and transcripts never leak
     * into the channel.
     */
    private handleNewSessionCommand;
    /**
     * `/compact`: request Pi's native manual compaction for this conversation.
     * Same safety contract as `/new`: no session creation, no token/usage or
     * transcript details, generic failure acknowledgement.
     */
    private handleCompactCommand;
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
