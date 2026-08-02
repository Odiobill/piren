import { TransportSessionManager, type TransportRpcClient } from "./transport-session-manager.js";
import {
  PiRpcClient,
  extractAssistantText,
  type ExtensionUiResponse,
  type RpcEvent,
  type RpcSpawnTarget,
} from "./gateway-rpc.js";
import type { RpcTargetBuilder } from "./gateway-http.js";
import {
  appendRoomEvent,
  readRoom,
  type AppendRoomEventOptions,
  type AppendRoomEventResult,
  type ReadRoomOptions,
  type RoomAuthorKind,
  type RoomEventKind,
  type RoomRecord,
  type RoomRunStatus,
  type RoomWriteIo,
} from "./rooms.js";
import type { RoomRunFailureKind } from "./rooms.js";

/**
 * Isolated room-run broker core (ADR-0041 R1b).
 *
 * Processes one explicit steward-to-one-runnable-participant room mention
 * using an isolated `room × agent` Pi RPC client owned by a dedicated
 * TransportSessionManager (composite conversation id `<roomId>:<agent>`,
 * never the global GatewayServer client). Every accepted dispatch appends
 * only immutable room events; every rejection happens before any event or
 * client side effect. Approvals are in-memory, scoped by room + agent +
 * request id + active run, and are never auto-approved.
 *
 * No HTTP/SSE, no polling, no retries, no offline catch-up, no hidden task
 * creation. Terminal failures record stable non-secret bodies only.
 */

/**
 * The narrow client surface the broker needs. PiRpcClient satisfies this
 * structurally; tests inject fakes via clientFactory.
 */
export interface RoomRpcClient extends TransportRpcClient {
  onEvent(listener: (event: RpcEvent) => void): () => void;
  onExit(listener: () => void): () => void;
  prompt(message: string): Promise<void>;
  respondToUiRequest(id: string, response: ExtensionUiResponse): void;
}

export interface RoomBrokerTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RoomBrokerOptions {
  vaultRoot: string;
  runnableAgents: string[];
  targetBuilder: RpcTargetBuilder;
  clientFactory?: ((target: RpcSpawnTarget) => RoomRpcClient) | undefined;
  now?: () => Date;
  nonce?: () => string;
  timers?: RoomBrokerTimers | undefined;
  runTimeoutMs?: number | undefined;
  /** Injected room-write seam for deterministic suspension tests. */
  io?: RoomWriteIo | undefined;
  /** Injected room reader for deterministic validation-suspension tests. */
  roomReader?: ((options: ReadRoomOptions) => Promise<RoomRecord>) | undefined;
}

export interface RoomMentionInput {
  roomId: string;
  agent: string;
  text: string;
}

export type RoomDispatchOutcome =
  | { status: "completed"; roomId: string; agent: string; stewardEventId: string; agentEventId?: string; terminalEventId: string }
  | { status: "failed"; roomId: string; agent: string; stewardEventId: string; terminalEventId: string; failureKind: RoomRunFailureKind }
  | { status: "timed_out"; roomId: string; agent: string; stewardEventId: string; terminalEventId: string }
  | { status: "cancelled"; roomId: string; agent: string; stewardEventId: string; terminalEventId: string };

export type RoomAbortOutcome =
  | { status: "cancelled"; roomId: string; agent: string; terminalEventId: string }
  | { status: "no-active-run"; roomId: string; agent: string };

export interface RoomApprovalInput {
  roomId: string;
  agent: string;
  requestId: string;
  response: ExtensionUiResponse;
}

export const DEFAULT_ROOM_RUN_TIMEOUT_MS = 120_000;

/** Structured committed room event data published AFTER the durable append. */
export interface RoomEventNotification {
  roomId: string;
  id: string;
  kind: RoomEventKind;
  authorKind: RoomAuthorKind;
  author: string;
  created: string;
  body: string;
  addressedAgent?: string;
  correlationId?: string;
  runStatus?: RoomRunStatus;
  failureKind?: RoomRunFailureKind;
}

/** Bounded pending-approval notification for a room-scoped listener. */
export interface RoomApprovalNotification {
  roomId: string;
  agent: string;
  requestId: string;
  method: string;
  /** Bounded Pi request payload (everything except type/id). */
  payload: Record<string, unknown>;
}

/** Only these Pi UI request methods are approvable room approvals. */
const APPROVABLE_METHODS = new Set(["confirm", "select", "input"]);

type RunSettleKind = "completed" | "ambiguous" | "timeout" | "cancel";

interface ActiveRun {
  key: string;
  roomId: string;
  agent: string;
  client: RoomRpcClient | undefined;
  stewardEventId: string;
  settled: boolean;
  settleKind?: RunSettleKind;
  /** True only when the settle was caused by the client's process exiting. */
  clientExited?: boolean;
  terminalEventId?: string;
  events: RpcEvent[];
  timeoutHandle?: unknown;
  unsubscribeEvents?: () => void;
  unsubscribeExit?: () => void;
  resolveDone: () => void;
  resolveFinalized: () => void;
  finalized: Promise<void>;
}

interface PendingApproval {
  roomId: string;
  agent: string;
  requestId: string;
  run: ActiveRun;
}

function defaultTimers(): RoomBrokerTimers {
  return {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
  };
}

/**
 * The bounded prompt handed to Pi for one room mention. It makes the room
 * context explicit without granting new authority and never asks the agent
 * to address another agent. Rendered `@text` is never parsed.
 */
export function buildRoomMentionPrompt(input: { roomId: string; agent: string; text: string }): string {
  return [
    `You are participating in Piren room '${input.roomId}' as agent '${input.agent}'.`,
    "The steward has explicitly addressed you with one bounded request, recorded as an immutable room steward_message event.",
    "Respond to this request only. Do not address, mention, or dispatch other agents. This message grants no new authority.",
    "",
    "Steward request:",
    input.text,
  ].join("\n");
}

export class RoomBroker {
  private readonly vaultRoot: string;
  private readonly runnableAgents: string[];
  private readonly sessions: TransportSessionManager<RoomRpcClient>;
  private readonly now: () => Date;
  private readonly nonce: (() => string) | undefined;
  private readonly timers: RoomBrokerTimers;
  private readonly runTimeoutMs: number;
  private readonly io: RoomWriteIo | undefined;
  private readonly roomReader: (options: ReadRoomOptions) => Promise<RoomRecord>;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly roomEventListeners = new Map<string, Set<(event: RoomEventNotification) => void>>();
  private readonly roomApprovalListeners = new Map<string, Set<(approval: RoomApprovalNotification) => void>>();
  private closed = false;

  constructor(options: RoomBrokerOptions) {
    this.vaultRoot = options.vaultRoot;
    this.runnableAgents = [...options.runnableAgents];
    this.now = options.now ?? (() => new Date());
    this.nonce = options.nonce;
    this.timers = options.timers ?? defaultTimers();
    this.runTimeoutMs = options.runTimeoutMs ?? DEFAULT_ROOM_RUN_TIMEOUT_MS;
    this.io = options.io;
    this.roomReader = options.roomReader ?? readRoom;
    this.sessions = new TransportSessionManager<RoomRpcClient>({
      runnableAgents: this.runnableAgents,
      targetBuilder: options.targetBuilder,
      clientFactory: options.clientFactory,
      // The manager tracks last-used millis; the broker clock returns Dates.
      now: () => this.now().getTime(),
    });
  }

  hasActiveRun(roomId: string, agent: string): boolean {
    return this.activeRuns.has(`${roomId}:${agent}`);
  }

  hasPendingApproval(roomId: string, agent: string, requestId: string): boolean {
    return this.pendingApprovals.has(`${roomId}:${agent}:${requestId}`);
  }

  /**
   * Subscribe to committed events for exactly one room. Listeners receive
   * structured safe data only AFTER each immutable event file was appended;
   * the returned function unsubscribes cleanly.
   */
  onRoomEvent(roomId: string, listener: (event: RoomEventNotification) => void): () => void {
    let listeners = this.roomEventListeners.get(roomId);
    if (!listeners) {
      listeners = new Set();
      this.roomEventListeners.set(roomId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.roomEventListeners.delete(roomId);
      }
    };
  }

  /**
   * Subscribe to pending approval notifications for exactly one room.
   * Only confirm/select/input requests are forwarded, only after the broker
   * registered the exact active room-agent-request approval. Never
   * auto-approves and never persists approval payloads.
   */
  onRoomApproval(roomId: string, listener: (approval: RoomApprovalNotification) => void): () => void {
    let listeners = this.roomApprovalListeners.get(roomId);
    if (!listeners) {
      listeners = new Set();
      this.roomApprovalListeners.set(roomId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.roomApprovalListeners.delete(roomId);
      }
    };
  }

  /**
   * Append one immutable room event, then publish its structured safe data
   * to that room's listeners. Publication happens only after the durable
   * no-clobber append succeeded.
   */
  private async appendAndPublish(
    roomId: string,
    options: Omit<AppendRoomEventOptions, "vaultRoot" | "roomId" | "now" | "nonce" | "io">,
  ): Promise<AppendRoomEventResult> {
    const result = await appendRoomEvent({ ...this.appendBase(roomId), ...options });
    const notification: RoomEventNotification = {
      roomId,
      id: result.id,
      kind: options.kind,
      authorKind: options.authorKind,
      author: options.author,
      created: result.created,
      body: options.body,
    };
    if (options.addressedAgent !== undefined) notification.addressedAgent = options.addressedAgent;
    if (options.correlationId !== undefined) notification.correlationId = options.correlationId;
    if (options.runStatus !== undefined) notification.runStatus = options.runStatus;
    if (options.failureKind !== undefined) notification.failureKind = options.failureKind;
    const listeners = this.roomEventListeners.get(roomId);
    if (listeners) {
      for (const listener of [...listeners]) {
        listener(notification);
      }
    }
    return result;
  }

  async dispatchRoomMention(input: RoomMentionInput): Promise<RoomDispatchOutcome> {
    if (this.closed) {
      throw new Error("Room broker is closed.");
    }
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (text === "") {
      throw new Error("Room mention text is required.");
    }

    let room;
    try {
      room = await this.roomReader({ vaultRoot: this.vaultRoot, roomId: input.roomId });
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
        throw new Error(`Room not found: ${input.roomId}`);
      }
      throw error;
    }
    if (room.status !== "open") {
      throw new Error(`Room '${input.roomId}' is closed.`);
    }
    if (!room.participants.includes(input.agent)) {
      throw new Error(`Agent '${input.agent}' is not a participant of room '${input.roomId}'.`);
    }
    if (!this.runnableAgents.includes(input.agent)) {
      throw new Error(`Agent '${input.agent}' is not in the runnable set.`);
    }

    // Post-validation close boundary: close() may have run entirely while
    // validation was awaited (no reservation existed for it to settle).
    // This check and the reservation below are one synchronous block with no
    // await between them, so close() cannot interleave.
    if (this.closed) {
      throw new Error("Room broker is closed.");
    }

    // Race-safe in-process reservation: check-and-set is synchronous, before
    // the first event or client side effect. No implicit queue.
    const key = `${input.roomId}:${input.agent}`;
    if (this.activeRuns.has(key)) {
      throw new Error(`A run is already active for room '${input.roomId}' and agent '${input.agent}'.`);
    }
    let resolveDone!: () => void;
    let resolveFinalized!: () => void;
    const finalized = new Promise<void>((resolve) => {
      resolveFinalized = resolve;
    });
    const run: ActiveRun = {
      key,
      roomId: input.roomId,
      agent: input.agent,
      client: undefined,
      stewardEventId: "",
      settled: false,
      events: [],
      resolveDone: () => resolveDone(),
      resolveFinalized,
      finalized,
    };
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.activeRuns.set(key, run);

    try {
      return await this.runMention(run, input, text, done);
    } finally {
      this.activeRuns.delete(key);
      run.resolveFinalized();
    }
  }

  private appendBase(roomId: string): { vaultRoot: string; roomId: string; now: () => Date; nonce?: () => string; io?: RoomWriteIo } {
    const base: { vaultRoot: string; roomId: string; now: () => Date; nonce?: () => string; io?: RoomWriteIo } = {
      vaultRoot: this.vaultRoot,
      roomId,
      now: this.now,
    };
    // exactOptionalPropertyTypes: never assign explicit undefined optionals.
    if (this.nonce !== undefined) {
      base.nonce = this.nonce;
    }
    if (this.io !== undefined) {
      base.io = this.io;
    }
    return base;
  }

  private async runMention(
    run: ActiveRun,
    input: RoomMentionInput,
    text: string,
    done: Promise<void>,
  ): Promise<RoomDispatchOutcome> {
    // 1. Immutable steward message with the structured addressed agent.
    const stewardEvent = await this.appendAndPublish(input.roomId, {
      kind: "steward_message",
      authorKind: "steward",
      author: "steward",
      body: text,
      addressedAgent: input.agent,
    });
    run.stewardEventId = stewardEvent.id;

    // Cancellation boundary 1: close/abort won while the steward event was
    // being written. Record one cancellation; never build/start a session
    // or write run_started.
    if (run.settled) {
      return await this.finalizeCancelledDuringInit(run, input);
    }

    // Start the isolated room × agent session.
    let session;
    let startupFailed = false;
    try {
      session = await this.sessions.getSession("room", run.key, input.agent);
    } catch {
      startupFailed = true;
    }

    // Cancellation boundary 2: close/abort won while the session was
    // starting. Cancellation wins over any startup outcome: clean up only
    // the just-created exact session (when one materialized), never write
    // run_started, never record launch_failure.
    if (run.settled) {
      if (session !== undefined) {
        await session.client.stop().catch(() => {});
        this.sessions.forgetSession("room", run.key, session.client);
      }
      return await this.finalizeCancelledDuringInit(run, input);
    }

    if (startupFailed || session === undefined) {
      // Cancellation did NOT win and the client never reached run_started:
      // this is the only launch_failure path (ADR-0038 boundary).
      const terminal = await this.appendAndPublish(input.roomId, {
        kind: "run_finished",
        authorKind: "system",
        author: "system",
        body: "The run could not be started.",
        runStatus: "failed",
        failureKind: "launch_failure",
        correlationId: stewardEvent.id,
      });
      return {
        status: "failed",
        roomId: input.roomId,
        agent: input.agent,
        stewardEventId: stewardEvent.id,
        terminalEventId: terminal.id,
        failureKind: "launch_failure",
      };
    }
    run.client = session.client;

    // 2. run_started after the isolated client/session started.
    await this.appendAndPublish(input.roomId, {
      kind: "run_started",
      authorKind: "system",
      author: "system",
      body: `Run started for agent '${input.agent}'.`,
      runStatus: "running",
      correlationId: stewardEvent.id,
    });

    // Cancellation boundary 3: close/abort won while run_started was being
    // written. Skip wiring and prompt; the cancel finalization below aborts
    // the just-started client and records exactly one run_cancelled.
    if (!run.settled) {
      run.unsubscribeEvents = run.client.onEvent((event) => this.handleClientEvent(run, event));
      run.unsubscribeExit = run.client.onExit(() => {
        run.clientExited = true;
        this.settle(run, "ambiguous");
      });
      run.timeoutHandle = this.timers.setTimeout(() => this.settle(run, "timeout"), this.runTimeoutMs);

      try {
        await run.client.prompt(buildRoomMentionPrompt({ roomId: input.roomId, agent: input.agent, text }));
      } catch {
        // ADR-0038 boundary: the prompt was handed to Pi after run_started, so
        // the broker cannot infer whether side effects occurred. Classified by
        // control-flow position only, never by error text.
        this.settle(run, "ambiguous");
      }
    }

    await done;
    return await this.finalizeRun(run, input);
  }

  private handleClientEvent(run: ActiveRun, event: RpcEvent): void {
    if (run.settled) return;
    run.events.push(event);
    if (event.type === "extension_ui_request" && typeof event.id === "string") {
      const method = typeof event.method === "string" ? event.method : "";
      // Only approvable request kinds register or forward; other Pi UI
      // requests (notify, setStatus, ...) never become room approvals.
      if (!APPROVABLE_METHODS.has(method)) return;
      this.pendingApprovals.set(`${run.key}:${event.id}`, {
        roomId: run.roomId,
        agent: run.agent,
        requestId: event.id,
        run,
      });
      const { type: _type, id: _id, ...payload } = event;
      const notification: RoomApprovalNotification = {
        roomId: run.roomId,
        agent: run.agent,
        requestId: event.id,
        method,
        payload,
      };
      const listeners = this.roomApprovalListeners.get(run.roomId);
      if (listeners) {
        for (const listener of [...listeners]) {
          listener(notification);
        }
      }
      return;
    }
    if (event.type === "agent_end") {
      this.settle(run, "completed");
    }
  }

  private settle(run: ActiveRun, kind: RunSettleKind): void {
    if (run.settled) return;
    run.settled = true;
    run.settleKind = kind;
    if (run.timeoutHandle !== undefined) {
      this.timers.clearTimeout(run.timeoutHandle);
      run.timeoutHandle = undefined;
    }
    run.unsubscribeEvents?.();
    run.unsubscribeExit?.();
    for (const [approvalKey, approval] of [...this.pendingApprovals.entries()]) {
      if (approval.run === run) {
        this.pendingApprovals.delete(approvalKey);
      }
    }
    run.resolveDone();
  }

  /**
   * Terminal cancellation for a run that never became active (close/abort
   * won during initialization): exactly one correlated run_cancelled, with
   * no session usage, no run_started, and no client access.
   */
  private async finalizeCancelledDuringInit(run: ActiveRun, input: RoomMentionInput): Promise<RoomDispatchOutcome> {
    const terminal = await this.appendAndPublish(input.roomId, {
      kind: "run_cancelled",
      authorKind: "system",
      author: "system",
      body: "Run cancelled by the steward.",
      runStatus: "cancelled",
      correlationId: run.stewardEventId,
    });
    run.terminalEventId = terminal.id;
    return {
      status: "cancelled",
      roomId: input.roomId,
      agent: input.agent,
      stewardEventId: run.stewardEventId,
      terminalEventId: terminal.id,
    };
  }

  private async finalizeRun(run: ActiveRun, input: RoomMentionInput): Promise<RoomDispatchOutcome> {
    // settle() always assigns a kind before resolving the wait; the fallback
    // is defensive only.
    const kind = run.settleKind ?? "cancel";

    if (kind === "timeout" || kind === "cancel") {
      // Abort only the exact room-agent client. Stale agent_end emitted by
      // the abort is ignored: listeners were unsubscribed at settle time.
      if (run.client !== undefined) {
        await run.client.abort().catch(() => {});
      }
    }

    if (kind === "completed") {
      const text = extractAssistantText(run.events).trim();
      let agentEventId: string | undefined;
      if (text !== "") {
        const agentEvent = await this.appendAndPublish(input.roomId, {
          kind: "agent_message",
          authorKind: "agent",
          author: input.agent,
          body: text,
          correlationId: run.stewardEventId,
        });
        agentEventId = agentEvent.id;
      }
      const terminal = await this.appendAndPublish(input.roomId, {
        kind: "run_finished",
        authorKind: "system",
        author: "system",
        body: "Run completed.",
        runStatus: "completed",
        correlationId: run.stewardEventId,
      });
      run.terminalEventId = terminal.id;
      const outcome: RoomDispatchOutcome = {
        status: "completed",
        roomId: input.roomId,
        agent: input.agent,
        stewardEventId: run.stewardEventId,
        terminalEventId: terminal.id,
      };
      if (agentEventId !== undefined) {
        (outcome as { agentEventId?: string }).agentEventId = agentEventId;
      }
      return outcome;
    }

    if (kind === "ambiguous") {
      const terminal = await this.appendAndPublish(input.roomId, {
        kind: "run_finished",
        authorKind: "system",
        author: "system",
        body: "The run ended unexpectedly.",
        runStatus: "failed",
        failureKind: "ambiguous",
        correlationId: run.stewardEventId,
      });
      run.terminalEventId = terminal.id;
      if (run.clientExited === true) {
        // The cached client is dead: forget exactly this composite session
        // (without stopping it) so a later explicit mention builds a fresh
        // client. Never a retry of the failed run; unrelated sessions stay.
        this.sessions.forgetSession("room", run.key, run.client);
      }
      return {
        status: "failed",
        roomId: input.roomId,
        agent: input.agent,
        stewardEventId: run.stewardEventId,
        terminalEventId: terminal.id,
        failureKind: "ambiguous",
      };
    }

    if (kind === "timeout") {
      const terminal = await this.appendAndPublish(input.roomId, {
        kind: "run_finished",
        authorKind: "system",
        author: "system",
        body: "Run timed out.",
        runStatus: "timed_out",
        correlationId: run.stewardEventId,
      });
      run.terminalEventId = terminal.id;
      return {
        status: "timed_out",
        roomId: input.roomId,
        agent: input.agent,
        stewardEventId: run.stewardEventId,
        terminalEventId: terminal.id,
      };
    }

    // cancel
    const terminal = await this.appendAndPublish(input.roomId, {
      kind: "run_cancelled",
      authorKind: "system",
      author: "system",
      body: "Run cancelled by the steward.",
      runStatus: "cancelled",
      correlationId: run.stewardEventId,
    });
    run.terminalEventId = terminal.id;
    return {
      status: "cancelled",
      roomId: input.roomId,
      agent: input.agent,
      stewardEventId: run.stewardEventId,
      terminalEventId: terminal.id,
    };
  }

  /**
   * Respond to a pending approval on the exact room-agent client that raised
   * it. Unknown, stale, wrong-room, wrong-agent, or already-resolved
   * responses reject and write no room record. Never auto-approves.
   */
  respondToRoomApproval(input: RoomApprovalInput): void {
    const approvalKey = `${input.roomId}:${input.agent}:${input.requestId}`;
    const pending = this.pendingApprovals.get(approvalKey);
    if (!pending) {
      throw new Error(`Unknown room approval '${input.requestId}' for room '${input.roomId}' and agent '${input.agent}'.`);
    }
    if (pending.run.settled || pending.run.client === undefined || this.activeRuns.get(pending.run.key) !== pending.run) {
      this.pendingApprovals.delete(approvalKey);
      throw new Error(`Room approval '${input.requestId}' is stale.`);
    }
    pending.run.client.respondToUiRequest(input.requestId, input.response);
    this.pendingApprovals.delete(approvalKey);
  }

  /**
   * Abort the active run for exactly one room × agent key. The dispatch
   * finalization performs the client abort and appends the single
   * run_cancelled event; this method waits for that terminal record.
   */
  async abort(roomId: string, agent: string): Promise<RoomAbortOutcome> {
    const key = `${roomId}:${agent}`;
    const run = this.activeRuns.get(key);
    if (!run) {
      return { status: "no-active-run", roomId, agent };
    }
    this.settle(run, "cancel");
    await run.finalized;
    return { status: "cancelled", roomId, agent, terminalEventId: run.terminalEventId as string };
  }

  /**
   * Close the broker: cancel every active run exactly once with a durable
   * non-secret run_cancelled record, wait for all finalization writes, then
   * stop all room sessions. Stale agent_end events from shutdown append
   * nothing. Idempotent; a close with no active runs writes no records.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const finalizations: Promise<void>[] = [];
    for (const run of [...this.activeRuns.values()]) {
      this.settle(run, "cancel");
      finalizations.push(run.finalized);
    }
    this.pendingApprovals.clear();
    await Promise.all(finalizations);
    await this.sessions.closeAll();
  }
}
