/**
 * C2 — Conversation broker (ADR-0042, accepted C2 contract §4).
 *
 * Per-conversation×agent isolated Pi RPC client lifecycle mirroring the
 * accepted room broker SEMANTICS (at-most-one-active-run, durable-first
 * typed outcome evidence) without generalizing or changing room code: no
 * handoff, no approval registry, no agent-address expansion, no
 * queue/retry/fallback/reroute/auto-approval.
 *
 * The durable steward message is written by the gateway BEFORE dispatch and
 * is never rolled back because a later Pi dispatch conflicts or fails: the
 * broker only records bounded run evidence (`run_started` /
 * `run_finished` / `run_cancelled` with typed outcomes and `failure_kind`
 * only `launch_failure|ambiguous` when failed).
 *
 * Context handoff: the caller supplies the prior durable transcript
 * (excluding the current message); the broker renders the C2 bounded replay
 * (maxItems 8 / maxChars 16384 via the accepted C1 `selectDurableTranscript`)
 * into the prompt and records the exact selection metadata on run_started.
 */
import { type ConversationContextMetadata, type ConversationEventRecord, type ConversationManifest, type ConversationRunFailureKind, type ConversationWriteIo } from "./conversations.js";
import { type TransportRpcClient } from "./transport-session-manager.js";
import type { RpcTargetBuilder } from "./gateway-http.js";
import { type ExtensionUiResponse, type RpcEvent, type RpcSpawnTarget } from "./gateway-rpc.js";
/** C2 committed context budget (contract §5). */
export declare const CONVERSATION_CONTEXT_MAX_ITEMS = 8;
export declare const CONVERSATION_CONTEXT_MAX_CHARS = 16384;
export interface ConversationRpcClient extends TransportRpcClient {
    onEvent(listener: (event: RpcEvent) => void): () => void;
    onExit(listener: () => void): () => void;
    prompt(message: string): Promise<void>;
    respondToUiRequest(id: string, response: ExtensionUiResponse): void;
}
export interface ConversationBrokerTimers {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}
export interface ConversationBrokerOptions {
    vaultRoot: string;
    runnableAgents: string[];
    targetBuilder: RpcTargetBuilder;
    clientFactory?: (target: RpcSpawnTarget) => ConversationRpcClient;
    now?: () => Date;
    nonce?: () => string;
    timers?: ConversationBrokerTimers;
    runTimeoutMs?: number;
    io?: ConversationWriteIo | undefined;
    conversationReader?: (options: {
        vaultRoot: string;
        conversationId: string;
    }) => Promise<ConversationManifest>;
}
export interface ConversationMentionInput {
    conversationId: string;
    agent: string;
    text: string;
    /** Durable steward_message event id already persisted by the gateway. */
    stewardEventId: string;
    /** Prior durable transcript EXCLUDING the current message (durable order). */
    priorEvents: readonly ConversationEventRecord[];
}
export type ConversationDispatchOutcome = {
    status: "completed";
    conversationId: string;
    agent: string;
    stewardEventId: string;
    terminalEventId: string;
} | {
    status: "failed";
    conversationId: string;
    agent: string;
    stewardEventId: string;
    terminalEventId: string;
    failureKind: ConversationRunFailureKind;
} | {
    status: "timed_out";
    conversationId: string;
    agent: string;
    stewardEventId: string;
    terminalEventId: string;
} | {
    status: "cancelled";
    conversationId: string;
    agent: string;
    stewardEventId: string;
    terminalEventId: string;
};
export interface ConversationEventNotification {
    conversationId: string;
    id: string;
    kind: string;
    authorKind: string;
    author: string;
    created: string;
    body: string;
}
/**
 * The bounded prompt handed to Pi for one conversation mention. Renders the
 * C2 bounded prior-transcript replay in durable order with an explicit
 * recipient-visible truncation notice; the current raw request is the
 * dispatch message and is never duplicated as "prior" context. Rendered
 * `@text` is never parsed; no new authority is granted.
 */
export declare function buildConversationMentionPrompt(input: {
    conversationId: string;
    agent: string;
    text: string;
    priorLines: readonly string[];
    truncated: boolean;
    omittedCount: number;
}): string;
/** Render one prior durable event as a compact context line. */
export declare function conversationEventToContextLine(event: ConversationEventRecord): string;
/** Select the C2 bounded prior-transcript replay using the accepted C1 core. */
export declare function selectConversationContext(priorEvents: readonly ConversationEventRecord[]): {
    lines: string[];
    truncated: boolean;
    metadata: ConversationContextMetadata;
};
export declare class ConversationBroker {
    private readonly vaultRoot;
    private readonly runnableAgents;
    private readonly sessions;
    private readonly now;
    private readonly nonce;
    private readonly timers;
    private readonly runTimeoutMs;
    private readonly io;
    private readonly conversationReader;
    private readonly activeRuns;
    private readonly eventListeners;
    private closed;
    constructor(options: ConversationBrokerOptions);
    hasActiveRun(conversationId: string, agent: string): boolean;
    onConversationEvent(conversationId: string, listener: (event: ConversationEventNotification) => void): () => void;
    private appendAndPublish;
    /**
     * Dispatch one validated conversation mention. The durable steward message
     * was already persisted by the gateway (durable-first): the broker records
     * bounded run evidence only and never rolls the message back.
     */
    dispatchConversationMention(input: ConversationMentionInput): Promise<ConversationDispatchOutcome>;
    private reserveRun;
    private executeConversationRun;
    private handleClientEvent;
    private settle;
    private finalizeRun;
    close(): Promise<void>;
}
