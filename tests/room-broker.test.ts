import { mkdtemp, link, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoom } from "../src/rooms.js";
import type { ExtensionUiResponse, RpcEvent, RpcSpawnTarget } from "../src/gateway-rpc.js";
import { RoomBroker, type RoomApprovalNotification, type RoomRpcClient } from "../src/room-broker.js";
import {
  ROOM_HANDOFF_MAX_REPLY_LENGTH,
  ROOM_HANDOFF_PROTOCOL_VERSION,
  ROOM_HANDOFF_REQUEST_TITLE,
  ROOM_HANDOFF_TRUNCATION_MARKER,
  parseHandoffResultValue,
} from "../src/room-handoff-protocol.js";

type FakeBehavior = "complete" | "empty" | "hang" | "prompt-fail" | "start-fail" | "exit-mid-run" | "approval" | "handoff" | "handoff-hang";

class FakeRoomClient implements RoomRpcClient {
  started = 0;
  stopped = 0;
  aborted = 0;
  prompts: string[] = [];
  responses: { id: string; response: ExtensionUiResponse }[] = [];
  /** Handoff control request emitted by a "handoff"/"handoff-hang" lead. */
  handoffTo: string | null = null;
  handoffText = "Please help with this bounded task.";
  handoffRequestId = "handoff-1";
  handoffResults: { id: string; status: string }[] = [];
  /**
   * Optional ordered sequence of handoff requests (budget tests). When empty,
   * the single handoffTo/handoffText/handoffRequestId fields describe one
   * request. Each accepted/rejected response advances to the next request.
   */
  handoffSequence: { to: string; text: string; requestId: string }[] = [];
  private handoffCursor = 0;
  /** Deterministic start barrier: start() waits for this promise when set. */
  startGate: Promise<void> | null = null;
  /** Optional error thrown by start() after the gate resolves. */
  startError: Error | null = null;
  private listeners: Array<(event: RpcEvent) => void> = [];
  private exitListeners: Array<() => void> = [];

  constructor(public behavior: FakeBehavior) {}

  private currentHandoffRequest(): { to: string; text: string; requestId: string } | null {
    if (this.handoffSequence.length > 0) {
      return this.handoffSequence[this.handoffCursor] ?? null;
    }
    if (this.handoffCursor === 0 && this.handoffTo !== null) {
      return { to: this.handoffTo, text: this.handoffText, requestId: this.handoffRequestId };
    }
    return null;
  }

  private emitHandoffRequest(): void {
    const request = this.currentHandoffRequest();
    if (request === null) throw new Error("fake handoffTo not set");
    this.emit({
      type: "extension_ui_request",
      id: request.requestId,
      method: "input",
      title: ROOM_HANDOFF_REQUEST_TITLE,
      placeholder: JSON.stringify({ v: ROOM_HANDOFF_PROTOCOL_VERSION, to: request.to, text: request.text }),
    });
  }

  async start(): Promise<void> {
    this.started += 1;
    if (this.startGate !== null) {
      await this.startGate;
    }
    if (this.startError !== null) {
      throw this.startError;
    }
    if (this.behavior === "start-fail") {
      throw new Error("spawn failed (fake)");
    }
  }

  async stop(): Promise<void> {
    this.stopped += 1;
  }

  async abort(): Promise<void> {
    this.aborted += 1;
    // Real Pi emits agent_end on abort; for the broker this is a STALE event
    // arriving after the run already settled and must be ignored.
    this.emit({ type: "agent_end", messages: [] });
  }

  async newSession(): Promise<{ cancelled: boolean }> {
    return { cancelled: false };
  }

  async compact(): Promise<{ tokensBefore: number | null; estimatedTokensAfter: number | null }> {
    return { tokensBefore: 1, estimatedTokensAfter: 1 };
  }

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) this.listeners.splice(index, 1);
    };
  }

  onExit(listener: () => void): () => void {
    this.exitListeners.push(listener);
    return () => {
      const index = this.exitListeners.indexOf(listener);
      if (index !== -1) this.exitListeners.splice(index, 1);
    };
  }

  emit(event: RpcEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  emitExit(): void {
    for (const listener of [...this.exitListeners]) listener();
  }

  async prompt(message: string): Promise<void> {
    this.prompts.push(message);
    switch (this.behavior) {
      case "start-fail":
        throw new Error("unreachable");
      case "prompt-fail":
        throw new Error("prompt rejected (fake)");
      case "complete":
        this.emit({ type: "agent_start" });
        this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } });
        this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "room." } });
        this.emit({ type: "agent_end", messages: [] });
        break;
      case "empty":
        this.emit({ type: "agent_end", messages: [] });
        break;
      case "exit-mid-run":
        this.emitExit();
        break;
      case "hang":
        break;
      case "approval":
        this.emit({ type: "extension_ui_request", id: "req-1", method: "confirm", title: "Approve?" });
        break;
      case "handoff":
      case "handoff-hang": {
        // A run's prompt is the start of a fresh turn: restart the handoff
        // sequence so a session-cached lead reused across roots emits its
        // request again. Within one root the cursor advances via responses.
        this.handoffCursor = 0;
        this.emitHandoffRequest();
        break;
      }
    }
  }

  respondToUiRequest(id: string, response: ExtensionUiResponse): void {
    this.responses.push({ id, response });
    // A handoff control response carries a structured `value`. Capture its
    // parsed status; a "handoff" lead then continues to a normal terminal or
    // emits the next queued handoff request.
    const isHandoff = this.behavior === "handoff" || this.behavior === "handoff-hang";
    const current = this.currentHandoffRequest();
    if (isHandoff && current !== null && id === current.requestId) {
      if ("value" in response) {
        const parsed = parseHandoffResultValue(response.value);
        this.handoffResults.push({ id, status: parsed.ok ? parsed.result.status : "malformed" });
      }
      this.handoffCursor += 1;
      if (this.currentHandoffRequest() !== null) {
        // Next queued handoff request in the same root.
        this.emitHandoffRequest();
      } else if (this.behavior === "handoff") {
        this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Lead continued." } });
        this.emit({ type: "agent_end", messages: [] });
      }
      return;
    }
    this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done." } });
    this.emit({ type: "agent_end", messages: [] });
  }
}

class ManualTimers {
  private callbacks = new Map<number, () => void>();
  private seq = 0;

  setTimeout = (callback: () => void, _ms: number): unknown => {
    const handle = ++this.seq;
    this.callbacks.set(handle, callback);
    return handle;
  };

  clearTimeout = (handle: unknown): void => {
    this.callbacks.delete(handle as number);
  };

  fireAll(): void {
    for (const callback of [...this.callbacks.values()]) callback();
  }

  /** Fire only the most recently registered pending timer. */
  fireLast(): void {
    const entries = [...this.callbacks.entries()];
    const last = entries[entries.length - 1];
    if (last) {
      this.callbacks.delete(last[0]);
      last[1]();
    }
  }

  get pending(): number {
    return this.callbacks.size;
  }
}

async function readEvents(root: string, roomId: string): Promise<{ name: string; content: string }[]> {
  const dir = join(root, "collaboration", "rooms", roomId, "events");
  const names = (await readdir(dir)).sort();
  return Promise.all(names.map(async (name) => ({ name, content: await readFile(join(dir, name), "utf8") })));
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  // Wall-clock budget: under full-suite parallel load a fixed number of
  // setImmediate ticks can elapse long before the fs-heavy dispatch path
  // reaches the awaited state.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not met in time");
}

describe("RoomBroker", () => {
  let root: string;
  let clients: FakeRoomClient[];
  let timers: ManualTimers;
  let nonceSeq: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-room-broker-"));
    clients = [];
    timers = new ManualTimers();
    nonceSeq = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function makeBroker(options?: { runnableAgents?: string[]; behaviors?: FakeBehavior[] }): RoomBroker {
    const behaviors = options?.behaviors ?? [];
    return new RoomBroker({
      vaultRoot: root,
      runnableAgents: options?.runnableAgents ?? ["kimi", "thor"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => {
        const client = new FakeRoomClient(behaviors[clients.length] ?? "complete");
        clients.push(client);
        return client;
      },
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
    });
  }

  async function makeRoom(participants: string[] = ["kimi"]): Promise<string> {
    const room = await createRoom({
      vaultRoot: root,
      title: "Broker room",
      participants,
      now: () => new Date("2026-08-02T17:00:00.000Z"),
    });
    return room.id;
  }

  it("rejects blank text, unknown room, closed room, non-participant, and non-runnable agent with zero side effects", async () => {
    const broker = makeBroker();
    const roomId = await makeRoom(["kimi"]);

    await expect(broker.dispatchRoomMention({ roomId, agent: "kimi", text: "   " })).rejects.toThrow("text");
    await expect(broker.dispatchRoomMention({ roomId: "no-such-room", agent: "kimi", text: "hi" })).rejects.toThrow(
      "no-such-room",
    );
    await expect(broker.dispatchRoomMention({ roomId, agent: "thor", text: "hi" })).rejects.toThrow("participant");
    await expect(broker.dispatchRoomMention({ roomId, agent: "kimi", text: "hi" })).resolves.toBeDefined();

    const notRunnable = makeBroker({ runnableAgents: ["thor"] });
    await expect(notRunnable.dispatchRoomMention({ roomId, agent: "kimi", text: "hi" })).rejects.toThrow(
      "runnable",
    );

    // Closed room: mutate the manifest directly (the core has no update API yet).
    const closedBroker = makeBroker();
    const manifestPath = join(root, "collaboration", "rooms", roomId, "index.md");
    const manifest = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, manifest.replace("status: open", "status: closed"), "utf8");
    await expect(closedBroker.dispatchRoomMention({ roomId, agent: "kimi", text: "hi" })).rejects.toThrow("closed");

    // Only the successful dispatch above may have produced effects.
    expect(clients).toHaveLength(1);
    const events = await readEvents(root, roomId);
    // one steward message + run_started + agent_message + run_finished
    expect(events).toHaveLength(4);
  });

  it("rejects a duplicate active run for the same room × agent with zero new side effects", async () => {
    const broker = makeBroker({ behaviors: ["hang"] });
    const roomId = await makeRoom(["kimi"]);

    const first = broker.dispatchRoomMention({ roomId, agent: "kimi", text: "first" });
    // Wait until the first run is fully active: client created, prompt sent.
    // run_started is appended before prompt, so this also pins event count.
    await waitFor(() => clients.length === 1 && (clients[0]?.prompts.length ?? 0) === 1);
    expect(broker.hasActiveRun(roomId, "kimi")).toBe(true);

    await expect(broker.dispatchRoomMention({ roomId, agent: "kimi", text: "second" })).rejects.toThrow("active");

    expect(clients).toHaveLength(1);
    expect(clients[0]?.prompts).toHaveLength(1);
    const events = await readEvents(root, roomId);
    expect(events).toHaveLength(2); // steward_message + run_started only

    await broker.close();
    await first;
  });
});

describe("RoomBroker dispatch outcomes", () => {
  let root: string;
  let clients: FakeRoomClient[];
  let timers: ManualTimers;
  let nonceSeq: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-room-broker-out-"));
    clients = [];
    timers = new ManualTimers();
    nonceSeq = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function makeBroker(options?: { runnableAgents?: string[]; behaviors?: FakeBehavior[] }): RoomBroker {
    const behaviors = options?.behaviors ?? [];
    return new RoomBroker({
      vaultRoot: root,
      runnableAgents: options?.runnableAgents ?? ["kimi", "thor"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => {
        const client = new FakeRoomClient(behaviors[clients.length] ?? "complete");
        clients.push(client);
        return client;
      },
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
    });
  }

  async function makeRoom(title: string, participants: string[]): Promise<string> {
    const room = await createRoom({
      vaultRoot: root,
      title,
      participants,
      now: () => new Date("2026-08-02T17:00:00.000Z"),
    });
    return room.id;
  }

  it("writes the exact immutable event sequence for a successful bounded run", async () => {
    const broker = makeBroker({ behaviors: ["complete"] });
    const roomId = await makeRoom("Success room", ["kimi"]);

    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Say hello." });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    expect(outcome.agentEventId).toBeDefined();

    const events = await readEvents(root, roomId);
    expect(events).toHaveLength(4);

    // All events share the injected timestamp, so filename order is the kind
    // slug order, not append order. Locate each by kind.
    const byKind = (kind: string): string => {
      const found = events.find((entry) => entry.content.includes(`kind: ${kind}`));
      if (!found) throw new Error(`missing event kind ${kind}`);
      return found.content;
    };
    const steward = byKind("steward_message");
    const started = byKind("run_started");
    const agentMessage = byKind("agent_message");
    const finished = byKind("run_finished");
    expect(steward).toContain("kind: steward_message");
    expect(steward).toContain("author_kind: steward");
    expect(steward).toContain("addressed_agent: kimi");
    expect(steward).toContain("Say hello.");
    expect(steward).not.toContain("run_status");

    expect(started).toContain("kind: run_started");
    expect(started).toContain("author: system");
    expect(started).toContain("run_status: running");
    expect(started).toContain(`correlation_id: ${outcome.stewardEventId}`);

    expect(agentMessage).toContain("kind: agent_message");
    expect(agentMessage).toContain("author: kimi");
    expect(agentMessage).toContain("Hello room.");
    expect(agentMessage).toContain(`correlation_id: ${outcome.stewardEventId}`);

    expect(finished).toContain("kind: run_finished");
    expect(finished).toContain("run_status: completed");
    expect(finished).not.toContain("failure_kind");
    expect(finished).toContain(`correlation_id: ${outcome.stewardEventId}`);

    // The bounded prompt carries room context and the steward text.
    expect(clients[0]?.prompts[0]).toContain(roomId);
    expect(clients[0]?.prompts[0]).toContain("Say hello.");
    expect(clients[0]?.prompts[0]).toContain("Do not address, mention, or dispatch other agents");

    expect(broker.hasActiveRun(roomId, "kimi")).toBe(false);
    await broker.close();
  });

  it("omits the agent_message when the run completes with no assistant text", async () => {
    const broker = makeBroker({ behaviors: ["empty"] });
    const roomId = await makeRoom("Empty room", ["kimi"]);

    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Silent?" });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    expect(outcome.agentEventId).toBeUndefined();

    const events = await readEvents(root, roomId);
    expect(events).toHaveLength(3);
    expect(events.map((entry) => entry.content).some((content) => content.includes("kind: agent_message"))).toBe(false);
    await broker.close();
  });

  it("gives two rooms × two agents distinct isolated clients with no cross-written events", async () => {
    const broker = makeBroker({ behaviors: ["complete", "complete"] });
    const roomOne = await makeRoom("Room one", ["kimi"]);
    const roomTwo = await makeRoom("Room two", ["thor"]);

    const [outcomeOne, outcomeTwo] = await Promise.all([
      broker.dispatchRoomMention({ roomId: roomOne, agent: "kimi", text: "First room task." }),
      broker.dispatchRoomMention({ roomId: roomTwo, agent: "thor", text: "Second room task." }),
    ]);
    expect(outcomeOne.status).toBe("completed");
    expect(outcomeTwo.status).toBe("completed");

    expect(clients).toHaveLength(2);
    expect(clients[0]).not.toBe(clients[1]);
    // Client creation order is not room order under concurrency; identify
    // each client by the room id embedded in its bounded prompt.
    const clientFor = (room: string): FakeRoomClient => {
      const client = clients.find((candidate) => (candidate.prompts[0] ?? "").includes(room));
      if (!client) throw new Error(`no client for ${room}`);
      return client;
    };
    expect(clientFor(roomOne).prompts[0]).toContain("First room task.");
    expect(clientFor(roomTwo).prompts[0]).toContain("Second room task.");

    const eventsOne = await readEvents(root, roomOne);
    const eventsTwo = await readEvents(root, roomTwo);
    expect(eventsOne).toHaveLength(4);
    expect(eventsTwo).toHaveLength(4);
    for (const entry of eventsOne) {
      expect(entry.content).toContain(`room: ${roomOne}`);
      expect(entry.content).not.toContain(roomTwo);
    }
    for (const entry of eventsTwo) {
      expect(entry.content).toContain(`room: ${roomTwo}`);
      expect(entry.content).not.toContain(roomOne);
    }
    await broker.close();
  });
});

describe("RoomBroker terminal paths", () => {
  let root: string;
  let clients: FakeRoomClient[];
  let timers: ManualTimers;
  let nonceSeq: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-room-broker-term-"));
    clients = [];
    timers = new ManualTimers();
    nonceSeq = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function makeBroker(options?: { behaviors?: FakeBehavior[] }): RoomBroker {
    const behaviors = options?.behaviors ?? [];
    return new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi", "thor"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => {
        const client = new FakeRoomClient(behaviors[clients.length] ?? "complete");
        clients.push(client);
        return client;
      },
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
    });
  }

  async function makeRoom(participants: string[] = ["kimi"]): Promise<string> {
    const room = await createRoom({
      vaultRoot: root,
      title: "Terminal room",
      participants,
      now: () => new Date("2026-08-02T17:00:00.000Z"),
    });
    return room.id;
  }

  function byKind(events: { content: string }[], kind: string): string | undefined {
    return events.find((entry) => entry.content.includes(`kind: ${kind}`))?.content;
  }

  it("records exactly one launch_failure terminal event when the session cannot start", async () => {
    const broker = makeBroker({ behaviors: ["start-fail"] });
    const roomId = await makeRoom();

    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Go." });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.failureKind).toBe("launch_failure");

    const events = await readEvents(root, roomId);
    expect(events).toHaveLength(2); // steward_message + run_finished
    expect(byKind(events, "run_started")).toBeUndefined();
    const finished = byKind(events, "run_finished") ?? "";
    expect(finished).toContain("run_status: failed");
    expect(finished).toContain("failure_kind: launch_failure");
    expect(finished).toContain(`correlation_id: ${outcome.stewardEventId}`);
    // Non-secret body: no raw error text.
    expect(finished).not.toContain("spawn failed");

    expect(broker.hasActiveRun(roomId, "kimi")).toBe(false);
    await broker.close();
  });

  it("records exactly one ambiguous terminal event when the prompt is rejected after run_started", async () => {
    const broker = makeBroker({ behaviors: ["prompt-fail"] });
    const roomId = await makeRoom();

    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Go." });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    // ADR-0038 boundary: after the prompt handoff the broker cannot infer
    // whether side effects occurred, so the failure is ambiguous, never
    // launch_failure.
    expect(outcome.failureKind).toBe("ambiguous");

    const events = await readEvents(root, roomId);
    expect(events).toHaveLength(3); // steward + run_started + run_finished
    const finished = byKind(events, "run_finished") ?? "";
    expect(finished).toContain("run_status: failed");
    expect(finished).toContain("failure_kind: ambiguous");
    expect(finished).not.toContain("launch_failure");
    expect(finished).not.toContain("prompt rejected");
    expect(byKind(events, "agent_message")).toBeUndefined();
    expect(broker.hasActiveRun(roomId, "kimi")).toBe(false);
    await broker.close();
  });

  it("times out a hung run, aborts only the room-agent client, and ignores the stale agent_end", async () => {
    const broker = makeBroker({ behaviors: ["hang"] });
    const roomId = await makeRoom();

    const dispatch = broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Hang." });
    await waitFor(() => clients.length === 1 && (clients[0]?.prompts.length ?? 0) === 1);
    expect(timers.pending).toBe(1);

    timers.fireAll();
    const outcome = await dispatch;
    expect(outcome.status).toBe("timed_out");

    expect(clients[0]?.aborted).toBe(1); // abort emitted a stale agent_end internally
    const events = await readEvents(root, roomId);
    expect(events).toHaveLength(3); // steward + run_started + run_finished(timed_out)
    const finished = byKind(events, "run_finished") ?? "";
    expect(finished).toContain("run_status: timed_out");
    expect(finished).not.toContain("failure_kind");
    expect(byKind(events, "agent_message")).toBeUndefined();
    expect(broker.hasActiveRun(roomId, "kimi")).toBe(false);
    expect(timers.pending).toBe(0);
    await broker.close();
  });

  it("aborts only the addressed room-agent client and records exactly one run_cancelled", async () => {
    const broker = makeBroker({ behaviors: ["hang", "hang"] });
    const roomId = await makeRoom(["kimi", "thor"]);

    const dispatchOne = broker.dispatchRoomMention({ roomId, agent: "kimi", text: "One." });
    const dispatchTwo = broker.dispatchRoomMention({ roomId, agent: "thor", text: "Two." });
    await waitFor(() => clients.length === 2 && clients.every((client) => client.prompts.length === 1));

    const abortOutcome = await broker.abort(roomId, "kimi");
    expect(abortOutcome.status).toBe("cancelled");

    const outcomeOne = await dispatchOne;
    expect(outcomeOne.status).toBe("cancelled");
    // Client creation order is not agent order; identify by prompt content.
    const clientFor = (needle: string): FakeRoomClient => {
      const client = clients.find((candidate) => (candidate.prompts[0] ?? "").includes(needle));
      if (!client) throw new Error(`no client for ${needle}`);
      return client;
    };
    expect(clientFor("One.").aborted).toBe(1);
    expect(clientFor("Two.").aborted).toBe(0); // other room-agent client untouched

    const events = await readEvents(root, roomId);
    const cancelled = events.filter((entry) => entry.content.includes("kind: run_cancelled"));
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.content).toContain("run_status: cancelled");
    expect(cancelled[0]?.content).not.toContain("failure_kind");
    expect(cancelled[0]?.content).toContain(`correlation_id: ${outcomeOne.stewardEventId}`);

    // Second run is still active and unaffected; a duplicate abort is a no-op.
    expect(broker.hasActiveRun(roomId, "thor")).toBe(true);
    expect(await broker.abort(roomId, "kimi")).toEqual({ status: "no-active-run", roomId, agent: "kimi" });

    await broker.close();
    const outcomeTwo = await dispatchTwo;
    // Graceful close cancels the remaining run with a terminal record.
    expect(outcomeTwo.status).toBe("cancelled");
    expect(clients.every((client) => client.stopped === 1)).toBe(true);

    const afterClose = await readEvents(root, roomId);
    const allCancelled = afterClose.filter((entry) => entry.content.includes("kind: run_cancelled"));
    expect(allCancelled).toHaveLength(2);
    if (outcomeTwo.status === "cancelled") {
      const secondCancel = allCancelled.find((entry) => entry.content.includes(`correlation_id: ${outcomeTwo.stewardEventId}`));
      expect(secondCancel?.content).toContain("run_status: cancelled");
    }
  });

  it("settles a mid-run client exit once with a non-secret ambiguous failure and releases the key", async () => {
    const broker = makeBroker({ behaviors: ["exit-mid-run"] });
    const roomId = await makeRoom();

    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Go." });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.failureKind).toBe("ambiguous");

    const events = await readEvents(root, roomId);
    expect(events).toHaveLength(3);
    const finished = byKind(events, "run_finished") ?? "";
    expect(finished).toContain("run_status: failed");
    expect(finished).toContain("failure_kind: ambiguous");
    expect(broker.hasActiveRun(roomId, "kimi")).toBe(false);
    await broker.close();
  });
});

describe("RoomBroker approvals", () => {
  let root: string;
  let clients: FakeRoomClient[];
  let timers: ManualTimers;
  let nonceSeq: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-room-broker-appr-"));
    clients = [];
    timers = new ManualTimers();
    nonceSeq = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function makeBroker(behaviors: FakeBehavior[]): RoomBroker {
    return new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi", "thor"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => {
        const client = new FakeRoomClient(behaviors[clients.length] ?? "approval");
        clients.push(client);
        return client;
      },
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
    });
  }

  async function makeRoom(title: string, participants: string[]): Promise<string> {
    const room = await createRoom({
      vaultRoot: root,
      title,
      participants,
      now: () => new Date("2026-08-02T17:00:00.000Z"),
    });
    return room.id;
  }

  it("delivers an approval response only to the exact room-agent client and clears it on completion", async () => {
    const broker = makeBroker(["approval"]);
    const roomId = await makeRoom("Approval room", ["kimi"]);

    const dispatch = broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Needs approval." });
    await waitFor(() => broker.hasPendingApproval(roomId, "kimi", "req-1"));

    // Wrong room / wrong request id reject and send nothing.
    expect(() =>
      broker.respondToRoomApproval({ roomId: "other-room", agent: "kimi", requestId: "req-1", response: { confirmed: true } }),
    ).toThrow("Unknown room approval");
    expect(() =>
      broker.respondToRoomApproval({ roomId, agent: "kimi", requestId: "req-999", response: { confirmed: true } }),
    ).toThrow("Unknown room approval");
    expect(clients[0]?.responses).toHaveLength(0);

    broker.respondToRoomApproval({ roomId, agent: "kimi", requestId: "req-1", response: { confirmed: true } });
    expect(clients[0]?.responses).toEqual([{ id: "req-1", response: { confirmed: true } }]);
    expect(broker.hasPendingApproval(roomId, "kimi", "req-1")).toBe(false);

    const outcome = await dispatch;
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      // The post-approval assistant text was recorded.
      const events = await readEvents(root, roomId);
      expect(events.some((entry) => entry.content.includes("Done."))).toBe(true);
    }

    // Already-resolved / stale responses reject and write no room record.
    expect(() =>
      broker.respondToRoomApproval({ roomId, agent: "kimi", requestId: "req-1", response: { confirmed: true } }),
    ).toThrow("Unknown room approval");
    const events = await readEvents(root, roomId);
    expect(events).toHaveLength(4);
    await broker.close();
  });

  it("never cross-delivers the same Pi request id between two room-agent clients", async () => {
    const broker = makeBroker(["approval", "approval"]);
    const roomOne = await makeRoom("Room A", ["kimi"]);
    const roomTwo = await makeRoom("Room B", ["thor"]);

    const dispatchOne = broker.dispatchRoomMention({ roomId: roomOne, agent: "kimi", text: "A." });
    const dispatchTwo = broker.dispatchRoomMention({ roomId: roomTwo, agent: "thor", text: "B." });
    await waitFor(
      () => broker.hasPendingApproval(roomOne, "kimi", "req-1") && broker.hasPendingApproval(roomTwo, "thor", "req-1"),
    );

    // Client creation order is not room order; identify each client by the
    // room id embedded in its bounded prompt.
    const clientFor = (room: string): FakeRoomClient => {
      const client = clients.find((candidate) => (candidate.prompts[0] ?? "").includes(room));
      if (!client) throw new Error(`no client for ${room}`);
      return client;
    };

    broker.respondToRoomApproval({ roomId: roomOne, agent: "kimi", requestId: "req-1", response: { confirmed: true } });
    expect(clientFor(roomOne).responses).toHaveLength(1);
    expect(clientFor(roomTwo).responses).toHaveLength(0);
    expect(broker.hasPendingApproval(roomTwo, "thor", "req-1")).toBe(true);

    broker.respondToRoomApproval({ roomId: roomTwo, agent: "thor", requestId: "req-1", response: { cancelled: true } });
    expect(clientFor(roomTwo).responses).toEqual([{ id: "req-1", response: { cancelled: true } }]);

    const [outcomeOne, outcomeTwo] = await Promise.all([dispatchOne, dispatchTwo]);
    expect(outcomeOne.status).toBe("completed");
    expect(outcomeTwo.status).toBe("completed");
    await broker.close();
  });

  it("clears pending approvals when the run times out", async () => {
    const broker = makeBroker(["approval"]);
    const roomId = await makeRoom("Timeout approval room", ["kimi"]);

    const dispatch = broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Will hang on approval." });
    await waitFor(() => broker.hasPendingApproval(roomId, "kimi", "req-1"));

    timers.fireAll();
    const outcome = await dispatch;
    expect(outcome.status).toBe("timed_out");
    expect(broker.hasPendingApproval(roomId, "kimi", "req-1")).toBe(false);
    expect(() =>
      broker.respondToRoomApproval({ roomId, agent: "kimi", requestId: "req-1", response: { confirmed: true } }),
    ).toThrow("Unknown room approval");
    await broker.close();
  });
});

describe("RoomBroker close lifecycle", () => {
  let root: string;
  let clients: FakeRoomClient[];
  let timers: ManualTimers;
  let nonceSeq: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-room-broker-close-"));
    clients = [];
    timers = new ManualTimers();
    nonceSeq = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function makeBroker(behaviors: FakeBehavior[]): RoomBroker {
    return new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi", "thor"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => {
        const client = new FakeRoomClient(behaviors[clients.length] ?? "hang");
        clients.push(client);
        return client;
      },
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
    });
  }

  async function makeRoom(participants: string[]): Promise<string> {
    const room = await createRoom({
      vaultRoot: root,
      title: "Close room",
      participants,
      now: () => new Date("2026-08-02T17:00:00.000Z"),
    });
    return room.id;
  }

  it("close during an active run writes exactly one run_cancelled, clears state, and waits for records before stopping clients", async () => {
    const broker = makeBroker(["approval"]);
    const roomId = await makeRoom(["kimi"]);

    const dispatch = broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Needs approval then hangs." });
    await waitFor(() => broker.hasPendingApproval(roomId, "kimi", "req-1"));
    expect(timers.pending).toBe(1);

    await broker.close();
    const outcome = await dispatch;
    // Close finalization records cancellation, not an ambiguous failure.
    expect(outcome.status).toBe("cancelled");

    const events = await readEvents(root, roomId);
    const cancelled = events.filter((entry) => entry.content.includes("kind: run_cancelled"));
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.content).toContain("run_status: cancelled");
    expect(cancelled[0]?.content).not.toContain("failure_kind");
    // The stale agent_end emitted by the shutdown abort wrote nothing extra.
    expect(events.filter((entry) => entry.content.includes("kind: run_finished"))).toHaveLength(0);

    expect(broker.hasActiveRun(roomId, "kimi")).toBe(false);
    expect(broker.hasPendingApproval(roomId, "kimi", "req-1")).toBe(false);
    expect(timers.pending).toBe(0);
    expect(clients[0]?.aborted).toBe(1);
    expect(clients[0]?.stopped).toBe(1);

    // Idempotent second close creates no record.
    await broker.close();
    expect(await readEvents(root, roomId)).toHaveLength(events.length);
  });

  it("close with no active run is idempotent and writes no records", async () => {
    const broker = makeBroker([]);
    const roomId = await makeRoom(["kimi"]);
    await broker.close();
    await broker.close();
    expect(await readEvents(root, roomId)).toEqual([]);
    await expect(broker.dispatchRoomMention({ roomId, agent: "kimi", text: "late" })).rejects.toThrow("closed");
  });
});

describe("RoomBroker dead-session lifecycle", () => {
  let root: string;
  let clients: FakeRoomClient[];
  let timers: ManualTimers;
  let nonceSeq: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-room-broker-dead-"));
    clients = [];
    timers = new ManualTimers();
    nonceSeq = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function makeBroker(behaviors: FakeBehavior[]): RoomBroker {
    return new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi", "thor"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => {
        const client = new FakeRoomClient(behaviors[clients.length] ?? "complete");
        clients.push(client);
        return client;
      },
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
    });
  }

  it("forgets only the exited room-agent session so the next explicit mention starts a distinct fresh client", async () => {
    // kimi's first client exits mid-run; thor's client completes and stays cached.
    const broker = makeBroker(["exit-mid-run", "complete", "complete", "complete"]);
    const room = await createRoom({
      vaultRoot: root,
      title: "Dead session room",
      participants: ["kimi", "thor"],
      now: () => new Date("2026-08-02T17:00:00.000Z"),
    });
    const roomId = room.id;

    const failedOutcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Dies." });
    expect(failedOutcome.status).toBe("failed");
    expect(clients).toHaveLength(1);

    // Unrelated room-agent session: completed run, client stays cached.
    const thorOutcome = await broker.dispatchRoomMention({ roomId, agent: "thor", text: "Thor lives." });
    expect(thorOutcome.status).toBe("completed");
    expect(clients).toHaveLength(2);

    // A NEW explicit mention for the exited room × agent starts a fresh,
    // distinct client — not a retry of the failed run, not the dead client.
    const retryOutcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Fresh start." });
    expect(retryOutcome.status).toBe("completed");
    expect(clients).toHaveLength(3);
    expect(clients[2]).not.toBe(clients[0]);
    expect(clients[2]?.prompts[0]).toContain("Fresh start.");

    // The unrelated thor session was NOT forgotten: reuses its cached client.
    const thorAgain = await broker.dispatchRoomMention({ roomId, agent: "thor", text: "Thor again." });
    expect(thorAgain.status).toBe("completed");
    expect(clients).toHaveLength(3);

    await broker.close();
  });
});

describe("RoomBroker initialization race barriers", () => {
  let root: string;
  let clients: FakeRoomClient[];
  let timers: ManualTimers;
  let nonceSeq: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-room-broker-race-"));
    clients = [];
    timers = new ManualTimers();
    nonceSeq = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function makeBroker(options?: {
    behaviors?: FakeBehavior[];
    clientFactory?: () => FakeRoomClient;
    io?: { linkNoClobber(t: string, target: string): Promise<void>; remove(p: string): Promise<void> };
  }): RoomBroker {
    const behaviors = options?.behaviors ?? [];
    return new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi", "thor"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory:
        options?.clientFactory ??
        (() => {
          const client = new FakeRoomClient(behaviors[clients.length] ?? "complete");
          clients.push(client);
          return client;
        }),
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
      io: options?.io,
    });
  }

  async function makeRoom(participants: string[]): Promise<string> {
    const room = await createRoom({
      vaultRoot: root,
      title: "Race room",
      participants,
      now: () => new Date("2026-08-02T17:00:00.000Z"),
    });
    return room.id;
  }

  function gatedWriteIo(gate: Promise<void>, onFirstLink: () => void): {
    linkNoClobber(t: string, target: string): Promise<void>;
    remove(p: string): Promise<void>;
  } {
    let linkCalls = 0;
    return {
      linkNoClobber: async (tempPath: string, targetPath: string) => {
        linkCalls += 1;
        if (linkCalls === 1) {
          onFirstLink();
          await gate;
        }
        await link(tempPath, targetPath);
      },
      remove: async (path: string) => {
        await rm(path, { force: true });
      },
    };
  }

  it("close while the steward append is suspended: no session, no run_started, exactly one run_cancelled", async () => {
    let firstLinked!: () => void;
    const atFirstLink = new Promise<void>((resolve) => {
      firstLinked = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const io = gatedWriteIo(gate, () => firstLinked());
    const broker = makeBroker({ io });
    const roomId = await makeRoom(["kimi"]);

    const dispatch = broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Suspended steward." });
    await atFirstLink;

    const closePromise = broker.close();
    releaseGate();
    await closePromise;
    const outcome = await dispatch;

    expect(outcome.status).toBe("cancelled");
    expect(clients).toHaveLength(0); // no session was ever built
    const events = await readEvents(root, roomId);
    // close returned only after the durable cancellation evidence existed.
    expect(events).toHaveLength(2);
    expect(events.some((entry) => entry.content.includes("kind: steward_message"))).toBe(true);
    const cancelled = events.filter((entry) => entry.content.includes("kind: run_cancelled"));
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.content).toContain("run_status: cancelled");
    expect(events.some((entry) => entry.content.includes("kind: run_started"))).toBe(false);
    expect(events.some((entry) => entry.content.includes("kind: run_finished"))).toBe(false);
    expect(broker.hasActiveRun(roomId, "kimi")).toBe(false);
  });

  it("abort while the steward append is suspended: no session, no run_started, exactly one run_cancelled", async () => {
    let firstLinked!: () => void;
    const atFirstLink = new Promise<void>((resolve) => {
      firstLinked = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const io = gatedWriteIo(gate, () => firstLinked());
    const broker = makeBroker({ io });
    const roomId = await makeRoom(["kimi"]);

    const dispatch = broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Suspended steward." });
    await atFirstLink;

    const abortPromise = broker.abort(roomId, "kimi");
    releaseGate();
    const abortOutcome = await abortPromise;
    const outcome = await dispatch;

    expect(abortOutcome.status).toBe("cancelled");
    expect(outcome.status).toBe("cancelled");
    expect(clients).toHaveLength(0);
    const events = await readEvents(root, roomId);
    expect(events).toHaveLength(2);
    expect(events.filter((entry) => entry.content.includes("kind: run_cancelled"))).toHaveLength(1);
    expect(events.some((entry) => entry.content.includes("kind: run_started"))).toBe(false);
    await broker.close();
  });

  it("abort while session start is suspended: cleans up only the just-created client, one run_cancelled, unrelated session stays cached", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const broker = makeBroker({
      clientFactory: () => {
        // Only the second client (gated kimi start) hangs; every other
        // client completes so later explicit mentions finish.
        const client = new FakeRoomClient(clients.length === 1 ? "hang" : "complete");
        if (clients.length === 1) {
          client.startGate = startGate;
        }
        clients.push(client);
        return client;
      },
    });
    const roomId = await makeRoom(["kimi", "thor"]);

    // Seed an unrelated cached room-agent session.
    expect((await broker.dispatchRoomMention({ roomId, agent: "thor", text: "Thor seed." })).status).toBe("completed");
    expect(clients).toHaveLength(1);

    const dispatch = broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Suspended start." });
    await waitFor(() => clients.length === 2 && clients[1]?.started === 1);

    const abortPromise = broker.abort(roomId, "kimi");
    releaseStart();
    const abortOutcome = await abortPromise;
    const outcome = await dispatch;

    expect(abortOutcome.status).toBe("cancelled");
    expect(outcome.status).toBe("cancelled");
    const gated = clients[1]!;
    expect(gated.stopped).toBe(1); // just-created client cleaned up
    expect(gated.aborted).toBe(0); // never active: no abort
    expect(gated.prompts).toHaveLength(0);

    const events = await readEvents(root, roomId);
    const kimiCancelled = events.filter(
      (entry) => entry.content.includes("kind: run_cancelled") && entry.content.includes(`correlation_id: ${outcome.stewardEventId}`),
    );
    expect(kimiCancelled).toHaveLength(1);
    expect(
      events.filter((entry) => entry.content.includes("kind: run_started") && entry.content.includes(`correlation_id: ${outcome.stewardEventId}`)),
    ).toHaveLength(0);
    expect(events.some((entry) => entry.content.includes("launch_failure"))).toBe(false);
    expect(broker.hasActiveRun(roomId, "kimi")).toBe(false);

    // The unrelated thor session was not removed or replaced.
    expect((await broker.dispatchRoomMention({ roomId, agent: "thor", text: "Thor again." })).status).toBe("completed");
    expect(clients).toHaveLength(2);

    // A later explicit kimi mention builds a fresh client (forgotten session).
    expect((await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Fresh kimi." })).status).toBe("completed");
    expect(clients).toHaveLength(3);
    expect(clients[2]).not.toBe(gated);

    await broker.close();
  });

  it("session start failure after abort wins still records cancellation, never launch_failure", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const broker = makeBroker({
      clientFactory: () => {
        const client = new FakeRoomClient("hang");
        client.startGate = startGate;
        client.startError = new Error("spawn exploded after gate (fake)");
        clients.push(client);
        return client;
      },
    });
    const roomId = await makeRoom(["kimi"]);

    const dispatch = broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Start fails after cancel." });
    await waitFor(() => clients.length === 1 && clients[0]?.started === 1);

    const abortPromise = broker.abort(roomId, "kimi");
    releaseStart();
    const abortOutcome = await abortPromise;
    const outcome = await dispatch;

    expect(abortOutcome.status).toBe("cancelled");
    expect(outcome.status).toBe("cancelled");
    const events = await readEvents(root, roomId);
    expect(events).toHaveLength(2); // steward + run_cancelled
    expect(events.filter((entry) => entry.content.includes("kind: run_cancelled"))).toHaveLength(1);
    expect(events.some((entry) => entry.content.includes("kind: run_finished"))).toBe(false);
    expect(events.some((entry) => entry.content.includes("launch_failure"))).toBe(false);
    expect(events.some((entry) => entry.content.includes("spawn exploded"))).toBe(false);
    expect(clients[0]?.prompts).toHaveLength(0);
    expect(broker.hasActiveRun(roomId, "kimi")).toBe(false);
    await broker.close();
  });
});

describe("RoomBroker close during pre-reservation validation", () => {
  let root: string;
  let clients: FakeRoomClient[];
  let timers: ManualTimers;
  let nonceSeq: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-room-broker-prerace-"));
    clients = [];
    timers = new ManualTimers();
    nonceSeq = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("rejects closed with zero side effects when close() wins during awaited room validation", async () => {
    let releaseValidation!: () => void;
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    let validationCalls = 0;
    const roomId = (
      await createRoom({
        vaultRoot: root,
        title: "Pre-validation race room",
        participants: ["kimi"],
        now: () => new Date("2026-08-02T17:00:00.000Z"),
      })
    ).id;

    const broker = new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => {
        const client = new FakeRoomClient("complete");
        clients.push(client);
        return client;
      },
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      roomReader: async (options) => {
        validationCalls += 1;
        await validationGate;
        const { readRoom } = await import("../src/rooms.js");
        return readRoom(options);
      },
    });

    const dispatch = broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Held in validation." });
    await waitFor(() => validationCalls === 1);

    // close() runs fully while validation is suspended: no reservation exists
    // for it to settle, and sessions are stopped.
    await broker.close();
    releaseValidation();

    await expect(dispatch).rejects.toThrow("Room broker is closed.");
    expect(clients).toHaveLength(0); // no client/session was ever built
    expect(await readEvents(root, roomId)).toEqual([]); // no steward/terminal events
    expect(broker.hasActiveRun(roomId, "kimi")).toBe(false);

    // Direct post-close rejection also holds.
    await expect(broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Too late." })).rejects.toThrow(
      "Room broker is closed.",
    );
  });
});

describe("RoomBroker subscription seams", () => {
  let root: string;
  let clients: FakeRoomClient[];
  let timers: ManualTimers;
  let nonceSeq: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-room-broker-sub-"));
    clients = [];
    timers = new ManualTimers();
    nonceSeq = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function makeBroker(behaviors: FakeBehavior[]): RoomBroker {
    return new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi", "thor"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => {
        const client = new FakeRoomClient(behaviors[clients.length] ?? "complete");
        clients.push(client);
        return client;
      },
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
    });
  }

  async function makeRoom(title: string, participants: string[]): Promise<string> {
    const room = await createRoom({
      vaultRoot: root,
      title,
      participants,
      now: () => new Date("2026-08-02T17:00:00.000Z"),
    });
    return room.id;
  }

  it("publishes committed room events only to that room's listeners, and unsubscribes cleanly", async () => {
    const broker = makeBroker(["complete", "complete"]);
    const roomOne = await makeRoom("Sub one", ["kimi"]);
    const roomTwo = await makeRoom("Sub two", ["thor"]);

    const seenOne: { id: string; kind: string }[] = [];
    const seenTwo: { id: string; kind: string }[] = [];
    const unsubscribeOne = broker.onRoomEvent(roomOne, (event) => {
      seenOne.push({ id: event.id, kind: event.kind });
    });
    broker.onRoomEvent(roomTwo, (event) => {
      seenTwo.push({ id: event.id, kind: event.kind });
    });

    const outcome = await broker.dispatchRoomMention({ roomId: roomOne, agent: "kimi", text: "Publish me." });
    expect(outcome.status).toBe("completed");

    expect(seenOne.map((event) => event.kind)).toEqual(["steward_message", "run_started", "agent_message", "run_finished"]);
    expect(seenTwo).toEqual([]);
    // Listener receives the structured committed record, matching the durable files.
    const durable = await readEvents(root, roomOne);
    expect([...seenOne.map((event) => event.id)].sort()).toEqual(durable.map((entry) => entry.name.replace(/\.md$/, "")).sort());

    unsubscribeOne();
    await broker.dispatchRoomMention({ roomId: roomOne, agent: "kimi", text: "Second run." });
    expect(seenOne).toHaveLength(4); // no further deliveries after unsubscribe

    await broker.close();
  });

  it("forwards pending approvals to the room listener and clears them on terminal completion", async () => {
    const broker = makeBroker(["approval"]);
    const roomId = await makeRoom("Approval sub room", ["kimi"]);

    const approvals: { requestId: string; agent: string; method: string }[] = [];
    broker.onRoomApproval(roomId, (approval) => {
      approvals.push({ requestId: approval.requestId, agent: approval.agent, method: approval.method });
    });

    const dispatch = broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Approve?" });
    await waitFor(() => broker.hasPendingApproval(roomId, "kimi", "req-1"));

    expect(approvals).toEqual([{ requestId: "req-1", agent: "kimi", method: "confirm" }]);

    broker.respondToRoomApproval({ roomId, agent: "kimi", requestId: "req-1", response: { confirmed: true } });
    const outcome = await dispatch;
    expect(outcome.status).toBe("completed");
    expect(broker.hasPendingApproval(roomId, "kimi", "req-1")).toBe(false);
    expect(approvals).toHaveLength(1);
    await broker.close();
  });
});

describe("RoomBroker listener containment", () => {
  let root: string;
  let clients: FakeRoomClient[];
  let timers: ManualTimers;
  let nonceSeq: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-room-broker-contain-"));
    clients = [];
    timers = new ManualTimers();
    nonceSeq = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function makeBroker(behaviors: FakeBehavior[]): RoomBroker {
    return new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => {
        const client = new FakeRoomClient(behaviors[clients.length] ?? "complete");
        clients.push(client);
        return client;
      },
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
    });
  }

  it("contains a throwing event listener: the run still completes and healthy listeners receive every event", async () => {
    const broker = makeBroker(["complete"]);
    const room = await createRoom({
      vaultRoot: root,
      title: "Containment room",
      participants: ["kimi"],
      now: () => new Date("2026-08-02T17:00:00.000Z"),
    });
    const roomId = room.id;

    broker.onRoomEvent(roomId, () => {
      throw new Error("observer exploded");
    });
    const healthy: string[] = [];
    broker.onRoomEvent(roomId, (event) => {
      healthy.push(event.kind);
    });

    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Go." });
    expect(outcome.status).toBe("completed");
    expect(healthy).toEqual(["steward_message", "run_started", "agent_message", "run_finished"]);

    const events = await readEvents(root, roomId);
    expect(events).toHaveLength(4);
    await broker.close();
  });

  it("contains a throwing approval listener: a valid exact approval still completes the run", async () => {
    const broker = makeBroker(["approval"]);
    const room = await createRoom({
      vaultRoot: root,
      title: "Approval containment room",
      participants: ["kimi"],
      now: () => new Date("2026-08-02T17:00:00.000Z"),
    });
    const roomId = room.id;

    broker.onRoomApproval(roomId, () => {
      throw new Error("approval observer exploded");
    });
    const healthy: string[] = [];
    broker.onRoomApproval(roomId, (approval) => {
      healthy.push(approval.requestId);
    });

    const dispatch = broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Approve?" });
    await waitFor(() => broker.hasPendingApproval(roomId, "kimi", "req-1"));
    expect(healthy).toEqual(["req-1"]);

    broker.respondToRoomApproval({ roomId, agent: "kimi", requestId: "req-1", response: { confirmed: true } });
    const outcome = await dispatch;
    expect(outcome.status).toBe("completed");
    await broker.close();
  });
});

describe("RoomBroker handoff immutable causality", () => {
  let root: string;
  let clients: FakeRoomClient[];
  let timers: ManualTimers;
  let nonceSeq: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-room-handoff-chain-"));
    clients = [];
    timers = new ManualTimers();
    nonceSeq = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function makeBroker(runnable: string[], leadHandoff?: { to: string; text: string }): RoomBroker {
    return new RoomBroker({
      vaultRoot: root,
      runnableAgents: runnable,
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => {
        // First created client is the steward-addressed lead; it emits the
        // reserved handoff input request. Subsequent clients are workers.
        const client = new FakeRoomClient(clients.length === 0 && leadHandoff ? "handoff" : "complete");
        if (clients.length === 0 && leadHandoff) {
          client.handoffTo = leadHandoff.to;
          client.handoffText = leadHandoff.text;
        }
        clients.push(client);
        return client;
      },
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
    });
  }

  async function makeRoom(participants: string[]): Promise<string> {
    const room = await createRoom({
      vaultRoot: root,
      title: "Handoff room",
      participants,
      now: () => new Date("2026-08-02T17:00:00.000Z"),
    });
    return room.id;
  }

  function byKind(events: { content: string }[], kind: string): string[] {
    return events.filter((entry) => entry.content.includes(`kind: ${kind}`)).map((entry) => entry.content);
  }

  it("writes the immutable lead -> worker causality chain and returns the worker outcome to the lead tool", async () => {
    const broker = makeBroker(["kimi", "thor"], { to: "thor", text: "Summarize the report." });
    const roomId = await makeRoom(["kimi", "thor"]);

    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Lead task." });
    expect(outcome.status).toBe("completed");

    // Two isolated clients: lead kimi and worker thor.
    expect(clients).toHaveLength(2);
    const lead = clients[0]!;
    const worker = clients[1]!;
    expect(lead.handoffTo).toBe("thor");
    expect(worker.prompts[0]).toContain(roomId);
    expect(worker.prompts[0]).toContain("thor");
    expect(worker.prompts[0]).toContain("Summarize the report.");
    expect(worker.prompts[0]).toContain("kimi");

    // The lead received the structured worker outcome through its input request.
    expect(lead.handoffResults).toEqual([{ id: "handoff-1", status: "ok" }]);
    const leadValue = lead.responses.find((response) => response.id === "handoff-1")?.response;
    expect(leadValue).toBeDefined();
    if (leadValue && "value" in leadValue) {
      const parsed = parseHandoffResultValue(leadValue.value);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.result.status).toBe("ok");
        if (parsed.result.status === "ok") expect(parsed.result.reply).toContain("Hello room.");
      }
    }

    const events = await readEvents(root, roomId);
    // S, R_L, H, R_W, worker agent_message, worker run_finished, lead agent_message, lead run_finished
    expect(events).toHaveLength(8);

    const steward = byKind(events, "steward_message")[0] ?? "";
    expect(steward).toContain("addressed_agent: kimi");
    expect(steward).toContain("Lead task.");
    const rootId = outcome.stewardEventId;

    const handoffs = byKind(events, "agent_message").filter((content) => content.includes("addressed_agent: thor"));
    expect(handoffs).toHaveLength(1);
    const handoff = handoffs[0]!;
    expect(handoff).toContain("author: kimi");
    expect(handoff).toContain("addressed_agent: thor");
    expect(handoff).toContain("Summarize the report.");
    expect(handoff).toContain(`correlation_id: ${rootId}`);
    const handoffId = handoff.match(/id: ([^\n]+)/)?.[1]!;

    // Lead run_started correlates to the steward root S.
    const leadStarted = byKind(events, "run_started").find((content) => content.includes("agent 'kimi'")) ?? "";
    expect(leadStarted).toContain(`correlation_id: ${rootId}`);
    // Worker run_started correlates to the handoff event H, NOT the steward root.
    const workerStarted = byKind(events, "run_started").find((content) => content.includes("agent 'thor'")) ?? "";
    expect(workerStarted).toContain(`correlation_id: ${handoffId}`);
    expect(workerStarted).not.toContain(`correlation_id: ${rootId}`);

    // Worker reply + terminal correlate to H.
    const workerReply = byKind(events, "agent_message").find((content) => content.includes("author: thor")) ?? "";
    expect(workerReply).toContain("Hello room.");
    expect(workerReply).toContain(`correlation_id: ${handoffId}`);
    const workerFinished = byKind(events, "run_finished").find((content) => content.includes(`correlation_id: ${handoffId}`)) ?? "";
    expect(workerFinished).toContain("run_status: completed");

    // Lead reply + terminal correlate to the steward root S.
    const leadReply = byKind(events, "agent_message").find((content) => content.includes("Lead continued.")) ?? "";
    expect(leadReply).toContain("author: kimi");
    expect(leadReply).toContain("Lead continued.");
    expect(leadReply).not.toContain("addressed_agent");
    expect(leadReply).toContain(`correlation_id: ${rootId}`);
    const leadFinished = byKind(events, "run_finished").find((content) => content.includes(`correlation_id: ${rootId}`)) ?? "";
    expect(leadFinished).toContain("run_status: completed");
    expect(leadFinished).not.toContain("failure_kind");

    expect(broker.hasActiveRun(roomId, "kimi")).toBe(false);
    expect(broker.hasActiveRun(roomId, "thor")).toBe(false);
    await broker.close();
  });

  it("never leaks a reserved handoff input request into the room approval registry or notifications", async () => {
    const broker = makeBroker(["kimi", "thor"], { to: "thor", text: "help" });
    const roomId = await makeRoom(["kimi", "thor"]);

    const approvals: RoomApprovalNotification[] = [];
    broker.onRoomApproval(roomId, (approval) => approvals.push(approval));

    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Lead." });
    expect(outcome.status).toBe("completed");

    // The reserved handoff input request never registered as an approval.
    expect(broker.hasPendingApproval(roomId, "kimi", "handoff-1")).toBe(false);
    expect(approvals).toEqual([]);
    await broker.close();
  });
});

describe("RoomBroker handoff authorization and budgets", () => {
  let root: string;
  let clients: FakeRoomClient[];
  let timers: ManualTimers;
  let nonceSeq: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-room-handoff-authz-"));
    clients = [];
    timers = new ManualTimers();
    nonceSeq = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function makeRoom(participants: string[]): Promise<string> {
    const room = await createRoom({
      vaultRoot: root,
      title: "Authz room",
      participants,
      now: () => new Date("2026-08-02T17:00:00.000Z"),
    });
    return room.id;
  }

  /**
   * Build a broker whose first-created client is a handoff lead seeded with
   * the given sequence, and whose subsequent clients complete. Returns the
   * lead client for assertions.
   */
  function makeHandoffBroker(runnable: string[], sequence: { to: string; text: string }[]): RoomBroker {
    return new RoomBroker({
      vaultRoot: root,
      runnableAgents: runnable,
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => {
        let client: FakeRoomClient;
        if (clients.length === 0) {
          client = new FakeRoomClient("handoff");
          client.handoffSequence = sequence.map((entry, index) => ({ ...entry, requestId: `handoff-${index + 1}` }));
        } else {
          client = new FakeRoomClient("complete");
        }
        clients.push(client);
        return client;
      },
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
    });
  }

  function leadStatuses(lead: FakeRoomClient): string[] {
    return lead.handoffResults.map((result) => result.status);
  }

  it("rejects a handoff to a target not in the runnable set", async () => {
    const broker = makeHandoffBroker(["kimi", "thor"], [{ to: "ghost", text: "help" }]);
    const roomId = await makeRoom(["kimi", "ghost"]);

    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Lead." });
    expect(outcome.status).toBe("completed");
    expect(leadStatuses(clients[0]!)).toEqual(["rejected"]);
    expect(clients).toHaveLength(1);
    const events = await readEvents(root, roomId);
    expect(events.some((entry) => entry.content.includes("addressed_agent: ghost"))).toBe(false);
    await broker.close();
  });

  it("rejects a handoff to a runnable target that is not a room participant", async () => {
    const broker = makeHandoffBroker(["kimi", "thor", "dipu"], [{ to: "dipu", text: "help" }]);
    const roomId = await makeRoom(["kimi", "thor"]);

    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Lead." });
    expect(outcome.status).toBe("completed");
    expect(leadStatuses(clients[0]!)).toEqual(["rejected"]);
    expect(clients).toHaveLength(1);
    await broker.close();
  });

  it("rejects a self-handoff", async () => {
    const broker = makeHandoffBroker(["kimi", "thor"], [{ to: "kimi", text: "help me" }]);
    const roomId = await makeRoom(["kimi", "thor"]);

    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Lead." });
    expect(outcome.status).toBe("completed");
    expect(leadStatuses(clients[0]!)).toEqual(["rejected"]);
    expect(clients).toHaveLength(1);
    await broker.close();
  });

  it("rejects a handoff from a worker (depth limit): a depth-1 run cannot hand off again", async () => {
    // Lead kimi hands off to thor; worker thor tries to hand off back to kimi.
    const broker = new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi", "thor"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => {
        const client = new FakeRoomClient("handoff");
        if (clients.length === 0) {
          client.handoffSequence = [{ to: "thor", text: "lead to worker", requestId: "lead-handoff" }];
        } else {
          client.handoffSequence = [{ to: "kimi", text: "worker tries to hand off", requestId: "worker-handoff" }];
        }
        clients.push(client);
        return client;
      },
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
    });
    const roomId = await makeRoom(["kimi", "thor"]);

    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Lead." });
    expect(outcome.status).toBe("completed");

    const worker = clients[1]!;
    expect(worker.handoffResults).toEqual([{ id: "worker-handoff", status: "rejected" }]);
    // No grandchild was started: exactly two clients.
    expect(clients).toHaveLength(2);
    // No second handoff event (agent_message) targeting kimi from the worker.
    // (The root steward_message legitimately has addressed_agent: kimi.)
    const events = await readEvents(root, roomId);
    const workerHandoff = events.filter(
      (entry) => entry.content.includes("kind: agent_message") && entry.content.includes("addressed_agent: kimi"),
    );
    expect(workerHandoff).toHaveLength(0);
    await broker.close();
  });

  it("enforces the one-accepted-handoff-per-root budget for a distinct second target", async () => {
    // Lead accepts a handoff to thor, then attempts a second to dipu in the
    // SAME root. The repeat check passes (dipu unseen) but one-per-root fires.
    const broker = makeHandoffBroker(
      ["kimi", "thor", "dipu"],
      [
        { to: "thor", text: "first" },
        { to: "dipu", text: "second" },
      ],
    );
    const roomId = await makeRoom(["kimi", "thor", "dipu"]);

    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Lead." });
    expect(outcome.status).toBe("completed");
    // First accepted (ok), second rejected (one handoff already accepted).
    expect(leadStatuses(clients[0]!)).toEqual(["ok", "rejected"]);
    // Exactly one worker (thor) was started; dipu never started.
    expect(clients).toHaveLength(2);
    const events = await readEvents(root, roomId);
    expect(events.some((entry) => entry.content.includes("addressed_agent: thor"))).toBe(true);
    expect(events.some((entry) => entry.content.includes("addressed_agent: dipu"))).toBe(false);
    await broker.close();
  });

  it("enforces the no-repeat-pair budget for a repeated source-target pair", async () => {
    // Lead accepts a handoff to thor, then attempts the same pair again in the
    // SAME root. The repeat-pair check fires (pair already accepted).
    const broker = makeHandoffBroker(
      ["kimi", "thor"],
      [
        { to: "thor", text: "first" },
        { to: "thor", text: "second" },
      ],
    );
    const roomId = await makeRoom(["kimi", "thor"]);

    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Lead." });
    expect(outcome.status).toBe("completed");
    expect(leadStatuses(clients[0]!)).toEqual(["ok", "rejected"]);
    // Only the first thor worker ran; no second worker.
    expect(clients).toHaveLength(2);
    const events = await readEvents(root, roomId);
    // Exactly one handoff event (addressed thor) — the repeat wrote no second H.
    expect(events.filter((entry) => entry.content.includes("addressed_agent: thor"))).toHaveLength(1);
    await broker.close();
  });

  it("rejects a handoff when the target already has an active room run", async () => {
    // Thor already runs (hang). kimi's handoff to thor must be rejected.
    const broker = new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi", "thor"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => {
        let client: FakeRoomClient;
        if (clients.length === 0) {
          client = new FakeRoomClient("hang"); // thor active run
        } else {
          client = new FakeRoomClient("handoff");
          client.handoffSequence = [{ to: "thor", text: "to busy thor", requestId: "handoff-1" }];
        }
        clients.push(client);
        return client;
      },
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
    });
    const roomId = await makeRoom(["kimi", "thor"]);

    const thorDispatch = broker.dispatchRoomMention({ roomId, agent: "thor", text: "Thor active." });
    await waitFor(() => clients.length === 1 && (clients[0]?.prompts.length ?? 0) === 1);
    expect(broker.hasActiveRun(roomId, "thor")).toBe(true);

    const kimiOutcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Kimi lead." });
    expect(kimiOutcome.status).toBe("completed");
    expect(leadStatuses(clients[1]!)).toEqual(["rejected"]);
    // No worker run for thor was started by the handoff (thor already active).
    expect(clients).toHaveLength(2);

    await broker.close();
    await thorDispatch;
  });
});

describe("RoomBroker handoff child outcomes", () => {
  let root: string;
  let clients: FakeRoomClient[];
  let timers: ManualTimers;
  let nonceSeq: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-room-handoff-child-"));
    clients = [];
    timers = new ManualTimers();
    nonceSeq = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function makeBroker(workerBehavior: FakeBehavior): RoomBroker {
    return new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi", "thor"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => {
        let client: FakeRoomClient;
        if (clients.length === 0) {
          client = new FakeRoomClient("handoff");
          client.handoffSequence = [{ to: "thor", text: "help", requestId: "handoff-1" }];
        } else {
          client = new FakeRoomClient(workerBehavior);
        }
        clients.push(client);
        return client;
      },
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
    });
  }

  async function makeRoom(): Promise<string> {
    const room = await createRoom({
      vaultRoot: root,
      title: "Child outcome room",
      participants: ["kimi", "thor"],
      now: () => new Date("2026-08-02T17:00:00.000Z"),
    });
    return room.id;
  }

  function byKind(events: { content: string }[], kind: string): string[] {
    return events.filter((entry) => entry.content.includes(`kind: ${kind}`)).map((entry) => entry.content);
  }

  it("returns launch_failure to the lead when the child session cannot start (before child run_started)", async () => {
    const broker = makeBroker("start-fail");
    const roomId = await makeRoom();

    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Lead." });
    expect(outcome.status).toBe("completed");
    expect(clients[0]!.handoffResults).toEqual([{ id: "handoff-1", status: "failed" }]);
    const value = clients[0]!.responses.find((response) => response.id === "handoff-1")?.response;
    if (value && "value" in value) {
      const parsed = parseHandoffResultValue(value.value);
      if (parsed.ok && parsed.result.status === "failed") {
        expect(parsed.result.failureKind).toBe("launch_failure");
      } else {
        throw new Error("expected a failed launch_failure handoff result");
      }
    }
    const events = await readEvents(root, roomId);
    // Child never reached run_started; child terminal is launch_failure correlated to H.
    const handoff = byKind(events, "agent_message").find((content) => content.includes("addressed_agent: thor")) ?? "";
    const handoffId = handoff.match(/id: ([^\n]+)/)?.[1];
    expect(byKind(events, "run_started").some((content) => content.includes("agent 'thor'"))).toBe(false);
    const childFinished = byKind(events, "run_finished").find((content) => content.includes(`correlation_id: ${handoffId}`)) ?? "";
    expect(childFinished).toContain("failure_kind: launch_failure");
    await broker.close();
  });

  it("returns ambiguous to the lead when the child prompt is rejected after child run_started", async () => {
    const broker = makeBroker("prompt-fail");
    const roomId = await makeRoom();

    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Lead." });
    expect(outcome.status).toBe("completed");
    const value = clients[0]!.responses.find((response) => response.id === "handoff-1")?.response;
    if (value && "value" in value) {
      const parsed = parseHandoffResultValue(value.value);
      if (parsed.ok && parsed.result.status === "failed") {
        expect(parsed.result.failureKind).toBe("ambiguous");
      } else {
        throw new Error("expected a failed ambiguous handoff result");
      }
    } else {
      throw new Error("expected a handoff response");
    }
    const events = await readEvents(root, roomId);
    // Child DID reach run_started before failing.
    expect(byKind(events, "run_started").some((content) => content.includes("agent 'thor'"))).toBe(true);
    await broker.close();
  });

  it("returns timed_out to the lead when the child hangs", async () => {
    const broker = makeBroker("hang");
    const roomId = await makeRoom();

    const dispatch = broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Lead." });
    // Wait until the worker is running (child prompt sent).
    await waitFor(() => clients.length === 2 && (clients[1]?.prompts.length ?? 0) === 1);

    // Fire ONLY the child's run timeout (the last-registered timer); the
    // lead stays live so processHandoff can answer its input request.
    timers.fireLast();
    const outcome = await dispatch;
    expect(outcome.status).toBe("completed");
    expect(clients[0]!.handoffResults).toEqual([{ id: "handoff-1", status: "timed_out" }]);
    await broker.close();
  });
});

describe("RoomBroker handoff terminal cascade", () => {
  let root: string;
  let clients: FakeRoomClient[];
  let timers: ManualTimers;
  let nonceSeq: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-room-handoff-cascade-"));
    clients = [];
    timers = new ManualTimers();
    nonceSeq = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function byKind(events: { content: string }[], kind: string): string[] {
    return events.filter((entry) => entry.content.includes(`kind: ${kind}`)).map((entry) => entry.content);
  }

  async function makeRoom(): Promise<string> {
    const room = await createRoom({
      vaultRoot: root,
      title: "Cascade room",
      participants: ["kimi", "thor"],
      now: () => new Date("2026-08-02T17:00:00.000Z"),
    });
    return room.id;
  }

  /**
   * Lead is "handoff-hang" (stays blocked on the input response); the worker
   * "hang" child never completes. The cascade cancels only the child.
   */
  function makeCascadeBroker(): RoomBroker {
    return new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi", "thor"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => {
        let client: FakeRoomClient;
        if (clients.length === 0) {
          client = new FakeRoomClient("handoff-hang");
          client.handoffSequence = [{ to: "thor", text: "help", requestId: "handoff-1" }];
        } else {
          client = new FakeRoomClient("hang");
        }
        clients.push(client);
        return client;
      },
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
    });
  }

  async function startHandoffInFlight(): Promise<{ broker: RoomBroker; roomId: string; dispatch: Promise<unknown>; handoffId: string }> {
    const broker = makeCascadeBroker();
    const roomId = await makeRoom();
    const dispatch = broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Lead." });
    // Wait until the worker child is running.
    await waitFor(() => clients.length === 2 && (clients[1]?.prompts.length ?? 0) === 1);
    expect(broker.hasActiveRun(roomId, "thor")).toBe(true);
    const events = await readEvents(root, roomId);
    const handoff = byKind(events, "agent_message").find((content) => content.includes("addressed_agent: thor")) ?? "";
    const handoffId = handoff.match(/id: ([^\n]+)/)?.[1]!;
    return { broker, roomId, dispatch, handoffId };
  }

  it("source abort cancels only the exact live child with one terminal cancellation and no detached child", async () => {
    const { broker, roomId, dispatch, handoffId } = await startHandoffInFlight();

    const abortOutcome = await broker.abort(roomId, "kimi");
    expect(abortOutcome.status).toBe("cancelled");
    const outcome = await dispatch;
    expect((outcome as { status: string }).status).toBe("cancelled");

    const events = await readEvents(root, roomId);
    // Child terminal cancellation correlated to H, exactly one.
    const childCancelled = byKind(events, "run_cancelled").filter((content) => content.includes(`correlation_id: ${handoffId}`));
    expect(childCancelled).toHaveLength(1);
    expect(childCancelled[0]).toContain("run_status: cancelled");
    // Lead also cancelled.
    const leadCancelled = byKind(events, "run_cancelled").filter((content) => !content.includes(`correlation_id: ${handoffId}`));
    expect(leadCancelled).toHaveLength(1);
    // No detached child: no active runs remain.
    expect(broker.hasActiveRun(roomId, "kimi")).toBe(false);
    expect(broker.hasActiveRun(roomId, "thor")).toBe(false);
    // The child never got a run_finished (it was cancelled, not completed).
    expect(byKind(events, "run_finished").some((content) => content.includes(`correlation_id: ${handoffId}`))).toBe(false);
    await broker.close();
  });

  it("source timeout cancels the exact live child", async () => {
    const { broker, roomId, dispatch, handoffId } = await startHandoffInFlight();

    // Fire the lead's run timeout (the lead is the first run; both timeouts fire).
    timers.fireAll();
    const outcome = await dispatch;
    expect((outcome as { status: string }).status).toBe("timed_out");

    const events = await readEvents(root, roomId);
    // The child was cancelled (cascade), not left running.
    const childTerminal = byKind(events, "run_cancelled").filter((content) => content.includes(`correlation_id: ${handoffId}`));
    expect(childTerminal).toHaveLength(1);
    expect(broker.hasActiveRun(roomId, "thor")).toBe(false);
    await broker.close();
  });

  it("broker close cancels the exact live child and leaves no detached child", async () => {
    const { broker, roomId, dispatch, handoffId } = await startHandoffInFlight();

    await broker.close();
    const outcome = await dispatch;
    expect((outcome as { status: string }).status).toBe("cancelled");

    const events = await readEvents(root, roomId);
    const childCancelled = byKind(events, "run_cancelled").filter((content) => content.includes(`correlation_id: ${handoffId}`));
    expect(childCancelled).toHaveLength(1);
    expect(broker.hasActiveRun(roomId, "thor")).toBe(false);
    // Second close is idempotent: no new cancellation records.
    const count = events.length;
    await broker.close();
    expect((await readEvents(root, roomId)).length).toBe(count);
  });

  it("source client exit cancels the exact live child", async () => {
    const { broker, roomId, dispatch, handoffId } = await startHandoffInFlight();

    // The lead's Pi process exits mid-handoff.
    clients[0]!.emitExit();
    const outcome = await dispatch;
    // The lead settle kind is ambiguous (client exit), but the child must be
    // cancelled (cascade), leaving no detached child.
    expect((outcome as { status: string }).status).toBe("failed");

    const events = await readEvents(root, roomId);
    const childCancelled = byKind(events, "run_cancelled").filter((content) => content.includes(`correlation_id: ${handoffId}`));
    expect(childCancelled).toHaveLength(1);
    expect(broker.hasActiveRun(roomId, "thor")).toBe(false);
    await broker.close();
  });
});

describe("RoomBroker handoff malformed protocol and isolation", () => {
  let root: string;
  let clients: FakeRoomClient[];
  let timers: ManualTimers;
  let nonceSeq: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-room-handoff-malformed-"));
    clients = [];
    timers = new ManualTimers();
    nonceSeq = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function makeRoom(title: string, participants: string[]): Promise<string> {
    const room = await createRoom({
      vaultRoot: root,
      title,
      participants,
      now: () => new Date("2026-08-02T17:00:00.000Z"),
    });
    return room.id;
  }

  it("answers a malformed reserved handoff envelope with a bounded rejection and performs no dispatch", async () => {
    const broker = new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi", "thor"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => {
        const client = new FakeRoomClient("handoff");
        clients.push(client);
        return client;
      },
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
    });
    const roomId = await makeRoom("Malformed room", ["kimi", "thor"]);

    // Lead emits a reserved-title input request with a malformed placeholder.
    clients.length = 0;
    const lead = new FakeRoomClient("handoff");
    const broker2 = new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi", "thor"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => {
        clients.push(lead);
        return lead;
      },
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
    });
    void broker;
    lead.prompt = async (message: string) => {
      lead.prompts.push(message);
      lead.emit({
        type: "extension_ui_request",
        id: "handoff-1",
        method: "input",
        title: ROOM_HANDOFF_REQUEST_TITLE,
        placeholder: "{not valid json",
      });
    };
    // The lead completes normally after the rejection.
    lead.respondToUiRequest = (id: string, response: ExtensionUiResponse) => {
      lead.responses.push({ id, response });
      if ("value" in response) {
        const parsed = parseHandoffResultValue(response.value);
        lead.handoffResults.push({ id, status: parsed.ok ? parsed.result.status : "malformed" });
      }
      lead.emit({ type: "agent_end", messages: [] });
    };

    const outcome = await broker2.dispatchRoomMention({ roomId, agent: "kimi", text: "Lead." });
    expect(outcome.status).toBe("completed");
    expect(lead.handoffResults).toEqual([{ id: "handoff-1", status: "rejected" }]);
    // No worker dispatch, no H event.
    expect(clients).toHaveLength(1);
    const events = await readEvents(root, roomId);
    expect(events.some((entry) => entry.content.includes("addressed_agent: thor"))).toBe(false);
    await broker2.close();
  });

  it("keeps a handoff in one room fully isolated from another room and another agent", async () => {
    const broker = new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi", "thor", "dipu"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => {
        let client: FakeRoomClient;
        if (clients.length === 0) {
          client = new FakeRoomClient("handoff");
          client.handoffSequence = [{ to: "thor", text: "help in room one", requestId: "handoff-1" }];
        } else {
          client = new FakeRoomClient("complete");
        }
        clients.push(client);
        return client;
      },
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
    });
    const roomOne = await makeRoom("Room one", ["kimi", "thor"]);
    const roomTwo = await makeRoom("Room two", ["dipu"]);

    const outcomeOne = await broker.dispatchRoomMention({ roomId: roomOne, agent: "kimi", text: "Lead one." });
    expect(outcomeOne.status).toBe("completed");
    // Second room with a separate agent (dipu) — no handoff involvement.
    const outcomeTwo = await broker.dispatchRoomMention({ roomId: roomTwo, agent: "dipu", text: "Dipu task." });
    expect(outcomeTwo.status).toBe("completed");

    const eventsOne = await readEvents(root, roomOne);
    const eventsTwo = await readEvents(root, roomTwo);
    // Room one has the handoff chain; room two has only the ordinary steward chain.
    expect(eventsOne.some((entry) => entry.content.includes("addressed_agent: thor"))).toBe(true);
    expect(eventsTwo.some((entry) => entry.content.includes("addressed_agent: thor"))).toBe(false);
    for (const entry of eventsOne) {
      expect(entry.content).toContain(`room: ${roomOne}`);
      expect(entry.content).not.toContain(roomTwo);
    }
    for (const entry of eventsTwo) {
      expect(entry.content).toContain(`room: ${roomTwo}`);
      expect(entry.content).not.toContain(roomOne);
    }
    await broker.close();
  });
});

describe("RoomBroker handoff atomic reservation barriers (R2a review)", () => {
  let root: string;
  let clients: FakeRoomClient[];
  let timers: ManualTimers;
  let nonceSeq: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-room-handoff-barrier-"));
    clients = [];
    timers = new ManualTimers();
    nonceSeq = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function byKind(events: { content: string }[], kind: string): string[] {
    return events.filter((entry) => entry.content.includes(`kind: ${kind}`)).map((entry) => entry.content);
  }

  async function makeRoom(participants: string[] = ["kimi", "thor"]): Promise<string> {
    const room = await createRoom({
      vaultRoot: root,
      title: "Barrier room",
      participants,
      now: () => new Date("2026-08-02T17:00:00.000Z"),
    });
    return room.id;
  }

  /** Gate the Nth final-target link: suspend it until released. */
  function gateNthLink(n: number): { io: { linkNoClobber(t: string, target: string): Promise<void>; remove(p: string): Promise<void> }; hit: Promise<void>; release: () => void } {
    let releaseFn!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFn = resolve; });
    let hitFn!: () => void;
    const hit = new Promise<void>((resolve) => { hitFn = resolve; });
    let calls = 0;
    const io = {
      linkNoClobber: async (tempPath: string, targetPath: string) => {
        calls += 1;
        if (calls === n) {
          hitFn();
          await gate;
        }
        await link(tempPath, targetPath);
      },
      remove: async (p: string) => { await rm(p, { force: true }); },
    };
    return { io, hit, release: () => releaseFn() };
  }

  /** Make the Nth final-target link throw (simulate an H append IO failure). */
  function failNthLink(n: number, message: string): { linkNoClobber(t: string, target: string): Promise<void>; remove(p: string): Promise<void> } {
    let calls = 0;
    return {
      linkNoClobber: async (tempPath: string, targetPath: string) => {
        calls += 1;
        if (calls === n) {
          throw new Error(message);
        }
        await link(tempPath, targetPath);
      },
      remove: async (p: string) => { await rm(p, { force: true }); },
    };
  }

  function makeBroker(
    io?: { linkNoClobber(t: string, target: string): Promise<void>; remove(p: string): Promise<void> },
    leadBehavior: "handoff" | "handoff-hang" = "handoff-hang",
  ): RoomBroker {
    return new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi", "thor"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => {
        let client: FakeRoomClient;
        if (clients.length === 0) {
          client = new FakeRoomClient(leadBehavior);
          client.handoffSequence = [{ to: "thor", text: "help", requestId: "handoff-1" }];
        } else {
          client = new FakeRoomClient("hang");
        }
        clients.push(client);
        return client;
      },
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
      ...(io ? { io } : {}),
    });
  }

  it("parent abort while the H append is suspended leaves H plus exactly one correlated child cancellation and no child session/prompt", async () => {
    // Lead appends: steward_message(1), run_started(2), H(3). Gate link 3 (H).
    const { io, hit, release } = gateNthLink(3);
    const broker = makeBroker(io);
    const roomId = await makeRoom();

    const dispatch = broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Lead." });
    await hit; // H append is suspended; child thor is already reserved.
    expect(broker.hasActiveRun(roomId, "thor")).toBe(true); // pre-reserved child occupies the key

    const abortPromise = broker.abort(roomId, "kimi");
    release();
    await abortPromise;
    const outcome = await dispatch;
    expect((outcome as { status: string }).status).toBe("cancelled");

    const events = await readEvents(root, roomId);
    const handoffs = byKind(events, "agent_message").filter((content) => content.includes("addressed_agent: thor"));
    expect(handoffs).toHaveLength(1); // H exists
    const handoffId = handoffs[0]!.match(/id: ([^\n]+)/)?.[1]!;
    // Exactly one child run_cancelled correlated to H.
    const childCancelled = byKind(events, "run_cancelled").filter((content) => content.includes(`correlation_id: ${handoffId}`));
    expect(childCancelled).toHaveLength(1);
    // No child session start, no run_started, no prompt for thor.
    expect(byKind(events, "run_started").some((content) => content.includes("agent 'thor'"))).toBe(false);
    const worker = clients.find((client) => client !== clients[0]);
    expect(worker).toBeUndefined(); // no thor client was ever created
    // No detached child.
    expect(broker.hasActiveRun(roomId, "thor")).toBe(false);
    await broker.close();
  });

  it("parent close while the H append is suspended leaves H plus exactly one correlated child cancellation", async () => {
    const { io, hit, release } = gateNthLink(3);
    const broker = makeBroker(io);
    const roomId = await makeRoom();

    const dispatch = broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Lead." });
    await hit;
    const closePromise = broker.close();
    release();
    await closePromise;
    const outcome = await dispatch;
    expect((outcome as { status: string }).status).toBe("cancelled");

    const events = await readEvents(root, roomId);
    const handoffs = byKind(events, "agent_message").filter((content) => content.includes("addressed_agent: thor"));
    expect(handoffs).toHaveLength(1);
    const handoffId = handoffs[0]!.match(/id: ([^\n]+)/)?.[1]!;
    expect(byKind(events, "run_cancelled").filter((content) => content.includes(`correlation_id: ${handoffId}`))).toHaveLength(1);
    expect(byKind(events, "run_started").some((content) => content.includes("agent 'thor'"))).toBe(false);
    expect(broker.hasActiveRun(roomId, "thor")).toBe(false);
  });

  it("a concurrent attempt to start the same target while H is suspended is rejected and produces no orphan H", async () => {
    const { io, hit, release } = gateNthLink(3);
    const broker = makeBroker(io);
    const roomId = await makeRoom();

    const dispatch = broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Lead." });
    await hit; // child thor reserved, H suspended

    // Concurrent explicit mention for thor must be rejected (thor already occupied).
    await expect(broker.dispatchRoomMention({ roomId, agent: "thor", text: "Concurrent thor." })).rejects.toThrow("active");

    release();
    // Let the child complete: it is "hang" so abort the source to finish cleanly.
    await waitFor(() => clients.length === 2 && (clients[1]?.prompts.length ?? 0) === 1);
    await broker.abort(roomId, "kimi");
    await dispatch;

    const events = await readEvents(root, roomId);
    // H exists exactly once and the child ran (run_started for thor) — no orphan H.
    expect(byKind(events, "agent_message").filter((content) => content.includes("addressed_agent: thor"))).toHaveLength(1);
    expect(byKind(events, "run_started").some((content) => content.includes("agent 'thor'"))).toBe(true);
    // No steward_message for thor from the rejected concurrent mention.
    expect(byKind(events, "steward_message").filter((content) => content.includes("addressed_agent: thor"))).toHaveLength(0);
    // Only one thor client ever existed.
    expect(clients.filter((client) => client !== clients[0])).toHaveLength(1);
    await broker.close();
  });

  it("an H append failure releases the reservation with no leaked target key and no synthetic child record", async () => {
    const broker = makeBroker(failNthLink(3, "disk full (fake)"), "handoff");
    const roomId = await makeRoom();

    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Lead." });
    expect((outcome as { status: string }).status).toBe("completed"); // lead completed after the failed result

    // The reservation was released: no active run for thor.
    expect(broker.hasActiveRun(roomId, "thor")).toBe(false);
    const events = await readEvents(root, roomId);
    // No H event, no child run_started/run_cancelled, and no child run_finished.
    expect(byKind(events, "agent_message").filter((content) => content.includes("addressed_agent: thor"))).toHaveLength(0);
    expect(byKind(events, "run_started").some((content) => content.includes("agent 'thor'"))).toBe(false);
    expect(byKind(events, "run_cancelled")).toHaveLength(0);
    // Only the lead's run_finished exists (the lead completed after the failed result).
    expect(byKind(events, "run_finished")).toHaveLength(1);
    // The lead got a failed (ambiguous) result, not a hang.
    expect(clients[0]!.handoffResults).toEqual([{ id: "handoff-1", status: "failed" }]);
    await broker.close();
  });
});

describe("RoomBroker handoff bounded reply and budget lifecycle (R2a review)", () => {
  let root: string;
  let clients: FakeRoomClient[];
  let timers: ManualTimers;
  let nonceSeq: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-room-handoff-bound-"));
    clients = [];
    timers = new ManualTimers();
    nonceSeq = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function makeRoom(participants: string[] = ["kimi", "thor"]): Promise<string> {
    const room = await createRoom({
      vaultRoot: root,
      title: "Bound room",
      participants,
      now: () => new Date("2026-08-02T17:00:00.000Z"),
    });
    return room.id;
  }

  function makeBroker(workerBehavior: FakeBehavior = "complete"): RoomBroker {
    return new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi", "thor"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => {
        let client: FakeRoomClient;
        if (clients.length === 0) {
          client = new FakeRoomClient("handoff");
          client.handoffSequence = [{ to: "thor", text: "help", requestId: "handoff-1" }];
        } else {
          client = new FakeRoomClient(workerBehavior);
        }
        clients.push(client);
        return client;
      },
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
    });
  }

  it("truncates an oversized worker reply in the control result while keeping the immutable evidence intact", async () => {
    const broker = makeBroker("complete");
    const roomId = await makeRoom();

    // Make the worker emit a reply larger than the cap.
    const oversized = "R".repeat(ROOM_HANDOFF_MAX_REPLY_LENGTH + 2000);
    const brokerWithBigWorker = new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi", "thor"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => {
        let client: FakeRoomClient;
        if (clients.length === 0) {
          client = new FakeRoomClient("handoff");
          client.handoffSequence = [{ to: "thor", text: "help", requestId: "handoff-1" }];
        } else {
          client = new FakeRoomClient("hang");
          client.prompt = async (message: string) => {
            client.prompts.push(message);
            client.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: oversized } });
            client.emit({ type: "agent_end", messages: [] });
          };
        }
        clients.push(client);
        return client;
      },
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
    });
    void broker;

    const outcome = await brokerWithBigWorker.dispatchRoomMention({ roomId, agent: "kimi", text: "Lead." });
    expect(outcome.status).toBe("completed");

    // The control result reply is bounded to the cap with the marker.
    const lead = clients[0]!;
    const value = lead.responses.find((response) => response.id === "handoff-1")?.response;
    expect(value).toBeDefined();
    if (value && "value" in value) {
      const parsed = parseHandoffResultValue(value.value);
      expect(parsed.ok).toBe(true);
      if (parsed.ok && parsed.result.status === "ok") {
        expect(parsed.result.reply.length).toBeLessThanOrEqual(ROOM_HANDOFF_MAX_REPLY_LENGTH);
        expect(parsed.result.reply.endsWith(ROOM_HANDOFF_TRUNCATION_MARKER)).toBe(true);
      } else {
        throw new Error("expected an ok handoff result");
      }
    }

    // The immutable worker evidence keeps the FULL oversized reply.
    const events = await readEvents(root, roomId);
    const workerReply = events
      .map((entry) => entry.content)
      .find((content) => content.includes("kind: agent_message") && content.includes("author: thor"));
    expect(workerReply).toBeDefined();
    expect(workerReply).toContain("R".repeat(ROOM_HANDOFF_MAX_REPLY_LENGTH + 2000));
    expect(workerReply).not.toContain(ROOM_HANDOFF_TRUNCATION_MARKER);
    await brokerWithBigWorker.close();
  });

  it("clears accepted-handoff budget state once the root run reaches terminal finalization", async () => {
    const broker = makeBroker("complete");
    const roomId = await makeRoom();

    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Lead." });
    expect(outcome.status).toBe("completed");

    // The budget entry for this completed root was cleaned up.
    expect(broker.hasHandoffBudgetForRoot(outcome.stewardEventId)).toBe(false);
    await broker.close();
  });

  it("does not leak budget state across many completed roots", async () => {
    // Three sequential roots to the same lead; each accepts one handoff.
    // If cleanup failed, hasHandoffBudgetForRoot would stay true for old roots.
    const broker = new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi", "thor"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => {
        let client: FakeRoomClient;
        if (clients.length % 2 === 0) {
          client = new FakeRoomClient("handoff");
          client.handoffSequence = [{ to: "thor", text: "help", requestId: "handoff-1" }];
        } else {
          client = new FakeRoomClient("complete");
        }
        clients.push(client);
        return client;
      },
      now: () => new Date("2026-08-02T18:00:00.000Z"),
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
    });
    const roomId = await makeRoom();

    const rootIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: `Root ${index}.` });
      expect(outcome.status).toBe("completed");
      rootIds.push(outcome.stewardEventId);
    }
    for (const rootId of rootIds) {
      expect(broker.hasHandoffBudgetForRoot(rootId)).toBe(false);
    }
    await broker.close();
  });
});
