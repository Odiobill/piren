/**
 * Spawn target for the RPC client. In production this is produced by
 * `buildPiRunCommand({ rpcMode: true })` (pi --mode rpc ..., or explicit npx latest fallback). In tests it
 * points at a fake Pi process so the client can be exercised without live
 * model auth.
 */
export interface RpcSpawnTarget {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
}
/**
 * A single JSONL line emitted by Pi on stdout that is not a command response.
 * These are AgentSessionEvent objects (agent_start, message_update,
 * tool_execution_*, queue_update, agent_end, extension_ui_request, ...). The
 * shape is deliberately loose: token deltas are nested inside
 * `assistantMessageEvent`, so callers must narrow structurally rather than
 * depend on a flat event type.
 */
export interface RpcEvent {
    type: string;
    [key: string]: unknown;
}
/** A command-response line emitted by Pi on stdout. */
export interface RpcResponseLine {
    type: "response";
    command: string;
    success: boolean;
    id?: string;
    data?: unknown;
    error?: string;
}
/**
 * A model available to the current agent. Shape is deliberately loose: Pi's
 * internal `Model` type is generic over provider-specific metadata, so we only
 * narrow the fields the gateway and UI need.
 */
export interface RpcModel {
    provider?: string;
    id?: string;
    contextWindow?: number;
    reasoning?: boolean;
    [key: string]: unknown;
}
/** Response to `get_available_models`. */
export interface RpcAvailableModels {
    models: RpcModel[];
}
/**
 * Session state returned by `get_state`. Drives the context indicator. Only the
 * fields the gateway uses are typed; Pi may emit more.
 */
export interface RpcSessionState {
    model?: RpcModel;
    thinkingLevel?: string;
    isStreaming?: boolean;
    isCompacting?: boolean;
    steeringMode?: "all" | "one-at-a-time";
    followUpMode?: "all" | "one-at-a-time";
    sessionFile?: string;
    sessionId?: string;
    sessionName?: string;
    autoCompactionEnabled?: boolean;
    messageCount?: number;
    pendingMessageCount?: number;
    /** Optional Pi context-window telemetry, when exposed by the runtime. */
    contextWindow?: number;
    contextWindowTokens?: number;
    maxContextTokens?: number;
    contextUsed?: number;
    contextUsedTokens?: number;
    usedTokens?: number;
    inputTokens?: number;
}
/**
 * Response to an `extension_ui_request` (approval gate). Mirrors Pi's
 * `RpcExtensionUIResponse` but as a plain object without the `type`/`id`
 * wrapper, which `respondToUiRequest` adds.
 */
export type ExtensionUiResponse = {
    confirmed: boolean;
} | {
    value: string;
} | {
    cancelled: true;
};
/**
 * Response to `get_messages`. Pi returns the full transcript of the current
 * session. The message shape is provider-specific, so it is kept loose.
 */
export interface RpcMessages {
    messages: Record<string, unknown>[];
}
/**
 * Response to `switch_session`. `cancelled` is true when Pi could not resume
 * the requested session (for example, it did not exist or the user declined).
 */
export interface RpcSessionSwitch {
    cancelled: boolean;
}
/**
 * Response to `new_session`. `cancelled` is true when a Pi extension
 * (`session_before_switch`) declined the fresh session. No session paths or
 * transcript data are exposed; parent-session tracking is not supported.
 */
export interface RpcNewSession {
    cancelled: boolean;
}
/**
 * Token totals for one Pi session, from `get_session_stats`. Includes
 * assistant messages, tool-reported usage, and compaction/branch-summary
 * generation across the full session (docs/rpc.md).
 */
export interface RpcSessionTokenTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
}
/**
 * Current context-window usage from `get_session_stats`. Two DISTINCT
 * unavailable states exist (docs/rpc.md) and are never collapsed: the whole
 * `contextUsage` object is omitted when no model or context window is
 * available, while immediately after compaction a PRESENT object carries
 * `tokens: null` and `percent: null` until a fresh post-compaction assistant
 * response provides valid usage data. `contextWindow` is always numeric when
 * the object is present.
 */
export interface RpcContextUsage {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
}
/**
 * Response to `get_session_stats`: token usage, cost, and current context
 * window usage for one exact Pi session. The public result carries only the
 * documented fields: unknown extra fields are tolerated on the wire but never
 * leak into this typed shape. Missing/invalid optional scalars degrade to
 * documented null/zero fallbacks; a non-object payload or a structurally
 * invalid `contextUsage` is a protocol violation and rejects instead of
 * fabricating an unavailable state.
 */
export interface RpcSessionStats {
    sessionFile: string | null;
    sessionId: string | null;
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    toolResults: number;
    totalMessages: number;
    tokens: RpcSessionTokenTotals;
    cost: number;
    contextUsage?: RpcContextUsage;
}
/**
 * Minimal result of a manual `compact`. Deliberately excludes Pi's raw
 * summary, kept-entry ids, and usage details: transport callers only need a
 * concise acknowledgement, never transcript content. Token figures are null
 * when Pi omits them (for example with custom compaction handlers).
 */
export interface RpcCompaction {
    tokensBefore: number | null;
    estimatedTokensAfter: number | null;
}
type RpcEventListener = (event: RpcEvent) => void;
/**
 * Concatenate assistant text deltas from a stream of RPC events.
 *
 * Token deltas are nested inside `message_update.assistantMessageEvent` with
 * type `text_delta`. There is no flat token event, so a client that looked for
 * one would assemble nothing.
 */
export declare function extractAssistantText(events: RpcEvent[]): string;
/**
 * Client for a Pi agent spawned in `--mode rpc`. Speaks strict LF-only JSONL
 * (splitting on "\n" only, never readline), pairs commands with their ack
 * responses by id, and drains streaming events to subscribed listeners.
 *
 * This is a separate process gateway client: it never imports Pi in-process.
 */
export declare class PiRpcClient {
    private readonly target;
    private process;
    private stopReading;
    private readonly listeners;
    private readonly exitListeners;
    private readonly pending;
    private seq;
    private stderr;
    private exitError;
    /** One-shot guard: termination listeners fire at most once per start. */
    private terminationNotified;
    private readonly responseTimeoutMs;
    constructor(target: RpcSpawnTarget);
    start(): Promise<void>;
    stop(): Promise<void>;
    onEvent(listener: RpcEventListener): () => void;
    /**
     * One-shot termination notification: runs each subscribed listener at most
     * once per start, even when a post-spawn error is later followed by exit.
     */
    private notifyTerminated;
    /**
     * Subscribe to agent process termination. The listener fires AT MOST ONCE
     * per start: when the child exits (normally or via signal) OR when the
     * child errors post-spawn, whichever happens first, after stderr has been
     * collected. Useful for surfacing mid-stream crashes as errors to callers
     * that own a stream, and for classified waits that must settle on any
     * termination path without duplicate signals (ADR-0038 revision 3).
     */
    onExit(listener: () => void): () => void;
    getStderr(): string;
    /**
     * Send a prompt and resolve once Pi acknowledges it. The ack response arrives
     * after preflight; it is NOT completion. Streaming events continue to arrive
     * through `onEvent` until `agent_settled`. Use this (rather than `promptAndWait`)
     * when you need to forward events live instead of collecting them.
     */
    prompt(message: string): Promise<void>;
    /**
     * Fetch the current session state: model, thinking level, streaming status,
     * message count, session id, and more. Drives the composer footer context
     * indicator in the web UI.
     */
    getState(): Promise<RpcSessionState>;
    /**
     * Fetch token usage, cost, and current context-window usage for this exact
     * Pi session (`get_session_stats`, docs/rpc.md). The typed result preserves
     * Pi's two distinct context-usage states: `contextUsage` is ABSENT when no
     * model/context window is available, and PRESENT with `tokens: null` /
     * `percent: null` immediately after compaction. Rejects on command
     * rejection and on malformed payload shapes; never fabricates a state.
     */
    getSessionStats(): Promise<RpcSessionStats>;
    /**
     * List the models available to the current agent. Returns provider, id,
     * context window, and reasoning flag for each model.
     */
    getAvailableModels(): Promise<RpcAvailableModels>;
    /**
     * Switch the active model. Pi acks with the new model object on success.
     * The change is also broadcast as a `model_changed` event to all event
     * listeners.
     */
    setModel(provider: string, modelId: string): Promise<RpcModel>;
    /**
     * Set the thinking level. Pi acks with success. The change is also broadcast
     * as a `thinking_level_changed` event to all event listeners.
     */
    setThinkingLevel(level: string): Promise<void>;
    /**
     * Interrupt the current run with a steering message. The message is injected
     * mid-stream; Pi acks with success. Queue changes arrive as `queue_update`
     * events through `onEvent`.
     */
    steer(message: string): Promise<void>;
    /**
     * Queue a follow-up message to run after the current turn completes. Pi acks
     * with success. The message appears in `queue_update` events as a follow-up
     * entry.
     */
    followUp(message: string): Promise<void>;
    /**
     * Respond to an `extension_ui_request` (approval gate). This is a raw stdin
     * write: Pi does NOT send an ack `response` for `extension_ui_response`, it
     * resolves the pending request internally. Using `send()` here would time out
     * waiting for an ack that never arrives.
     *
     * The response shape depends on the request method:
     * - confirm: `{ confirmed: boolean }`
     * - select/input: `{ value: string }`
     * - any: `{ cancelled: true }`
     */
    respondToUiRequest(id: string, response: ExtensionUiResponse): void;
    /**
     * Abort the current turn mid-stream. Pi acks with success and emits
     * `agent_end`, which drains any active SSE streams so they close cleanly.
     * Use this to stop a runaway turn the steward wants to interrupt.
     */
    abort(): Promise<void>;
    /**
     * Fetch the full transcript of the current session. The message shape is
     * provider-specific, so callers receive a loose array. Used to repopulate
     * the chat view after a browser reconnect.
     */
    getMessages(): Promise<RpcMessages>;
    /**
     * Resume a past session by its on-disk path. Returns whether Pi cancelled
     * the resume (the session did not exist or the user declined). On a
     * successful resume, subsequent prompts and events belong to the resumed
     * session.
     */
    switchSession(sessionPath: string): Promise<RpcSessionSwitch>;
    /**
     * Start a fresh Pi session in this same RPC process, keeping the active
     * Piren agent and transport conversation. Returns whether a Pi extension
     * cancelled the switch. This is Pi's native control: no process restart,
     * no model prompt, and no parent-session tracking.
     */
    newSession(): Promise<RpcNewSession>;
    /**
     * Request Pi's native manual compaction of the current session. This does
     * not synthesize a model prompt and does not change automatic-compaction
     * policy. The returned contract is minimal on purpose: raw summary and
     * transcript data stay inside Pi.
     */
    compact(): Promise<RpcCompaction>;
    /**
     * Send a prompt and wait for the turn to fully settle, returning every event
     * streamed until `agent_settled`. The prompt is async: the client subscribes
     * for events before sending so the first streaming events are never missed.
     *
     * TB0/G1: completion is ONLY `agent_settled` — an `agent_end` (regardless of
     * `willRetry`, including false/absent) is never terminal by itself: Pi may
     * still auto-retry, retry compaction, or drain queued follow-up messages
     * (docs/rpc.md). The 30s timeout remains the conservative bound for a
     * process that dies or a run that never settles.
     */
    promptAndWait(message: string, timeoutMs?: number): Promise<RpcEvent[]>;
    private handleLine;
    /**
     * Write a JSONL line to Pi stdin without pairing it with an ack response.
     * Used for `extension_ui_response`, which Pi resolves internally without
     * sending a `response` line back. Using `send()` for these would time out.
     */
    private writeRaw;
    private send;
    private createExitError;
    private rejectPending;
}
export {};
