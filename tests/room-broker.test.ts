import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoom } from "../src/rooms.js";
import type { ExtensionUiResponse, RpcEvent, RpcSpawnTarget } from "../src/gateway-rpc.js";
import { RoomBroker, type RoomRpcClient } from "../src/room-broker.js";

type FakeBehavior = "complete" | "empty" | "hang" | "prompt-fail" | "start-fail" | "exit-mid-run" | "approval";

class FakeRoomClient implements RoomRpcClient {
  started = 0;
  stopped = 0;
  aborted = 0;
  prompts: string[] = [];
  responses: { id: string; response: ExtensionUiResponse }[] = [];
  private listeners: Array<(event: RpcEvent) => void> = [];
  private exitListeners: Array<() => void> = [];

  constructor(public behavior: FakeBehavior) {}

  async start(): Promise<void> {
    this.started += 1;
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
    }
  }

  respondToUiRequest(id: string, response: ExtensionUiResponse): void {
    this.responses.push({ id, response });
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
    expect(clients[0]?.prompts[0]).toContain(roomOne);
    expect(clients[1]?.prompts[0]).toContain(roomTwo);

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
