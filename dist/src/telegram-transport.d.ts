import { type RpcEvent, type RpcSpawnTarget } from "./gateway-rpc.js";
import { type TransportRpcClient } from "./transport-session-manager.js";
import type { RpcTargetBuilder } from "./gateway-http.js";
import { type TransportFeedbackConfig } from "./transport-feedback.js";
export interface TelegramMessage {
    message_id?: number;
    chat?: {
        id?: number | string;
    };
    text?: string;
    /** Optional forum-topic identifier supplied by Telegram for topic messages. */
    message_thread_id?: number;
}
export interface TelegramUpdate {
    update_id?: number;
    message?: TelegramMessage;
}
export interface TelegramBotApi {
    /**
     * Send a text message. When `messageThreadId` (a Telegram forum topic id)
     * is supplied, the request includes `message_thread_id` so the reply lands
     * in the originating topic; otherwise the request body is unchanged.
     */
    sendMessage(chatId: number | string, text: string, messageThreadId?: number): Promise<void>;
    /** Best-effort typing indicator. Telegram's chat action expires after ~5s. */
    sendChatAction(chatId: number | string, action: string, messageThreadId?: number): Promise<void>;
    /**
     * Best-effort emoji reaction on a message. Must not throw on failure:
     * reactions are advisory feedback and must never abort a turn.
     */
    setMessageReaction(chatId: number | string, messageId: number, emoji: string): Promise<void>;
}
export interface TelegramPollingApi extends TelegramBotApi {
    getUpdates(offset: number | undefined, timeoutSeconds: number): Promise<TelegramUpdate[]>;
}
export declare class TelegramBotApiHttpClient implements TelegramPollingApi {
    private readonly botToken;
    private readonly fetchImpl;
    constructor(botToken: string, fetchImpl?: typeof fetch);
    sendMessage(chatId: number | string, text: string, messageThreadId?: number): Promise<void>;
    sendChatAction(chatId: number | string, action: string, messageThreadId?: number): Promise<void>;
    /**
     * Best-effort: a failed reaction (permissions, emoji not allowed, etc.)
     * resolves silently rather than rejecting. Feedback must never abort a turn.
     */
    setMessageReaction(chatId: number | string, messageId: number, emoji: string): Promise<void>;
    getUpdates(offset: number | undefined, timeoutSeconds: number): Promise<TelegramUpdate[]>;
    private fetchJson;
}
export interface TelegramPromptClient extends TransportRpcClient {
    promptAndWait(message: string): Promise<RpcEvent[]>;
}
/**
 * Resolve the internal routing key for a Telegram conversation.
 *
 * A non-topic chat retains its current chat-level key byte-for-byte
 * (`String(chatId)`). A forum topic message (Telegram supplies
 * `message_thread_id`) gets a deterministic distinct key built from
 * `chat_id` plus the topic id, so topics never share a transport session
 * with the plain chat or with each other.
 *
 * This key is internal session routing only. It is never an authorization
 * decision: access control remains exactly `telegram.allowed_chat_ids`.
 */
export declare function resolveTelegramConversationKey(chatId: number | string, messageThreadId?: number): string;
export interface TelegramTransportOptions<TClient extends TelegramPromptClient> {
    transportName?: string | undefined;
    allowedChatIds: Array<number | string>;
    runnableAgents: string[];
    defaultAgent?: string | undefined;
    targetBuilder: RpcTargetBuilder;
    clientFactory: (target: RpcSpawnTarget) => TClient;
    api: TelegramBotApi;
    feedback?: TransportFeedbackConfig | undefined;
}
/**
 * Minimal Telegram transport over the shared Pi RPC client.
 *
 * Telegram bot identity is a transport identity, not a Piren agent identity:
 * one bot can expose the local runnable-agent set and each allowlisted chat
 * keeps its own active Piren agent through TransportSessionManager.
 */
export declare class TelegramTransport<TClient extends TelegramPromptClient> {
    private readonly transportName;
    private readonly allowedChatIds;
    private readonly runnableAgents;
    private readonly defaultAgent;
    private readonly api;
    private readonly feedback;
    private readonly sessions;
    constructor(options: TelegramTransportOptions<TClient>);
    handleUpdate(update: TelegramUpdate): Promise<void>;
    close(): Promise<void>;
    private sendPromptFeedbackStart;
    private sendPromptFeedbackComplete;
    private handleAgentCommand;
}
/**
 * Telegram's sendMessage hard limit per message.
 *
 * Kept below the documented 4096 to leave headroom for the chat-side rendering
 * and any metadata a client may prepend.
 */
export declare const TELEGRAM_MESSAGE_LIMIT = 4000;
/**
 * Split a long assistant response into chunks that each fit Telegram's
 * sendMessage length limit.
 *
 * Splits on newline boundaries first so paragraphs stay intact, then on word
 * boundaries within a long paragraph, and finally hard-splits a single run of
 * characters that has no boundary. Returns an empty array for empty input so
 * callers can skip sending.
 */
export declare function chunkTelegramMessage(text: string, limit?: number): string[];
export interface RunTelegramPollingOptions<TClient extends TelegramPromptClient> {
    api: TelegramPollingApi;
    transport: TelegramTransport<TClient>;
    timeoutSeconds?: number | undefined;
    signal?: AbortSignal | undefined;
    onError?: ((error: Error) => void) | undefined;
}
export declare function runTelegramPolling<TClient extends TelegramPromptClient>(options: RunTelegramPollingOptions<TClient>): Promise<void>;
