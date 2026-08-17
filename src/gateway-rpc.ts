import { type ChildProcess, spawn } from "node:child_process";
import { createJsonlLineReader, serializeJsonLine } from "./jsonl.js";

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
export type ExtensionUiResponse =
  | { confirmed: boolean }
  | { value: string }
  | { cancelled: true };

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
 * window usage for one exact Pi session. All documented scalar fields are
 * required: malformed, missing, or non-finite wire values reject as malformed
 * rather than degrading into real-looking zeros or nulls. The only optional
 * property is `contextUsage`, which is absent exactly when Pi omits it (no
 * model/context window). Unknown extra fields are tolerated on the wire but
 * never leak into this typed shape.
 */
export interface RpcSessionStats {
  sessionFile: string;
  sessionId: string;
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

interface PendingRequest {
  resolve: (response: RpcResponseLine) => void;
  reject: (error: Error) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requireFiniteNumber(value: unknown): number {
  const num = asFiniteNumber(value);
  if (num === null) {
    throw new Error("get_session_stats returned malformed data");
  }
  return num;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("get_session_stats returned malformed data");
  }
  return value;
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || asFiniteNumber(value) !== null;
}

/**
 * Narrow untrusted `get_session_stats` response data into the public typed
 * shape. Strict on every documented field: missing, malformed, or non-finite
 * documented scalars reject instead of fabricating real-looking zeros/nulls.
 * `contextUsage` keeps Pi's two documented states exact: an absent property
 * stays absent on the typed result, while a present object must carry a
 * numeric `contextWindow` and `tokens`/`percent` that are each number or
 * null. A present `contextUsage: null` or any other structurally invalid
 * value rejects as malformed — it is not the omitted-property state.
 */
function parseSessionStats(data: unknown): RpcSessionStats {
  if (!isRecord(data)) {
    throw new Error("get_session_stats returned malformed data");
  }
  if (!isRecord(data.tokens)) {
    throw new Error("get_session_stats returned malformed data");
  }
  const stats: RpcSessionStats = {
    sessionFile: requireString(data.sessionFile),
    sessionId: requireString(data.sessionId),
    userMessages: requireFiniteNumber(data.userMessages),
    assistantMessages: requireFiniteNumber(data.assistantMessages),
    toolCalls: requireFiniteNumber(data.toolCalls),
    toolResults: requireFiniteNumber(data.toolResults),
    totalMessages: requireFiniteNumber(data.totalMessages),
    tokens: {
      input: requireFiniteNumber(data.tokens.input),
      output: requireFiniteNumber(data.tokens.output),
      cacheRead: requireFiniteNumber(data.tokens.cacheRead),
      cacheWrite: requireFiniteNumber(data.tokens.cacheWrite),
      total: requireFiniteNumber(data.tokens.total),
    },
    cost: requireFiniteNumber(data.cost),
  };
  if (data.contextUsage !== undefined) {
    const usage = data.contextUsage;
    if (!isRecord(usage)) {
      throw new Error("get_session_stats returned malformed contextUsage");
    }
    const contextWindow = asFiniteNumber(usage.contextWindow);
    const tokens = usage.tokens;
    const percent = usage.percent;
    if (contextWindow === null || !isNullableFiniteNumber(tokens) || !isNullableFiniteNumber(percent)) {
      throw new Error("get_session_stats returned malformed contextUsage");
    }
    stats.contextUsage = { tokens, contextWindow, percent };
  }
  return stats;
}

/**
 * Concatenate assistant text deltas from a stream of RPC events.
 *
 * Token deltas are nested inside `message_update.assistantMessageEvent` with
 * type `text_delta`. There is no flat token event, so a client that looked for
 * one would assemble nothing.
 */
export function extractAssistantText(events: RpcEvent[]): string {
  let text = "";
  for (const event of events) {
    if (event.type !== "message_update") continue;
    const inner = event.assistantMessageEvent;
    if (isRecord(inner) && inner.type === "text_delta" && typeof inner.delta === "string") {
      text += inner.delta;
    }
  }
  return text;
}

/**
 * Client for a Pi agent spawned in `--mode rpc`. Speaks strict LF-only JSONL
 * (splitting on "\n" only, never readline), pairs commands with their ack
 * responses by id, and drains streaming events to subscribed listeners.
 *
 * This is a separate process gateway client: it never imports Pi in-process.
 */
export class PiRpcClient {
  private process: ChildProcess | null = null;
  private stopReading: (() => void) | null = null;
  private readonly listeners: RpcEventListener[] = [];
  private readonly exitListeners: Array<() => void> = [];
  private readonly pending = new Map<string, PendingRequest>();
  private seq = 0;
  private stderr = "";
  private exitError: Error | null = null;
  /** One-shot guard: termination listeners fire at most once per start. */
  private terminationNotified = false;
  private readonly responseTimeoutMs = 30000;

  constructor(private readonly target: RpcSpawnTarget) {}

  async start(): Promise<void> {
    if (this.process) {
      throw new Error("RPC client already started");
    }
    this.exitError = null;
    this.stderr = "";
    this.terminationNotified = false;

    const child = spawn(this.target.command, this.target.args, {
      cwd: this.target.cwd,
      env: this.target.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;

    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });

    child.once("exit", (code, signal) => {
      if (this.process !== child) return;
      this.exitError = this.createExitError(code, signal);
      this.rejectPending(this.exitError);
      this.notifyTerminated();
    });

    child.once("error", (err) => {
      if (this.process !== child) return;
      const wrapped = new Error(`Agent process error: ${err.message}. Stderr: ${this.stderr}`);
      this.exitError = wrapped;
      this.rejectPending(wrapped);
      // Notify on the error path too, so classified waits and stream owners
      // always settle when the process terminates (ADR-0038 revision 3).
      this.notifyTerminated();
    });

    this.stopReading = createJsonlLineReader(child.stdout!, (line) => this.handleLine(line));

    // Resolve only once the child has actually spawned; surface spawn-time
    // failures (missing binary, etc.) as a start() rejection.
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(new Error(`Failed to spawn agent: ${err.message}`));
      child.once("error", onError);
      child.once("spawn", () => {
        child.off("error", onError);
        resolve();
      });
    });

    if (this.exitError) {
      throw this.exitError;
    }
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child) return;

    this.stopReading?.();
    this.stopReading = null;
    child.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    this.process = null;
    this.pending.clear();
  }

  onEvent(listener: RpcEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * One-shot termination notification: runs each subscribed listener at most
   * once per start, even when a post-spawn error is later followed by exit.
   */
  private notifyTerminated(): void {
    if (this.terminationNotified) return;
    this.terminationNotified = true;
    for (const listener of [...this.exitListeners]) {
      listener();
    }
  }

  /**
   * Subscribe to agent process termination. The listener fires AT MOST ONCE
   * per start: when the child exits (normally or via signal) OR when the
   * child errors post-spawn, whichever happens first, after stderr has been
   * collected. Useful for surfacing mid-stream crashes as errors to callers
   * that own a stream, and for classified waits that must settle on any
   * termination path without duplicate signals (ADR-0038 revision 3).
   */
  onExit(listener: () => void): () => void {
    this.exitListeners.push(listener);
    return () => {
      const index = this.exitListeners.indexOf(listener);
      if (index !== -1) {
        this.exitListeners.splice(index, 1);
      }
    };
  }

  getStderr(): string {
    return this.stderr;
  }

  /**
   * Send a prompt and resolve once Pi acknowledges it. The ack response arrives
   * after preflight; it is NOT completion. Streaming events continue to arrive
   * through `onEvent` until `agent_settled`. Use this (rather than `promptAndWait`)
   * when you need to forward events live instead of collecting them.
   */
  async prompt(message: string): Promise<void> {
    const response = await this.send({ type: "prompt", message });
    if (!response.success) {
      throw new Error(response.error || "prompt rejected");
    }
  }

  /**
   * Fetch the current session state: model, thinking level, streaming status,
   * message count, session id, and more. Drives the composer footer context
   * indicator in the web UI.
   */
  async getState(): Promise<RpcSessionState> {
    const response = await this.send({ type: "get_state" });
    if (!response.success) {
      throw new Error(response.error || "get_state failed");
    }
    return (response.data ?? {}) as RpcSessionState;
  }

  /**
   * Fetch token usage, cost, and current context-window usage for this exact
   * Pi session (`get_session_stats`, docs/rpc.md). The typed result preserves
   * Pi's two distinct context-usage states: `contextUsage` is ABSENT when no
   * model/context window is available, and PRESENT with `tokens: null` /
   * `percent: null` immediately after compaction. Rejects on command
   * rejection and on malformed payload shapes; never fabricates a state.
   */
  async getSessionStats(): Promise<RpcSessionStats> {
    const response = await this.send({ type: "get_session_stats" });
    if (!response.success) {
      throw new Error(response.error || "get_session_stats failed");
    }
    return parseSessionStats(response.data);
  }

  /**
   * List the models available to the current agent. Returns provider, id,
   * context window, and reasoning flag for each model.
   */
  async getAvailableModels(): Promise<RpcAvailableModels> {
    const response = await this.send({ type: "get_available_models" });
    if (!response.success) {
      throw new Error(response.error || "get_available_models failed");
    }
    return (response.data ?? { models: [] }) as RpcAvailableModels;
  }

  /**
   * Switch the active model. Pi acks with the new model object on success.
   * The change is also broadcast as a `model_changed` event to all event
   * listeners.
   */
  async setModel(provider: string, modelId: string): Promise<RpcModel> {
    const response = await this.send({ type: "set_model", provider, modelId });
    if (!response.success) {
      throw new Error(response.error || "set_model failed");
    }
    return (response.data ?? {}) as RpcModel;
  }

  /**
   * Set the thinking level. Pi acks with success. The change is also broadcast
   * as a `thinking_level_changed` event to all event listeners.
   */
  async setThinkingLevel(level: string): Promise<void> {
    const response = await this.send({ type: "set_thinking_level", level });
    if (!response.success) {
      throw new Error(response.error || "set_thinking_level failed");
    }
  }

  /**
   * Interrupt the current run with a steering message. The message is injected
   * mid-stream; Pi acks with success. Queue changes arrive as `queue_update`
   * events through `onEvent`.
   */
  async steer(message: string): Promise<void> {
    const response = await this.send({ type: "steer", message });
    if (!response.success) {
      throw new Error(response.error || "steer failed");
    }
  }

  /**
   * Queue a follow-up message to run after the current turn completes. Pi acks
   * with success. The message appears in `queue_update` events as a follow-up
   * entry.
   */
  async followUp(message: string): Promise<void> {
    const response = await this.send({ type: "follow_up", message });
    if (!response.success) {
      throw new Error(response.error || "follow_up failed");
    }
  }

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
  respondToUiRequest(id: string, response: ExtensionUiResponse): void {
    this.writeRaw({ type: "extension_ui_response", id, ...response });
  }

  /**
   * Abort the current turn mid-stream. Pi acks with success and emits
   * `agent_end`, which drains any active SSE streams so they close cleanly.
   * Use this to stop a runaway turn the steward wants to interrupt.
   */
  async abort(): Promise<void> {
    const response = await this.send({ type: "abort" });
    if (!response.success) {
      throw new Error(response.error || "abort failed");
    }
  }

  /**
   * Fetch the full transcript of the current session. The message shape is
   * provider-specific, so callers receive a loose array. Used to repopulate
   * the chat view after a browser reconnect.
   */
  async getMessages(): Promise<RpcMessages> {
    const response = await this.send({ type: "get_messages" });
    if (!response.success) {
      throw new Error(response.error || "get_messages failed");
    }
    const data = response.data as { messages?: unknown } | undefined;
    const messages = data?.messages;
    return { messages: Array.isArray(messages) ? (messages as Record<string, unknown>[]) : [] };
  }

  /**
   * Resume a past session by its on-disk path. Returns whether Pi cancelled
   * the resume (the session did not exist or the user declined). On a
   * successful resume, subsequent prompts and events belong to the resumed
   * session.
   */
  async switchSession(sessionPath: string): Promise<RpcSessionSwitch> {
    const response = await this.send({ type: "switch_session", sessionPath });
    if (!response.success) {
      throw new Error(response.error || "switch_session failed");
    }
    const data = response.data as { cancelled?: unknown } | undefined;
    return { cancelled: data?.cancelled === true };
  }

  /**
   * Start a fresh Pi session in this same RPC process, keeping the active
   * Piren agent and transport conversation. Returns whether a Pi extension
   * cancelled the switch. This is Pi's native control: no process restart,
   * no model prompt, and no parent-session tracking.
   */
  async newSession(): Promise<RpcNewSession> {
    const response = await this.send({ type: "new_session" });
    if (!response.success) {
      throw new Error(response.error || "new_session failed");
    }
    const data = response.data as { cancelled?: unknown } | undefined;
    return { cancelled: data?.cancelled === true };
  }

  /**
   * Request Pi's native manual compaction of the current session. This does
   * not synthesize a model prompt and does not change automatic-compaction
   * policy. The returned contract is minimal on purpose: raw summary and
   * transcript data stay inside Pi.
   */
  async compact(): Promise<RpcCompaction> {
    const response = await this.send({ type: "compact" });
    if (!response.success) {
      throw new Error(response.error || "compact failed");
    }
    const data = response.data as { tokensBefore?: unknown; estimatedTokensAfter?: unknown } | undefined;
    return {
      tokensBefore: typeof data?.tokensBefore === "number" ? data.tokensBefore : null,
      estimatedTokensAfter: typeof data?.estimatedTokensAfter === "number" ? data.estimatedTokensAfter : null,
    };
  }

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
  async promptAndWait(message: string, timeoutMs = 30000): Promise<RpcEvent[]> {
    return new Promise<RpcEvent[]>((resolve, reject) => {
      const events: RpcEvent[] = [];
      let settled = false;

      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        action();
      };

      const timer = setTimeout(
        () => finish(() => reject(new Error(`Timed out waiting for agent_settled. Stderr: ${this.stderr}`))),
        timeoutMs,
      );

      const unsubscribe = this.onEvent((event) => {
        events.push(event);
        if (event.type === "agent_settled") {
          finish(() => {
            clearTimeout(timer);
            unsubscribe();
            resolve(events);
          });
        }
      });

      // Send after subscribing so we do not miss agent_start or early deltas.
      this.send({ type: "prompt", message }).catch((err) => {
        finish(() => {
          clearTimeout(timer);
          unsubscribe();
          reject(err);
        });
      });
    });
  }

  private handleLine(line: string): void {
    let parsed: { type?: unknown; id?: unknown; [key: string]: unknown };
    try {
      parsed = JSON.parse(line);
    } catch {
      // Ignore non-JSON lines, mirroring a tolerant reader.
      return;
    }

    if (isRecord(parsed) && parsed.type === "response" && typeof parsed.id === "string") {
      const pending = this.pending.get(parsed.id);
      if (pending) {
        this.pending.delete(parsed.id);
        pending.resolve(parsed as unknown as RpcResponseLine);
        return;
      }
    }

    if (isRecord(parsed) && typeof parsed.type === "string") {
      const event = parsed as unknown as RpcEvent;
      for (const listener of [...this.listeners]) {
        listener(event);
      }
    }
  }

  /**
   * Write a JSONL line to Pi stdin without pairing it with an ack response.
   * Used for `extension_ui_response`, which Pi resolves internally without
   * sending a `response` line back. Using `send()` for these would time out.
   */
  private writeRaw(command: Record<string, unknown>): void {
    const child = this.process;
    const stdin = child?.stdin;
    if (!child || !stdin) {
      throw new Error("RPC client not started");
    }
    if (this.exitError) {
      throw this.exitError;
    }
    stdin.write(serializeJsonLine(command));
  }

  private async send(command: { type: string } & Record<string, unknown>): Promise<RpcResponseLine> {
    const child = this.process;
    const stdin = child?.stdin;
    if (!child || !stdin) {
      throw new Error("RPC client not started");
    }
    if (this.exitError) {
      throw this.exitError;
    }

    const id = `req_${++this.seq}`;

    return new Promise<RpcResponseLine>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for response to ${command.type}. Stderr: ${this.stderr}`));
      }, this.responseTimeoutMs);

      this.pending.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      try {
        stdin.write(serializeJsonLine({ ...command, id }));
      } catch (err) {
        const writeError = err instanceof Error ? err : new Error(String(err));
        const pending = this.pending.get(id);
        this.pending.delete(id);
        clearTimeout(timer);
        pending?.reject(writeError);
      }
    });
  }

  private createExitError(code: number | null, signal: NodeJS.Signals | null): Error {
    return new Error(`Agent process exited (code=${code} signal=${signal}). Stderr: ${this.stderr}`);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
