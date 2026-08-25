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
import { type ExtensionUiResponse, type RpcEvent, type RpcSessionState, type RpcSessionStats, type RpcSpawnTarget } from "./gateway-rpc.js";
import { type ConversationTelemetryFacts } from "./conversation-telemetry.js";
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
    /**
     * P5 automatic steer: interrupt the current run on the same live client via
     * the existing Pi RPC `steer` command. Resolves once Pi acknowledges the
     * delivery; rejects on rejection/RPC failure (the caller contains it).
     */
    steer(message: string): Promise<void>;
    /**
     * T3: typed session stats for live-only settle telemetry (optional; absence
     * means no frame is ever published for the settling run).
     */
    getSessionStats?(): Promise<RpcSessionStats>;
    /** T3: session state for live-only settle telemetry (optional, same rule). */
    getState?(): Promise<RpcSessionState>;
}
/**
 * P5 — outcome of steering an exact active conversation run: `steered` on a
 * delivered Pi ack, `no-active-run` when the exact run is idle (caller falls
 * back to existing dispatch), or `steer-failed` for a bounded rejection/
 * failure (the durable message stands; no run/terminal/status fabrication).
 */
export type ConversationSteerOutcome = {
    status: "steered";
} | {
    status: "no-active-run";
} | {
    status: "steer-failed";
};
/** VR-2: absent-option fallback run deadline — the accepted 60-minute hard cap. */
export declare const DEFAULT_WORKBENCH_RUN_TIMEOUT_MS = 3600000;
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
/**
 * ADR-0044 — separately typed agent-first start input. Carries NO steward
 * text and NO transcript: the broker start path never calls
 * `dispatchConversationMention`, never requires a steward message, and never
 * becomes a C5 root/workflow run. The origin event id is the durable
 * `conversation_start_requested` system event persisted by the gateway BEFORE
 * dispatch; every run event correlates to it.
 */
export interface ConversationAgentStartInput {
    conversationId: string;
    agent: string;
    /** Durable conversation_start_requested origin event id (correlation anchor). */
    originEventId: string;
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
/**
 * A live event is the exact complete durable-record shape. Consumers may
 * safely render it with the same parser as `/events`; live transport is never
 * a lossy parallel schema that only becomes readable after a history reload.
 */
export type ConversationEventNotification = ConversationEventRecord;
/** C3-C1: bounded pending-approval notification for a conversation-scoped listener. */
export interface ConversationApprovalNotification {
    conversationId: string;
    agent: string;
    requestId: string;
    method: string;
    /** Bounded Pi request payload (everything except type/id). */
    payload: Record<string, unknown>;
}
/** U4+VR-3: broker-authoritative transient live activity for one active run. */
export type ConversationActivityKind = "working" | "text_delta" | "settled" | "tool";
export type ConversationActivityOutcome = "completed" | "failed" | "timed_out" | "cancelled";
/** VR-3: exact bounded tool lifecycle status. */
export type ConversationToolStatus = "started" | "completed" | "failed";
export interface ConversationActivityNotification {
    conversationId: string;
    /** Opaque broker-generated per-active-run key (unique while the broker is alive). */
    runId: string;
    /** The broker-selected exact run agent (never browser text or roster inference). */
    agent: string;
    kind: ConversationActivityKind;
    /** text_delta only: the exact non-empty Pi assistant delta, bounded. */
    delta?: string;
    /** settled only: the terminal outcome after the durable terminal append. */
    outcome?: ConversationActivityOutcome;
    /** tool only: bounded sanitized Pi tool name. */
    toolName?: string;
    /** tool only: exact lifecycle status. */
    status?: ConversationToolStatus;
}
/**
 * T3: live-only telemetry notification for one exact settled
 * `conversation × agent` run. Carries only bounded browser-safe facts (the
 * pure mapper allowlist) plus the exact conversation/agent/run correlation.
 * NEVER durable, NEVER replayed: it exists only as a live scoped SSE frame.
 */
export type ConversationTelemetryNotification = ConversationTelemetryFacts & {
    conversationId: string;
    /** The broker-selected exact run agent (never browser text or roster inference). */
    agent: string;
    /** Immediate run correlation: the exact settled run's broker runId. */
    runId: string;
};
/**
 * T4: result of the scoped on-demand telemetry read for one exact
 * `conversation × agent` pair. `live` carries the bounded T3 facts;
 * `no_live_session` covers every unavailable case (no live pair, missing
 * optional RPC capabilities, sampling rejection/throw, closed broker) —
 * availability is truthful, never a fabricated or reconstructed state.
 */
export type ConversationTelemetryReadResult = (ConversationTelemetryFacts & {
    sessionState: "live";
}) | {
    sessionState: "no_live_session";
};
/** U4: the bounded per-frame assistant delta (larger deltas emit no frame). */
export declare const CONVERSATION_ACTIVITY_DELTA_MAX = 4096;
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
/** C5-2: outcome of one initial handoff-gate request (pending or bounded-rejected). */
export type ConversationGateRequestResult = {
    status: "pending";
    requestId: string;
} | {
    status: "rejected";
    reason: string;
};
/**
 * The bounded prompt handed to Pi for one conversation mention. Renders the
 * C2 bounded prior-transcript replay in durable order with an explicit
 * recipient-visible truncation notice; the current raw request is the
 * dispatch message and is never duplicated as "prior" context. Rendered
 * `@text` is never parsed; no new authority is granted. A C5 ROOT lead may
 * additionally be offered ONLY the ability to REQUEST the steward-approved
 * initial handoff gate (never a dispatch); every other run keeps the
 * no-handoff wording byte-for-byte.
 */
export declare function buildConversationMentionPrompt(input: {
    conversationId: string;
    agent: string;
    text: string;
    priorLines: readonly string[];
    truncated: boolean;
    omittedCount: number;
    /** C5-3: when true (a steward-dispatched ROOT lead), adds only the gate-request capability line. */
    rootHandoffGateRequest?: boolean;
}): string;
/**
 * ADR-0044 — the bounded prompt for the agent-first start run. It asks only
 * for one brief bounded greeting and to stop; it grants no new authority and
 * never frames the run as a reply to a steward_message (there is none), never
 * replays a transcript (a started Conversation has no prior messages), and
 * never mentions handoffs or workflows (a start run carries no C5 state).
 */
export declare function buildConversationAgentStartPrompt(input: {
    conversationId: string;
    agent: string;
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
    /** U4: scoped transient-activity listeners (never durable, never replayed). */
    private readonly activityListeners;
    /** T3: scoped live-only telemetry listeners per conversation. */
    private readonly telemetryListeners;
    /** U4: opaque per-run id sequence (unique while this broker is alive). */
    private runIdSeq;
    /** C3-C1: in-memory pending approvals keyed exactly conversationId:agent:requestId. */
    private readonly pendingApprovals;
    private readonly approvalListeners;
    /** C5-2: fallback synthesized gate-request id sequence when no nonce is injected. */
    private gateSeq;
    private closed;
    constructor(options: ConversationBrokerOptions);
    hasActiveRun(conversationId: string, agent: string): boolean;
    /**
     * P5 — publish one ALREADY-DURABLE conversation event (a gateway-appended
     * steward_message) to this conversation's scoped live subscribers BEFORE
     * any broker dispatch. Publication-only: it never appends, mutates, or
     * reorders durable evidence (the gateway keeps full append authority) and
     * observer failures are contained observability issues that can never
     * affect persistence, membership, or dispatch.
     */
    publishConversationEvent(conversationId: string, event: ConversationEventRecord): void;
    /**
     * P5 — automatic steer of the EXACT active conversation×agent run via the
     * existing Pi RPC `steer` capability: resolves once Pi acknowledges the
     * delivery (no new run/queue/terminal/status/membership event or outcome
     * claim). `no-active-run` means the caller should use existing dispatch;
     * a rejection/failure after the message is durable returns the bounded
     * `steer-failed` outcome — the original run keeps its own causal correlation.
     */
    steerActiveConversationRun(conversationId: string, agent: string, text: string): Promise<ConversationSteerOutcome>;
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
    /** U4: subscribe to broker-authoritative transient activity for one conversation. */
    onConversationActivity(conversationId: string, listener: (activity: ConversationActivityNotification) => void): () => void;
    /**
     * T3: subscribe to live-only settle telemetry for exactly one conversation.
     * Frames are transient: never durable, never replayed, scoped to the exact
     * conversation.
     */
    onConversationTelemetry(conversationId: string, listener: (telemetry: ConversationTelemetryNotification) => void): () => void;
    /**
     * T3: publish one live-only telemetry frame. Observer failures are
     * contained observability issues: they can never affect Pi, durable
     * evidence, settlement, locks, or subsequent dispatch.
     */
    private publishTelemetry;
    /**
     * T4: read the truthful session-only telemetry availability for exactly one
     * `conversation × agent` pair, using only the broker-owned ALREADY-LIVE
     * client. Never creates/spawns/resumes a client, never infers state from a
     * durable manifest/event/audience or a global chat session, never writes
     * durable evidence, and never publishes a live frame. The exact pair's
     * session may live under the plain key or a C5 role-suffixed key (mention
     * dispatches are `#root`, stage runs `#workflow`, start runs plain); when
     * several coexist, the most recently used live session is the truthful
     * current one. Any unavailable case — no live session, missing optional RPC
     * capabilities, sampling rejection/throw, closed broker — is the bounded
     * `no_live_session` result, never a fabricated or reconstructed state.
     */
    readConversationTelemetry(conversationId: string, agent: string): Promise<ConversationTelemetryReadResult>;
    /**
     * T3: sample the exact already-live client after its run settled and
     * publish one bounded live-only telemetry frame. Absence of a client,
     * absent optional RPC capabilities, a closed broker, or ANY sampling
     * rejection/throw is inert (no frame) and can never affect the terminal
     * outcome. There is deliberately no `no-live-session` publication in T3.
     */
    private publishSettledTelemetry;
    /**
     * U4: publish one transient activity frame. Observer failures are contained
     * observability issues: they can never affect Pi, durable evidence,
     * settlement, locks, or subsequent dispatch.
     */
    private publishActivity;
    /**
     * U4: the exact bounded assistant delta of a genuine nested Pi
     * `message_update.assistantMessageEvent` text_delta — or null when the
     * event is not a real text delta (empty/non-string/oversized/non-text
     * events emit no frame and never imply typing).
     */
    /**
     * U4: a genuine bounded text delta while the run is active emits one
     * transient text_delta frame (never synthesized from agent_end, errors,
     * approvals, fallback notices, or the final durable body).
     */
    private conversationTextDelta;
    /**
     * VR-3: project a Pi tool_execution_start/end event into a bounded activity
     * frame (kind tool + sanitized name + exact status). Raw args/results/
     * output/environment never leave this helper; malformed or hostile tool
     * names are dropped (the browser parser also rejects them fail-closed).
     */
    private conversationToolFrame;
    private appendAndPublish;
    /**
     * Dispatch one validated conversation mention. The durable steward message
     * was already persisted by the gateway (durable-first): the broker records
     * bounded run evidence only and never rolls the message back.
     */
    dispatchConversationMention(input: ConversationMentionInput): Promise<ConversationDispatchOutcome>;
    /**
     * ADR-0044 — dispatch the separately typed agent-first start run. The
     * durable manifest (audience: [agent]) and the system-authored
     * `conversation_start_requested` origin event were already persisted by the
     * gateway (durable-first); the broker records bounded run evidence
     * correlated to the origin event id and never rolls anything back.
     *
     * This entry point deliberately does NOT set `run.c5`: a start run is
     * neither a C5 root nor a workflow stage, so it never carries the handoff
     * env flag, can never request the gate or a handoff, and never schedules a
     * defer-launch edge. It shares only the private isolated-run/evidence
     * machinery (`reserveRun`/`executeConversationRun`) with mention dispatch.
     */
    startConversationAgentRun(input: ConversationAgentStartInput): Promise<ConversationDispatchOutcome>;
    /** C5-1 sequential defer-launch: launch a deferred handoff child only after a `completed` source terminal. */
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
    /**
     * C5-3: bridge one reserved conversation-handoff control request from the
     * flagged extension process to the broker's bounded core. Root mode may
     * ONLY request the initial C5-2 steward gate (answered promptly `pending`
     * with no side effect before confirmation); workflow mode may ONLY use the
     * existing C5-1 bounded acceptance path (`ok`). A malformed or stale
     * request gets exactly one bounded `rejected` response with no retry,
     * queue, reroute, fallback, or second UI attempt.
     */
    private handleConversationHandoffControlRequest;
    /** Answer the source run's reserved input request id with a bounded structured value. */
    private respondToConversationHandoffInput;
    private settle;
    private finalizeRun;
    /**
     * C3-C1: respond to a pending approval on the exact conversation×agent
     * client that raised it. The response is validated into the exactly-one
     * shape; unknown, stale, or already-settled requests reject with the
     * contract's bounded strict 409-ready message (the gateway mapping is a
     * later slice). A generic Pi UI approval calls `respondToUiRequest` at
     * most once and cleans up the entry. A pending initial handoff gate
     * (C5-2) resolves through this same exact path: `confirmed: true` awaits
     * the shared C5-1 accept (M1 audience growth, durable handoff event,
     * deferred defer-launch edge), every rejection stays bounded with no side
     * effects, and the promise resolves only after the edge is durable so the
     * approving route can truthfully return 200. Never auto-approves, never
     * persists approval payloads, and never consults manifest lifecycle
     * status (controls are run-scoped).
     */
    respondToConversationApproval(input: ConversationApprovalInput): Promise<void>;
    /**
     * C5-2: resolve a pending initial handoff gate through the exact approval
     * response path. `confirmed: true` accepts the stored root edge (shared
     * C5-1 accept: M1 audience growth, durable handoff event, deferred
     * defer-launch edge); `cancelled`/`confirmed:false` bounded-reject with
     * no side effects; a `value` response is a bounded 400-family rejection.
     * No durable approval evidence is ever written and no Pi request is ever
     * fabricated.
     */
    private resolveGateApproval;
    /** Settle the held root tool input only when this gate originated from it. */
    private respondGateHandoffInput;
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
     * C5-2: request the initial lead→first-stage steward confirmation gate
     * from a broker-spawned C5 ROOT run (direct steward dispatch, depth 0, no
     * handoff parent). Validates ONLY enough to create a bounded pending live
     * `confirm` approval keyed exactly conversation×agent×requestId and
     * notifies live SSE subscribers; the frame is answered through the
     * existing approve route. Before explicit steward confirmation there is NO
     * handoff event, NO audience mutation/lock acquisition, NO budget
     * consumption, and NO child dispatch. Settlement (settle/abort/close/
     * timeout) clears the pending gate under the existing C3 run-scoped
     * semantics; a late response gets the bounded stale rejection.
     */
    requestInitialHandoffGate(conversationId: string, agent: string, request: ConversationHandoffRequest, handoffRequestId?: string): Promise<ConversationGateRequestResult>;
    /**
     * C5-1/C5-2 shared accept: derive the durable workflow, plan the edge,
     * grow the audience additively (M1) through the authoritative no-clobber
     * lock path, append the exactly-one durable handoff event, and store the
     * deferred edge on the source run. Every failure is a bounded rejection
     * with no event, no audience mutation, no budget consumption, and no
     * dispatch.
     */
    private acceptHandoffEdge;
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
