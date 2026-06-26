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
    private readonly responseTimeoutMs;
    constructor(target: RpcSpawnTarget);
    start(): Promise<void>;
    stop(): Promise<void>;
    onEvent(listener: RpcEventListener): () => void;
    /**
     * Subscribe to agent process exits. The listener fires once when the child
     * exits (normally or via signal), after stderr has been collected. Useful for
     * surfacing mid-stream crashes as errors to callers that own a stream.
     */
    onExit(listener: () => void): () => void;
    getStderr(): string;
    /**
     * Send a prompt and resolve once Pi acknowledges it. The ack response arrives
     * after preflight; it is NOT completion. Streaming events continue to arrive
     * through `onEvent` until `agent_end`. Use this (rather than `promptAndWait`)
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
     * Send a prompt and wait for the turn to finish, returning every event
     * streamed until `agent_end`. The prompt is async: the client subscribes for
     * events before sending so the first streaming events are never missed, and
     * completion is the `agent_end` event (not the prompt ack response).
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
