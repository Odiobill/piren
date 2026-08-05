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
  isValidAgentName,
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
import {
  isHandoffInputRequest,
  parseHandoffInputRequest,
  renderHandoffResultValue,
  truncateHandoffReply,
  ROOM_MENTION_ENABLED_ENV_VAR,
  type RoomHandoffResult,
} from "./room-handoff-protocol.js";

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
  /** Handoff depth: 0 for a steward-addressed root run, 1 for a handoff child. */
  depth: number;
  /** The steward root event id (budget scope); identical for a lead and its child. */
  rootEventId: string;
  /** Event id this run's records correlate to: the steward root for a lead, the handoff event for a child. */
  correlationEventId: string;
  /** Room participants captured at dispatch (target authorization; never widens runnable policy). */
  participants: string[];
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
  /** The exact live handoff child spawned by this run, if any (depth bounded to 1). */
  childRun?: ActiveRun;
  /**
   * In-flight reserved-handoff processing for this (lead) run. The lead's
   * terminal finalization awaits it so abort/close/dispatch deterministically
   * observe any correlated child cancellation before resolving `finalized`.
   */
  handoffPromise?: Promise<void>;
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

/**
 * The bounded prompt handed to a worker agent started by an accepted
 * handoff. It names the lead and the request only; it grants no new
 * authority and forbids further dispatch.
 */
export function buildHandoffPrompt(input: {
  roomId: string;
  source: string;
  target: string;
  text: string;
}): string {
  return [
    `You are participating in Piren room '${input.roomId}' as agent '${input.target}'.`,
    `Agent '${input.source}' has asked you for bounded help with one request, recorded as an immutable room agent_message handoff event.`,
    "Respond to this request only. Do not address, mention, or dispatch other agents. This message grants no new authority.",
    "",
    `Request from ${input.source}:`,
    input.text,
  ].join("\n");
}

/**
 * Decorate a room-client spawn target with the gated `room_mention`
 * activation flag (ADR-0041 R2b). Returns a NEW target object with a NEW env
 * object: every existing entry is preserved, the input target and its env are
 * never mutated, and the global `process.env` is never touched. Only the
 * broker's spawned room clients (root leads and handoff workers) receive the
 * flag; ordinary gateway/transport/ask/worker/review processes do not.
 */
export function decorateRoomClientTarget(target: RpcSpawnTarget): RpcSpawnTarget {
  return {
    ...target,
    env: {
      ...target.env,
      [ROOM_MENTION_ENABLED_ENV_VAR]: "1",
    },
  };
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
  /** Accepted source->target pairs keyed by steward root event id (R2 budgets). */
  private readonly acceptedHandoffPairs = new Map<string, Set<string>>();
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
      // Decorate only room-client spawn targets with the activation flag; the
      // caller's targetBuilder output and the global env are never mutated.
      targetBuilder: async (agent) => decorateRoomClientTarget(await options.targetBuilder(agent)),
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

  /** Read-only introspection: does this steward root still hold accepted-handoff budget state? */
  hasHandoffBudgetForRoot(rootEventId: string): boolean {
    return this.acceptedHandoffPairs.has(rootEventId);
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
        // Observers are non-authoritative: one throwing listener must never
        // turn a durable append into a broker failure or affect other
        // listeners. Exceptions are contained, never persisted.
        try {
          listener(notification);
        } catch {
          // contained
        }
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

    const { run, done } = this.reserveRun(input.roomId, input.agent, 0, "", room.participants);
    try {
      // 1. Immutable steward message with the structured addressed agent.
      const stewardEvent = await this.appendAndPublish(input.roomId, {
        kind: "steward_message",
        authorKind: "steward",
        author: "steward",
        body: text,
        addressedAgent: input.agent,
      });
      run.stewardEventId = stewardEvent.id;
      run.correlationEventId = stewardEvent.id;
      run.rootEventId = stewardEvent.id;

      // Cancellation boundary 1: close/abort won while the steward event was
      // being written. Record one cancellation; never build/start a session
      // or write run_started.
      if (run.settled) {
        return await this.finalizeCancelledDuringInit(run);
      }

      return await this.executeRoomRun(
        run,
        buildRoomMentionPrompt({ roomId: input.roomId, agent: input.agent, text }),
        done,
      );
    } finally {
      // Await any in-flight reserved handoff so abort/close/dispatch
      // deterministically observe a correlated child cancellation before this
      // root's `finalized` resolves. A lead that never handed off has no
      // promise; awaiting undefined resolves immediately. processHandoff is
      // non-throwing, but guard defensively so a rejection cannot escape the
      // finally and leak the reservation.
      if (run.handoffPromise !== undefined) {
        await run.handoffPromise.catch(() => {});
      }
      this.activeRuns.delete(run.key);
      // Budget is active-root state only: once this root reaches terminal
      // finalization it must not grow forever across completed roots.
      this.acceptedHandoffPairs.delete(run.rootEventId);
      run.resolveFinalized();
    }
  }

  /**
   * Race-safe in-process reservation: check-and-set is synchronous, before
   * the first event or client side effect. No implicit queue. Shared by the
   * steward-rooted lead run (depth 0) and an accepted handoff child (depth 1).
   */
  private reserveRun(
    roomId: string,
    agent: string,
    depth: number,
    rootEventId: string,
    participants: string[],
  ): { run: ActiveRun; done: Promise<void> } {
    const key = `${roomId}:${agent}`;
    if (this.activeRuns.has(key)) {
      throw new Error(`A run is already active for room '${roomId}' and agent '${agent}'.`);
    }
    let resolveDone!: () => void;
    let resolveFinalized!: () => void;
    const finalized = new Promise<void>((resolve) => {
      resolveFinalized = resolve;
    });
    const run: ActiveRun = {
      key,
      roomId,
      agent,
      depth,
      rootEventId,
      correlationEventId: "",
      participants,
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
    return { run, done };
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

  /**
   * Shared isolated room-run execution (session start -> run_started -> wire ->
   * prompt -> await terminal -> finalize). Used by both the steward-rooted
   * lead and an accepted handoff child; the correlation root and prompt are
   * supplied by the caller. Preserves the R1 cancellation barriers.
   */
  private async executeRoomRun(run: ActiveRun, prompt: string, done: Promise<void>): Promise<RoomDispatchOutcome> {
    // Start the isolated room × agent session.
    let session;
    let startupFailed = false;
    try {
      session = await this.sessions.getSession("room", run.key, run.agent);
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
      return await this.finalizeCancelledDuringInit(run);
    }

    if (startupFailed || session === undefined) {
      // Cancellation did NOT win and the client never reached run_started:
      // this is the only launch_failure path (ADR-0038 boundary).
      const terminal = await this.appendAndPublish(run.roomId, {
        kind: "run_finished",
        authorKind: "system",
        author: "system",
        body: "The run could not be started.",
        runStatus: "failed",
        failureKind: "launch_failure",
        correlationId: run.correlationEventId,
      });
      return {
        status: "failed",
        roomId: run.roomId,
        agent: run.agent,
        stewardEventId: run.correlationEventId,
        terminalEventId: terminal.id,
        failureKind: "launch_failure",
      };
    }
    run.client = session.client;

    // 2. run_started after the isolated client/session started.
    await this.appendAndPublish(run.roomId, {
      kind: "run_started",
      authorKind: "system",
      author: "system",
      body: `Run started for agent '${run.agent}'.`,
      runStatus: "running",
      correlationId: run.correlationEventId,
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
        await run.client.prompt(prompt);
      } catch {
        // ADR-0038 boundary: the prompt was handed to Pi after run_started, so
        // the broker cannot infer whether side effects occurred. Classified by
        // control-flow position only, never by error text.
        this.settle(run, "ambiguous");
      }
    }

    await done;
    return await this.finalizeRun(run);
  }

  /**
   * Synchronous accept gate for a reserved handoff control request. Parse and
   * authorize the bounded request; a malformed or rejected request is answered
   * with a bounded rejection and performs no dispatch, no queued work, and no
   * retry — and CRUCIALLY never touches `run.handoffPromise`. Only an ACCEPTED
   * handoff records the budget, reserves the exact depth-1 child target
   * synchronously, binds it to the source, and assigns `run.handoffPromise` to
   * the actual in-flight async work, so a later rejected request can never
   * overwrite the accepted handoff's finalization dependency.
   */
  private startHandoffIfAccepted(sourceRun: ActiveRun, event: RpcEvent): void {
    const requestId = event.id as string;
    const parsed = parseHandoffInputRequest(event);
    if (!parsed.ok) {
      this.respondToHandoffInput(sourceRun, requestId, { status: "rejected", reason: parsed.reason });
      return;
    }
    const auth = this.evaluateHandoffAuthorization(sourceRun, parsed.to);
    if (!auth.ok) {
      this.respondToHandoffInput(sourceRun, requestId, { status: "rejected", reason: auth.reason });
      return;
    }
    // Accept: record the budget AND reserve the exact depth-1 child target
    // synchronously BEFORE any awaited H append. The reservation makes the
    // target occupied immediately, so a concurrent mention for the same target
    // is rejected at its own reservation and can never interleave between an
    // accepted H and the child reservation (no orphan H). Only now does the
    // accepted handoff become the root's finalization dependency.
    this.recordHandoffAcceptance(sourceRun.rootEventId, sourceRun.agent, parsed.to);
    const { run: childRun, done: childDone } = this.reserveRun(
      sourceRun.roomId,
      parsed.to,
      1,
      sourceRun.rootEventId,
      sourceRun.participants,
    );
    sourceRun.childRun = childRun;
    sourceRun.handoffPromise = this.runAcceptedHandoff(sourceRun, childRun, childDone, parsed, requestId);
  }

  /**
   * The async body of an ACCEPTED handoff. Fully contained: it NEVER rejects,
   * so `run.handoffPromise` always resolves and the lead is always answered
   * (or skipped when already settled). Appends the immutable agent_message
   * handoff H, binds the child correlation, executes exactly one isolated
   * child run, and answers the same Pi request id with a bounded result.
   */
  private async runAcceptedHandoff(
    sourceRun: ActiveRun,
    childRun: ActiveRun,
    childDone: Promise<void>,
    parsed: { version: number; to: string; text: string },
    requestId: string,
  ): Promise<void> {
    // H: immutable agent_message handoff (author: lead, addressed: worker,
    // correlation: the steward root S).
    let handoffEvent: AppendRoomEventResult;
    try {
      handoffEvent = await this.appendAndPublish(sourceRun.roomId, {
        kind: "agent_message",
        authorKind: "agent",
        author: sourceRun.agent,
        body: parsed.text,
        addressedAgent: parsed.to,
        correlationId: sourceRun.rootEventId,
      });
    } catch {
      // H append failed: release ONLY the pre-reserved child/key/link cleanly.
      // Create no terminal for a nonexistent H, keep no leaked active key or
      // session, and never retry.
      this.releasePreReservedChild(sourceRun, childRun);
      if (!sourceRun.settled) {
        this.respondToHandoffInput(sourceRun, requestId, {
          status: "failed",
          reason: "handoff dispatch failed",
          failureKind: "ambiguous",
        });
      }
      return;
    }
    // Bind the child correlation once H exists.
    childRun.correlationEventId = handoffEvent.id;
    childRun.stewardEventId = handoffEvent.id;

    // Source settled while H was appended (the settle cascade already marked
    // the child settled): write exactly one child run_cancelled correlated to
    // H, with no session start and no prompt. Never a launch_failure: the
    // child never attempted to start.
    if (sourceRun.settled) {
      await this.finalizeCancelledDuringInit(childRun).catch(() => {});
      this.releasePreReservedChild(sourceRun, childRun);
      return;
    }

    // Execute the pre-reserved child. Contain every post-H execution exception
    // so the lead is answered and no session/key leaks.
    const { outcome, reply } = await this.executeHandoffChild(sourceRun, childRun, childDone, parsed.to, parsed.text);
    if (!sourceRun.settled) {
      this.respondToHandoffInput(sourceRun, requestId, this.outcomeToHandoffResult(outcome, reply, parsed.to));
    }
  }

  /**
   * Release a child that was pre-reserved but never executed (H append failed
   * or the source settled before start): clear the source link, drop the
   * active-key reservation, and resolve its finalization. No terminal event
   * is written here; callers write the correlated cancellation when H exists.
   */
  private releasePreReservedChild(sourceRun: ActiveRun, childRun: ActiveRun): void {
    if (sourceRun.childRun === childRun) {
      delete sourceRun.childRun;
    }
    this.activeRuns.delete(childRun.key);
    childRun.resolveFinalized();
  }

  /**
   * Strict fail-closed handoff authorization with deterministic non-secret
   * reasons. Repeat-pair is checked before one-per-root so each budget is
   * independently observable.
   */
  private evaluateHandoffAuthorization(sourceRun: ActiveRun, target: string): { ok: true } | { ok: false; reason: string } {
    if (sourceRun.depth !== 0) {
      return { ok: false, reason: "only a steward-addressed lead may hand off (depth limit reached)" };
    }
    if (!isValidAgentName(target)) {
      return { ok: false, reason: "handoff target is not a valid agent name" };
    }
    if (target === sourceRun.agent) {
      return { ok: false, reason: "an agent cannot hand off to itself" };
    }
    if (!this.runnableAgents.includes(target)) {
      return { ok: false, reason: `agent '${target}' is not in the runnable set` };
    }
    if (!sourceRun.participants.includes(target)) {
      return { ok: false, reason: `agent '${target}' is not a participant of room '${sourceRun.roomId}'` };
    }
    const accepted = this.acceptedHandoffPairs.get(sourceRun.rootEventId);
    if (accepted !== undefined && accepted.has(`${sourceRun.agent}->${target}`)) {
      return { ok: false, reason: "this source-target pair has already accepted a handoff for this steward root" };
    }
    if (accepted !== undefined && accepted.size >= 1) {
      return { ok: false, reason: "this steward root has already accepted one agent handoff" };
    }
    if (this.activeRuns.has(`${sourceRun.roomId}:${target}`)) {
      return { ok: false, reason: `a run is already active for room '${sourceRun.roomId}' and agent '${target}'` };
    }
    return { ok: true };
  }

  private recordHandoffAcceptance(rootEventId: string, source: string, target: string): void {
    let set = this.acceptedHandoffPairs.get(rootEventId);
    if (set === undefined) {
      set = new Set();
      this.acceptedHandoffPairs.set(rootEventId, set);
    }
    set.add(`${source}->${target}`);
  }

  /**
   * Execute the pre-reserved depth-1 handoff child (already bound to the
   * source and correlated to H). Reuses the shared room-run execution; its
   * terminal outcome and reply text are returned to the caller. The
   * source-child link and active key are cleared exactly once. EVERY post-H
   * execution exception is contained here: the materialized exact child
   * session is stopped/forgotten so it cannot be reused as an untracked
   * session, a best-effort correlated terminal is written when writable, and
   * a bounded failed/ambiguous outcome is returned so the lead is always
   * answered. This method never throws; no orphan record, no retry, and the
   * launch-failure boundary (session start failure) is preserved.
   */
  private async executeHandoffChild(
    sourceRun: ActiveRun,
    childRun: ActiveRun,
    childDone: Promise<void>,
    target: string,
    text: string,
  ): Promise<{ outcome: RoomDispatchOutcome; reply: string }> {
    try {
      const outcome = await this.executeRoomRun(
        childRun,
        buildHandoffPrompt({ roomId: sourceRun.roomId, source: sourceRun.agent, target, text }),
        childDone,
      );
      const reply = extractAssistantText(childRun.events).trim();
      return { outcome, reply };
    } catch {
      await this.containFailedHandoffChild(childRun);
      return {
        outcome: {
          status: "failed",
          roomId: childRun.roomId,
          agent: childRun.agent,
          stewardEventId: childRun.correlationEventId,
          terminalEventId: childRun.terminalEventId ?? "",
          failureKind: "ambiguous",
        },
        reply: "",
      };
    } finally {
      this.releasePreReservedChild(sourceRun, childRun);
    }
  }

  /**
   * Contain a child that threw during post-H execution (for example a child
   * run_started append failure after the session was constructed): stop and
   * forget the exact materialized session so it cannot be reused, settle the
   * child, and write a best-effort correlated run_finished(ambiguous) when
   * writable. Never retries and never throws.
   */
  private async containFailedHandoffChild(childRun: ActiveRun): Promise<void> {
    if (childRun.client !== undefined) {
      await childRun.client.stop().catch(() => {});
      this.sessions.forgetSession("room", childRun.key, childRun.client);
    }
    // Settle so any later cascade/listener is inert; resolves the child wait.
    this.settle(childRun, "cancel");
    try {
      const terminal = await this.appendAndPublish(childRun.roomId, {
        kind: "run_finished",
        authorKind: "system",
        author: "system",
        body: "The run ended unexpectedly.",
        runStatus: "failed",
        failureKind: "ambiguous",
        correlationId: childRun.correlationEventId,
      });
      childRun.terminalEventId = terminal.id;
    } catch {
      // best-effort: the terminal could not be written; do not retry.
    }
  }

  /** Map a child terminal outcome to the bounded non-secret handoff result. */
  private outcomeToHandoffResult(outcome: RoomDispatchOutcome, reply: string, target: string): RoomHandoffResult {
    switch (outcome.status) {
      case "completed":
        // Bound the control-plane reply; the immutable worker evidence keeps
        // the full text, only the result is deterministically truncated.
        return { status: "ok", reply: truncateHandoffReply(reply) };
      case "failed":
        return { status: "failed", reason: `worker '${target}' run failed`, failureKind: outcome.failureKind };
      case "timed_out":
        return { status: "timed_out" };
      case "cancelled":
        return { status: "cancelled" };
    }
  }

  /** Answer the lead's waiting input request id with a structured value. */
  private respondToHandoffInput(sourceRun: ActiveRun, requestId: string, result: RoomHandoffResult): void {
    if (sourceRun.client === undefined) return;
    try {
      sourceRun.client.respondToUiRequest(requestId, { value: renderHandoffResultValue(result) });
    } catch {
      // contained: a dead client cannot receive the response.
    }
  }

  private handleClientEvent(run: ActiveRun, event: RpcEvent): void {
    if (run.settled) return;
    run.events.push(event);
    if (event.type === "extension_ui_request" && typeof event.id === "string") {
      // R2a: a reserved handoff control request is consumed only from this
      // exact active run, BEFORE generic input approval forwarding. It never
      // enters the approval registry or notifications, and is never
      // answerable through the public room approval path.
      if (isHandoffInputRequest(event)) {
        this.startHandoffIfAccepted(run, event);
        return;
      }
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
          // Same containment as room events: a throwing observer must not
          // escape the Pi event handler or affect the run lifecycle.
          try {
            listener(notification);
          } catch {
            // contained
          }
        }
      }
      return;
    }
    if (event.type === "agent_end") {
      // TB0/G1: agent_end alone is never terminal (Pi may still auto-retry,
      // retry compaction, or drain queued follow-ups). Only agent_settled
      // proves the run is fully settled.
      return;
    }
    if (event.type === "agent_settled") {
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
    // R2a: a source abort/timeout/exit/close cancels ONLY its exact live
    // handoff child. Depth is bounded to 1, so no recursive cascade beyond
    // one level; a child can never have its own accepted child.
    if (run.childRun !== undefined && !run.childRun.settled) {
      this.settle(run.childRun, "cancel");
    }
    run.resolveDone();
  }

  /**
   * Terminal cancellation for a run that never became active (close/abort
   * won during initialization): exactly one correlated run_cancelled, with
   * no session usage, no run_started, and no client access.
   */
  private async finalizeCancelledDuringInit(run: ActiveRun): Promise<RoomDispatchOutcome> {
    const terminal = await this.appendAndPublish(run.roomId, {
      kind: "run_cancelled",
      authorKind: "system",
      author: "system",
      body: "Run cancelled by the steward.",
      runStatus: "cancelled",
      correlationId: run.correlationEventId,
    });
    run.terminalEventId = terminal.id;
    return {
      status: "cancelled",
      roomId: run.roomId,
      agent: run.agent,
      stewardEventId: run.correlationEventId,
      terminalEventId: terminal.id,
    };
  }

  private async finalizeRun(run: ActiveRun): Promise<RoomDispatchOutcome> {
    // settle() always assigns a kind before resolving the wait; the fallback
    // is defensive only.
    const kind = run.settleKind ?? "cancel";
    const correlationId = run.correlationEventId;

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
        const agentEvent = await this.appendAndPublish(run.roomId, {
          kind: "agent_message",
          authorKind: "agent",
          author: run.agent,
          body: text,
          correlationId,
        });
        agentEventId = agentEvent.id;
      }
      const terminal = await this.appendAndPublish(run.roomId, {
        kind: "run_finished",
        authorKind: "system",
        author: "system",
        body: "Run completed.",
        runStatus: "completed",
        correlationId,
      });
      run.terminalEventId = terminal.id;
      const outcome: RoomDispatchOutcome = {
        status: "completed",
        roomId: run.roomId,
        agent: run.agent,
        stewardEventId: correlationId,
        terminalEventId: terminal.id,
      };
      if (agentEventId !== undefined) {
        (outcome as { agentEventId?: string }).agentEventId = agentEventId;
      }
      return outcome;
    }

    if (kind === "ambiguous") {
      const terminal = await this.appendAndPublish(run.roomId, {
        kind: "run_finished",
        authorKind: "system",
        author: "system",
        body: "The run ended unexpectedly.",
        runStatus: "failed",
        failureKind: "ambiguous",
        correlationId,
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
        roomId: run.roomId,
        agent: run.agent,
        stewardEventId: correlationId,
        terminalEventId: terminal.id,
        failureKind: "ambiguous",
      };
    }

    if (kind === "timeout") {
      const terminal = await this.appendAndPublish(run.roomId, {
        kind: "run_finished",
        authorKind: "system",
        author: "system",
        body: "Run timed out.",
        runStatus: "timed_out",
        correlationId,
      });
      run.terminalEventId = terminal.id;
      return {
        status: "timed_out",
        roomId: run.roomId,
        agent: run.agent,
        stewardEventId: correlationId,
        terminalEventId: terminal.id,
      };
    }

    // cancel
    const terminal = await this.appendAndPublish(run.roomId, {
      kind: "run_cancelled",
      authorKind: "system",
      author: "system",
      body: "Run cancelled by the steward.",
      runStatus: "cancelled",
      correlationId,
    });
    run.terminalEventId = terminal.id;
    return {
      status: "cancelled",
      roomId: run.roomId,
      agent: run.agent,
      stewardEventId: correlationId,
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
