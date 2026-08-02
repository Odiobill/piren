import { TransportSessionManager, type TransportRpcClient } from "./transport-session-manager.js";
import {
  PiRpcClient,
  extractAssistantText,
  type ExtensionUiResponse,
  type RpcEvent,
  type RpcSpawnTarget,
} from "./gateway-rpc.js";
import type { RpcTargetBuilder } from "./gateway-http.js";
import { appendRoomEvent, readRoom } from "./rooms.js";
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
  | { status: "cancelled"; roomId: string; agent: string; stewardEventId: string; terminalEventId: string }
  | { status: "closed"; roomId: string; agent: string; stewardEventId: string };

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

type RunSettleKind = "completed" | "launch_failure" | "exit" | "timeout" | "cancel" | "closed";

interface ActiveRun {
  key: string;
  roomId: string;
  agent: string;
  client: RoomRpcClient;
  stewardEventId: string;
  settled: boolean;
  settleKind?: RunSettleKind;
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
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private closed = false;

  constructor(options: RoomBrokerOptions) {
    this.vaultRoot = options.vaultRoot;
    this.runnableAgents = [...options.runnableAgents];
    this.now = options.now ?? (() => new Date());
    this.nonce = options.nonce;
    this.timers = options.timers ?? defaultTimers();
    this.runTimeoutMs = options.runTimeoutMs ?? DEFAULT_ROOM_RUN_TIMEOUT_MS;
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
      room = await readRoom({ vaultRoot: this.vaultRoot, roomId: input.roomId });
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
      client: undefined as unknown as RoomRpcClient,
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

  private appendBase(roomId: string): { vaultRoot: string; roomId: string; now: () => Date; nonce?: () => string } {
    const base: { vaultRoot: string; roomId: string; now: () => Date; nonce?: () => string } = {
      vaultRoot: this.vaultRoot,
      roomId,
      now: this.now,
    };
    // exactOptionalPropertyTypes: never assign an explicit undefined nonce.
    if (this.nonce !== undefined) {
      base.nonce = this.nonce;
    }
    return base;
  }

  private async runMention(
    run: ActiveRun,
    input: RoomMentionInput,
    text: string,
    done: Promise<void>,
  ): Promise<RoomDispatchOutcome> {
    const appendBase = this.appendBase(input.roomId);

    // 1. Immutable steward message with the structured addressed agent.
    const stewardEvent = await appendRoomEvent({
      ...appendBase,
      kind: "steward_message",
      authorKind: "steward",
      author: "steward",
      body: text,
      addressedAgent: input.agent,
    });
    run.stewardEventId = stewardEvent.id;

    // Start the isolated room × agent session. A pre-start failure is a
    // launch failure: no run_started, exactly one terminal run_finished.
    let session;
    try {
      session = await this.sessions.getSession("room", run.key, input.agent);
    } catch {
      const terminal = await appendRoomEvent({
        ...appendBase,
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
    await appendRoomEvent({
      ...appendBase,
      kind: "run_started",
      authorKind: "system",
      author: "system",
      body: `Run started for agent '${input.agent}'.`,
      runStatus: "running",
      correlationId: stewardEvent.id,
    });

    run.unsubscribeEvents = run.client.onEvent((event) => this.handleClientEvent(run, event));
    run.unsubscribeExit = run.client.onExit(() => this.settle(run, "exit"));
    run.timeoutHandle = this.timers.setTimeout(() => this.settle(run, "timeout"), this.runTimeoutMs);

    try {
      await run.client.prompt(buildRoomMentionPrompt({ roomId: input.roomId, agent: input.agent, text }));
    } catch {
      this.settle(run, "launch_failure");
    }

    await done;
    return await this.finalizeRun(run, input, appendBase);
  }

  private handleClientEvent(run: ActiveRun, event: RpcEvent): void {
    if (run.settled) return;
    run.events.push(event);
    if (event.type === "extension_ui_request" && typeof event.id === "string") {
      this.pendingApprovals.set(`${run.key}:${event.id}`, {
        roomId: run.roomId,
        agent: run.agent,
        requestId: event.id,
        run,
      });
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

  private async finalizeRun(
    run: ActiveRun,
    input: RoomMentionInput,
    appendBase: { vaultRoot: string; roomId: string; now: () => Date; nonce?: () => string },
  ): Promise<RoomDispatchOutcome> {
    const kind = run.settleKind ?? "closed";

    if (kind === "closed") {
      return { status: "closed", roomId: input.roomId, agent: input.agent, stewardEventId: run.stewardEventId };
    }

    if (kind === "timeout" || kind === "cancel") {
      // Abort only the exact room-agent client. Stale agent_end emitted by
      // the abort is ignored: listeners were unsubscribed at settle time.
      await run.client.abort().catch(() => {});
    }

    if (kind === "completed") {
      const text = extractAssistantText(run.events).trim();
      let agentEventId: string | undefined;
      if (text !== "") {
        const agentEvent = await appendRoomEvent({
          ...appendBase,
          kind: "agent_message",
          authorKind: "agent",
          author: input.agent,
          body: text,
          correlationId: run.stewardEventId,
        });
        agentEventId = agentEvent.id;
      }
      const terminal = await appendRoomEvent({
        ...appendBase,
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

    if (kind === "launch_failure") {
      const terminal = await appendRoomEvent({
        ...appendBase,
        kind: "run_finished",
        authorKind: "system",
        author: "system",
        body: "The run could not be started.",
        runStatus: "failed",
        failureKind: "launch_failure",
        correlationId: run.stewardEventId,
      });
      run.terminalEventId = terminal.id;
      return {
        status: "failed",
        roomId: input.roomId,
        agent: input.agent,
        stewardEventId: run.stewardEventId,
        terminalEventId: terminal.id,
        failureKind: "launch_failure",
      };
    }

    if (kind === "exit") {
      const terminal = await appendRoomEvent({
        ...appendBase,
        kind: "run_finished",
        authorKind: "system",
        author: "system",
        body: "The run ended unexpectedly.",
        runStatus: "failed",
        failureKind: "ambiguous",
        correlationId: run.stewardEventId,
      });
      run.terminalEventId = terminal.id;
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
      const terminal = await appendRoomEvent({
        ...appendBase,
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
    const terminal = await appendRoomEvent({
      ...appendBase,
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
    if (pending.run.settled || this.activeRuns.get(pending.run.key) !== pending.run) {
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
   * Close the broker: settle every active run silently (no further room
   * records), clear all pending approvals, and stop all room sessions.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const run of [...this.activeRuns.values()]) {
      this.settle(run, "closed");
    }
    this.pendingApprovals.clear();
    await this.sessions.closeAll();
  }
}
