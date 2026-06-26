import { type RpcEvent, type RpcSpawnTarget } from "./gateway-rpc.js";
import { type TransportRpcClient } from "./transport-session-manager.js";
import type { RpcTargetBuilder } from "./gateway-http.js";
export interface TelegramMessage {
    chat?: {
        id?: number | string;
    };
    text?: string;
}
export interface TelegramUpdate {
    update_id?: number;
    message?: TelegramMessage;
}
export interface TelegramBotApi {
    sendMessage(chatId: number | string, text: string): Promise<void>;
}
export interface TelegramPollingApi extends TelegramBotApi {
    getUpdates(offset: number | undefined, timeoutSeconds: number): Promise<TelegramUpdate[]>;
}
export declare class TelegramBotApiHttpClient implements TelegramPollingApi {
    private readonly botToken;
    private readonly fetchImpl;
    constructor(botToken: string, fetchImpl?: typeof fetch);
    sendMessage(chatId: number | string, text: string): Promise<void>;
    getUpdates(offset: number | undefined, timeoutSeconds: number): Promise<TelegramUpdate[]>;
    private fetchJson;
}
export interface TelegramPromptClient extends TransportRpcClient {
    promptAndWait(message: string): Promise<RpcEvent[]>;
}
export interface TelegramTransportOptions<TClient extends TelegramPromptClient> {
    transportName?: string | undefined;
    allowedChatIds: Array<number | string>;
    runnableAgents: string[];
    defaultAgent?: string | undefined;
    targetBuilder: RpcTargetBuilder;
    clientFactory: (target: RpcSpawnTarget) => TClient;
    api: TelegramBotApi;
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
    private readonly sessions;
    constructor(options: TelegramTransportOptions<TClient>);
    handleUpdate(update: TelegramUpdate): Promise<void>;
    close(): Promise<void>;
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
