import { type ChildProcess, spawn } from "node:child_process";
import { createJsonlLineReader, serializeJsonLine } from "./jsonl.js";

/**
 * Spawn target for the RPC client. In production this is produced by
 * `buildPiRunCommand({ rpcMode: true })` (npx pi --mode rpc ...). In tests it
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

type RpcEventListener = (event: RpcEvent) => void;

interface PendingRequest {
  resolve: (response: RpcResponseLine) => void;
  reject: (error: Error) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
  private readonly responseTimeoutMs = 30000;

  constructor(private readonly target: RpcSpawnTarget) {}

  async start(): Promise<void> {
    if (this.process) {
      throw new Error("RPC client already started");
    }
    this.exitError = null;
    this.stderr = "";

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
      for (const listener of [...this.exitListeners]) {
        listener();
      }
    });

    child.once("error", (err) => {
      if (this.process !== child) return;
      const wrapped = new Error(`Agent process error: ${err.message}. Stderr: ${this.stderr}`);
      this.exitError = wrapped;
      this.rejectPending(wrapped);
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
   * Subscribe to agent process exits. The listener fires once when the child
   * exits (normally or via signal), after stderr has been collected. Useful for
   * surfacing mid-stream crashes as errors to callers that own a stream.
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
   * through `onEvent` until `agent_end`. Use this (rather than `promptAndWait`)
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
   * Send a prompt and wait for the turn to finish, returning every event
   * streamed until `agent_end`. The prompt is async: the client subscribes for
   * events before sending so the first streaming events are never missed, and
   * completion is the `agent_end` event (not the prompt ack response).
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
        () => finish(() => reject(new Error(`Timed out waiting for agent_end. Stderr: ${this.stderr}`))),
        timeoutMs,
      );

      const unsubscribe = this.onEvent((event) => {
        events.push(event);
        if (event.type === "agent_end") {
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
