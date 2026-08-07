/**
 * C2 — Conversation broker (ADR-0042, accepted C2 contract §4).
 *
 * Per-conversation×agent isolated Pi RPC client lifecycle mirroring the
 * accepted room broker SEMANTICS (at-most-one-active-run, durable-first
 * typed outcome evidence) without generalizing or changing room code: no
 * handoff or agent-address expansion; C3-C1 adds only the exact in-memory
 * conversation approval registry. No queue/retry/fallback/reroute/auto-approval.
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
import { type ConversationHandoffRequest } from "./conversation-handoff.js";
import { type TransportRpcClient } from "./transport-session-manager.js";
import type { RpcTargetBuilder } from "./gateway-http.js";
import { type ExtensionUiResponse, type RpcEvent, type RpcSpawnTarget } from "./gateway-rpc.js";
import { type GatewayFallbackPolicy } from "./model-fallback-gateway.js";
/** C2 committed context budget (contract §5). */
export declare const CONVERSATION_CONTEXT_MAX_ITEMS = 8;
export declare const CONVERSATION_CONTEXT_MAX_CHARS = 16384;
export interface ConversationRpcClient extends TransportRpcClient {
    onEvent(listener: (event: RpcEvent) => void): () => void;
    onExit(listener: () => void): () => void;
    prompt(message: string): Promise<void>;
    respondToUiRequest(id: string, response: ExtensionUiResponse): void;
    /** TB6: switch the active model on the same live client (optional; a
     * fallback attempt fails closed as an unavailable skip when absent). */
    setModel?(provider: string, modelId: string): Promise<unknown>;
}
export interface ConversationBrokerTimers {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}
/**
 * TB6: per-agent resolved fallback policy (mirrors the room broker). The
 * production adapter reads `team/<agent>/config.yml` best-effort under the
 * vault root; tests inject a fixed policy so the broker core stays
 * fake-client/filesystem-testable.
 */
export type ConversationBrokerFallbackPolicyLoader = (agent: string) => Promise<GatewayFallbackPolicy>;
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
    /**
     * TB6: per-agent fallback policy loader (defaults to a best-effort
     * `team/<agent>/config.yml` adapter over the vault root). Absent /
     * malformed / disabled / no-primary policy is inert. The conversation
     * broker gains NO approval/agent-address/handoff facility.
     */
    fallbackPolicyLoader?: ConversationBrokerFallbackPolicyLoader | undefined;
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
/** C3-C1: bounded pending-approval notification for a conversation-scoped listener. */
export interface ConversationApprovalNotification {
    conversationId: string;
    agent: string;
    requestId: string;
    method: string;
    /** Bounded Pi request payload (everything except type/id). */
    payload: Record<string, unknown>;
}
/** C3-C1: response input for one pending conversation approval. */
export interface ConversationApprovalInput {
    conversationId: string;
    agent: string;
    requestId: string;
    response: unknown;
}
/** C3-C1: abort outcome for exactly one conversation × agent key. */
export type ConversationAbortOutcome = {
    status: "cancelled";
    conversationId: string;
    agent: string;
    terminalEventId: string;
} | {
    status: "no-active-run";
    conversationId: string;
    agent: string;
};
/** C5-1: outcome of one conversation handoff request (accepted or bounded-rejected). */
export type ConversationHandoffRequestResult = {
    status: "accepted";
    to: string;
    handoffEventId: string;
} | {
    status: "rejected";
    reason: string;
};
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
/**
 * C3-C1: validate a raw approval response into the room-precedent exactly-one
 * shape (`{confirmed:boolean}` | `{value:string}` | `{cancelled:true}`).
 * Returns null for missing, wrong-typed, multiple, or non-object shapes so
 * the core rejects malformed responses deterministically (the later gateway
 * slice maps the bounded rejection to its HTTP vocabulary).
 */
export declare function parseConversationApprovalResponse(value: unknown): ExtensionUiResponse | null;
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
    private readonly fallbackPolicyLoader;
    private readonly activeRuns;
    private readonly eventListeners;
    /** C3-C1: in-memory pending approvals keyed exactly conversationId:agent:requestId. */
    private readonly pendingApprovals;
    private readonly approvalListeners;
    private closed;
    constructor(options: ConversationBrokerOptions);
    hasActiveRun(conversationId: string, agent: string): boolean;
    /** C3-C1: whether an exact conversation×agent×requestId approval is pending. */
    hasPendingApproval(conversationId: string, agent: string, requestId: string): boolean;
    /**
     * C3-C1: subscribe to pending-approval notifications for exactly one
     * conversation. Fired only when an active conversation×agent run registers
     * an exact approvable request. Never auto-approves and never persists
     * approval payloads.
     */
    onConversationApproval(conversationId: string, listener: (approval: ConversationApprovalNotification) => void): () => void;
    onConversationEvent(conversationId: string, listener: (event: ConversationEventNotification) => void): () => void;
    private appendAndPublish;
    /**
     * Dispatch one validated conversation mention. The durable steward message
     * was already persisted by the gateway (durable-first): the broker records
     * bounded run evidence only and never rolls the message back.
     */
    dispatchConversationMention(input: ConversationMentionInput): Promise<ConversationDispatchOutcome>;
    /** C5-1: launch a deferred handoff child only after a `completed` source terminal. */
    private maybeLaunchDeferredChild;
    private reserveRun;
    private executeConversationRun;
    private handleClientEvent;
    /**
     * TB6 rotation decision after one logical attempt reaches agent_settled
     * (mirrors the room broker). Continuation ONLY for a fully-settled
     * zero-side-effect eligible provider error on the SAME live isolated
     * client/session: durable `model_fallback` evidence is appended first
     * (correlated to the steward event), then `set_model(next)` and a handoff
     * re-prompt wrapping the ORIGINAL prompt verbatim. Declaration-order
     * at-most-once; a rejected `set_model` is an attempted unavailable skip
     * keeping the settled outcome pending (never re-runs the request on the
     * just-failed model); exhaustion settles a visible `provider_error`
     * terminal. Abort/close/timeout/exit settling the run at any await
     * boundary (including during `set_model`) cancels remaining attempts.
     */
    private onSettledAttempt;
    private settle;
    private finalizeRun;
    /**
     * C3-C1: respond to a pending approval on the exact conversation×agent
     * client that raised it. The response is validated into the exactly-one
     * shape; unknown, stale, or already-settled requests reject with the
     * contract's bounded strict 409-ready message (the gateway mapping is a
     * later slice). Calls `respondToUiRequest` at most once and cleans up the
     * entry. Never auto-approves, never persists approval payloads, and never
     * consults manifest lifecycle status (controls are run-scoped).
     */
    respondToConversationApproval(input: ConversationApprovalInput): void;
    /**
     * C3-C1: abort the active run for exactly one conversation × agent key. No
     * active run returns `no-active-run`. A real abort settles the run once
     * with cancel, the dispatch finalization performs the client abort and
     * appends exactly one durable `run_cancelled`; this method waits for that
     * terminal record. A second abort for the same key sees `no-active-run`
     * and never duplicates the record. Run-scoped: manifest lifecycle status
     * is never consulted.
     */
    abort(conversationId: string, agent: string): Promise<ConversationAbortOutcome>;
    /** C3-C1: exactly one run_cancelled when cancellation wins during startup. */
    private finalizeCancelledDuringInit;
    /**
     * C5-1: request one conversation handoff from an eligible active run. The
     * caller supplies ONLY `{to, text}`; identity, root correlation, budget,
     * and capability are derived from the broker's run state and the durable
     * event chain. An accepted edge appends one immutable handoff event and
     * grows the audience additively (M1) through the authoritative lock path;
     * the child launches later, sequentially, only after a `completed` source
     * terminal (§6.3). Failures are bounded non-secret rejections with no
     * event, no budget consumption, and no queue/retry/reroute.
     */
    requestConversationHandoff(conversationId: string, agent: string, request: ConversationHandoffRequest): Promise<ConversationHandoffRequestResult>;
    /**
     * C5-1 sequential defer-launch: start the accepted handoff child ONLY on
     * the current durable state (open conversation, member, runnable, no
     * active run) and only after the source settled `completed`. Every launch
     * failure records exactly one `run_finished` failed `launch_failure`
     * correlated to the handoff event; the accepted handoff event stands as
     * the causality record. Non-throwing.
     */
    private launchDeferredStageRun;
    close(): Promise<void>;
}
