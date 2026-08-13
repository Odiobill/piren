import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoom } from "../src/rooms.js";
import { RoomBroker, type RoomRpcClient } from "../src/room-broker.js";
import { createConversation, appendConversationEvent, readConversationEvents } from "../src/conversations.js";
import { ConversationBroker, type ConversationRpcClient } from "../src/conversation-broker.js";
import type { GatewayFallbackPolicy } from "../src/model-fallback-gateway.js";
import type { ExtensionUiResponse, RpcEvent, RpcSpawnTarget } from "../src/gateway-rpc.js";

// TB6 — bounded room/conversation broker same-live-client model fallback
// (design §8 TB6, §4.2/§4.3, §5, §6.3, §7). Fake-client tests with an
// injected policy loader and durable vault event readers; no live Pi auth.
// The broker core resolves policy ONLY through the injected loader seam.

const POLICY: GatewayFallbackPolicy = {
  primaryModelId: "kimi-coding/k3",
  fallback: { ok: true, present: true, config: { autoSwitch: true, models: ["openai/gpt-4.1"] } },
};

function policyWith(models: string[], autoSwitch = true): GatewayFallbackPolicy {
  return { primaryModelId: "kimi-coding/k3", fallback: { ok: true, present: true, config: { autoSwitch, models } } };
}

const NO_PRIMARY: GatewayFallbackPolicy = {
  primaryModelId: null,
  fallback: { ok: true, present: true, config: { autoSwitch: true, models: ["openai/gpt-4.1"] } },
};

const MALFORMED: GatewayFallbackPolicy = {
  primaryModelId: "kimi-coding/k3",
  fallback: { ok: false, reason: "model.fallback.models must be an array." },
};

function errorRecord(): Record<string, unknown> {
  return { role: "assistant", content: [], stopReason: "error", errorMessage: "provider error (401)" };
}

/** Settled zero-side-effect provider-error script (eligible). */
function providerErrorEvents(retryExhausted: boolean): RpcEvent[] {
  const record = errorRecord();
  const events: RpcEvent[] = [{ type: "agent_start" }];
  if (retryExhausted) {
    events.push(
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "529 overloaded" },
      { type: "auto_retry_end", attempt: 3, maxAttempts: 3, success: false, finalError: "529 overloaded" },
    );
  }
  events.push(
    { type: "message_start", message: record },
    { type: "message_end", message: record },
    { type: "turn_end", message: { ...record, toolResults: [] } },
    { type: "agent_end", messages: [record], willRetry: false },
    { type: "agent_settled" },
  );
  return events;
}

/** Settled but contaminated script (text delta before the error). */
function contaminatedEvents(): RpcEvent[] {
  const record = errorRecord();
  return [
    { type: "agent_start" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial" } },
    { type: "message_start", message: record },
    { type: "message_end", message: record },
    { type: "turn_end", message: { ...record, toolResults: [] } },
    { type: "agent_end", messages: [record], willRetry: false },
    { type: "agent_settled" },
  ];
}

/** Normal completed run with one text delta. */
function normalEvents(delta: string): RpcEvent[] {
  return [
    { type: "agent_start" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } },
    { type: "agent_end", messages: [], willRetry: false },
    { type: "agent_settled" },
  ];
}

/** Scripted fake client satisfying both broker client surfaces. */
class ScriptedClient {
  prompts: string[] = [];
  setModelCalls: Array<{ provider: string; modelId: string }> = [];
  /** Event scripts consumed in order, one per prompt. */
  scripts: RpcEvent[][] = [];
  rejectSetModelIds: string[] = [];
  hasSetModel = true;
  /** When set, setModel awaits this gate before resolving/rejecting. */
  setModelGate: Promise<void> | null = null;
  started = 0;
  stopped = 0;
  aborted = 0;
  /** P5: recorded Pi RPC steer messages (facade requirement). */
  steers: string[] = [];
  respondToUiCalls: Array<{ id: string; response: ExtensionUiResponse }> = [];
  private listeners: Array<(event: RpcEvent) => void> = [];
  private exitListeners: Array<() => void> = [];

  async start(): Promise<void> {
    this.started += 1;
  }

  /** P5: Pi RPC steer — records the message and acks (facade requirement). */
  async steer(message: string): Promise<void> {
    this.steers.push(message);
  }

  async stop(): Promise<void> {
    this.stopped += 1;
  }

  async abort(): Promise<void> {
    this.aborted += 1;
    // Real Pi emits agent_end then agent_settled on abort; for the broker
    // these are STALE events after the run settled and must be ignored.
    this.emit({ type: "agent_end", messages: [] });
    this.emit({ type: "agent_settled" });
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
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  onExit(listener: () => void): () => void {
    this.exitListeners.push(listener);
    return () => {
      this.exitListeners = this.exitListeners.filter((l) => l !== listener);
    };
  }

  respondToUiRequest(id: string, response: ExtensionUiResponse): void {
    this.respondToUiCalls.push({ id, response });
  }

  emit(event: RpcEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  emitExit(): void {
    for (const listener of [...this.exitListeners]) listener();
  }

  async prompt(message: string): Promise<void> {
    this.prompts.push(message);
    const script = this.scripts.shift() ?? [];
    for (const event of script) this.emit(event);
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    if (this.setModelGate !== null) await this.setModelGate;
    this.setModelCalls.push({ provider, modelId });
    if (!this.hasSetModel) throw new Error("RPC client does not support set_model");
    if (this.rejectSetModelIds.includes(`${provider}/${modelId}`)) throw new Error("model not found");
    this.emit({ type: "model_changed", model: { provider, id: modelId } });
    return { provider, modelId };
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
}

let root: string;
let nonceSeq: number;
const NOW = new Date("2026-08-06T10:00:00.000Z");
let clockMs = 0;
function tick(): Date {
  clockMs += 1;
  return new Date(NOW.getTime() + clockMs);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-broker-fallback-"));
  nonceSeq = 0;
  clockMs = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function readRoomEvents(roomId: string): Promise<string[]> {
  const dir = join(root, "collaboration", "rooms", roomId, "events");
  const names = (await readdir(dir)).sort();
  return Promise.all(names.map(async (name) => readFile(join(dir, name), "utf8")));
}

async function readConversationEventBodies(conversationId: string): Promise<string[]> {
  const events = await readConversationEvents({ vaultRoot: root, conversationId });
  return events.map((event) => event.body);
}

async function makeRoom(participants: string[] = ["kimi"]): Promise<string> {
  const room = await createRoom({ vaultRoot: root, title: "Fallback room", participants, now: tick });
  return room.id;
}

async function makeConversation(audience: string[] = ["zai"], text = "Hello @zai"): Promise<string> {
  const conversation = await createConversation({ vaultRoot: root, text, audience, now: tick });
  return conversation.id;
}

async function makeStewardEvent(conversationId: string, text: string): Promise<string> {
  const event = await appendConversationEvent({
    vaultRoot: root,
    conversationId,
    kind: "steward_message",
    authorKind: "steward",
    author: "steward",
    body: text,
    mentions: ["zai"],
    now: tick,
    nonce: () => `s${++nonceSeq}`,
  });
  return event.id;
}

interface RoomFixture {
  broker: RoomBroker;
  client: ScriptedClient;
  timers: ManualTimers;
  loaderCalls: string[];
}

function makeRoomBroker(options?: { runnableAgents?: string[]; policy?: GatewayFallbackPolicy }): RoomFixture {
  const client = new ScriptedClient();
  const timers = new ManualTimers();
  const loaderCalls: string[] = [];
  const loader = async (agent: string): Promise<GatewayFallbackPolicy> => {
    loaderCalls.push(agent);
    return options?.policy ?? POLICY;
  };
  const broker = new RoomBroker({
    vaultRoot: root,
    runnableAgents: options?.runnableAgents ?? ["kimi"],
    targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
    clientFactory: () => client,
    now: tick,
    nonce: () => `n${++nonceSeq}`,
    timers,
    runTimeoutMs: 60_000,
    fallbackPolicyLoader: loader,
  });
  return { broker, client, timers, loaderCalls };
}

describe("RoomBroker TB6 model fallback", () => {
  it("eligible provider_error_other rotates once on the same isolated client and persists ordered durable events", async () => {
    const { broker, client, loaderCalls } = makeRoomBroker();
    client.scripts = [providerErrorEvents(false), normalEvents("Fbk openai/gpt-4.1")];
    const roomId = await makeRoom(["kimi"]);
    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Please review the vault." });

    expect(outcome.status).toBe("completed");
    // Policy is resolved through the injected per-agent loader seam.
    expect(loaderCalls).toEqual(["kimi"]);
    // Same isolated client: exactly one switch + one handoff re-prompt.
    expect(client.setModelCalls).toEqual([{ provider: "openai", modelId: "gpt-4.1" }]);
    expect(client.prompts).toHaveLength(2);
    expect(client.prompts[1]).toContain("[model fallback:");
    expect(client.prompts[1]).toContain("Please review the vault.");

    const events = await readRoomEvents(roomId);
    const kinds = events.map((content) => /^kind: (.+)$/m.exec(content)?.[1] ?? "");
    expect(kinds).toEqual(["steward_message", "run_started", "model_fallback", "agent_message", "run_finished"]);
    const fallback = events.find((content) => content.includes("model_fallback")) ?? "";
    expect(fallback).toContain("kimi-coding/k3");
    expect(fallback).toContain("provider_error_other");
    expect(fallback).toContain("openai/gpt-4.1");
    expect(fallback).not.toContain("401");
    expect(fallback).not.toContain("provider error (401)");
    // No raw error text or secrets anywhere in the durable event surface.
    for (const content of events) {
      expect(content).not.toContain("401");
      expect(content).not.toMatch(/api[_-]?key|secret|token/i);
    }
    const finished = events[events.length - 1] ?? "";
    expect(finished).toContain("run_status: completed");
  });

  it("eligible transient-exhausted rotates with its honest category", async () => {
    const client = new ScriptedClient();
    client.scripts = [providerErrorEvents(true), normalEvents("Fbk openai/gpt-4.1")];
    const broker = new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => client,
      now: tick,
      nonce: () => `n${++nonceSeq}`,
      timers: new ManualTimers(),
      runTimeoutMs: 60_000,
      fallbackPolicyLoader: async () => POLICY,
    });
    const roomId = await makeRoom(["kimi"]);
    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Review it." });
    expect(outcome.status).toBe("completed");
    const events = await readRoomEvents(roomId);
    const fallback = events.find((content) => content.includes("model_fallback")) ?? "";
    expect(fallback).toContain("provider_error_transient_exhausted");
  });

  it("multi-fallback: first set_model rejected → durable unavailable evidence + next candidate, no extra prompt", async () => {
    const client = new ScriptedClient();
    client.scripts = [providerErrorEvents(false), normalEvents("Fbk openai/gpt-4.1")];
    client.rejectSetModelIds = ["bogus/x"];
    const broker = new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => client,
      now: tick,
      nonce: () => `n${++nonceSeq}`,
      timers: new ManualTimers(),
      runTimeoutMs: 60_000,
      fallbackPolicyLoader: async () => policyWith(["bogus/x", "openai/gpt-4.1"]),
    });
    const roomId = await makeRoom(["kimi"]);
    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Review it." });

    expect(outcome.status).toBe("completed");
    expect(client.setModelCalls).toEqual([
      { provider: "bogus", modelId: "x" },
      { provider: "openai", modelId: "gpt-4.1" },
    ]);
    // Exactly TWO prompts: the original plus ONE handoff re-prompt on the
    // successful fallback; the rejected model never re-ran the request.
    expect(client.prompts).toHaveLength(2);

    const events = await readRoomEvents(roomId);
    const kinds = events.map((content) => /^kind: (.+)$/m.exec(content)?.[1] ?? "");
    // attempt x, unavailable x, attempt gpt-4.1 — no extra steward/run_started.
    expect(kinds.filter((k) => k === "model_fallback")).toHaveLength(3);
    expect(kinds.filter((k) => k === "steward_message")).toHaveLength(1);
    expect(kinds.filter((k) => k === "run_started")).toHaveLength(1);
    const unavailable = events.find((content) => content.includes("unavailable")) ?? "";
    expect(unavailable).toContain("bogus/x");
    expect(unavailable).not.toContain("401");
  });

  it("terminal exhaustion → exactly one run_finished failed provider_error with safe bounded evidence", async () => {
    const client = new ScriptedClient();
    client.scripts = [providerErrorEvents(false)];
    client.rejectSetModelIds = ["bogus/x", "bogus/y"];
    const broker = new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => client,
      now: tick,
      nonce: () => `n${++nonceSeq}`,
      timers: new ManualTimers(),
      runTimeoutMs: 60_000,
      fallbackPolicyLoader: async () => policyWith(["bogus/x", "bogus/y"]),
    });
    const roomId = await makeRoom(["kimi"]);
    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Review it." });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.failureKind).toBe("provider_error");

    // No loop: the original prompt ran exactly once, never re-promoted.
    expect(client.prompts).toEqual([expect.stringContaining("Steward request:")]);
    expect(client.setModelCalls).toEqual([
      { provider: "bogus", modelId: "x" },
      { provider: "bogus", modelId: "y" },
    ]);

    const events = await readRoomEvents(roomId);
    const kinds = events.map((content) => /^kind: (.+)$/m.exec(content)?.[1] ?? "");
    expect(kinds.filter((k) => k === "run_finished")).toHaveLength(1);
    const terminal = events[events.length - 1] ?? "";
    expect(terminal).toContain("run_status: failed");
    expect(terminal).toContain("failure_kind: provider_error");
    expect(terminal).toContain("kimi-coding/k3");
    expect(terminal).toContain("2 fallback attempt(s)");
    // The fixed terminal wording mentions "a provider error" by design; the
    // raw errorMessage content and status text must never leak.
    expect(terminal).not.toContain("provider error (401)");
    expect(terminal).not.toContain("401");
    expect(terminal).not.toMatch(/api[_-]?key|secret|token/i);
  });

  it("contaminated run never falls back: existing completed terminal semantics, no model_fallback", async () => {
    const client = new ScriptedClient();
    client.scripts = [contaminatedEvents()];
    const broker = new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => client,
      now: tick,
      nonce: () => `n${++nonceSeq}`,
      timers: new ManualTimers(),
      runTimeoutMs: 60_000,
      fallbackPolicyLoader: async () => POLICY,
    });
    const roomId = await makeRoom(["kimi"]);
    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Review it." });

    expect(outcome.status).toBe("completed");
    expect(client.setModelCalls).toEqual([]);
    expect(client.prompts).toHaveLength(1);
    const events = await readRoomEvents(roomId);
    expect(events.some((content) => content.includes("model_fallback"))).toBe(false);
  });

  it("run that never settles + timeout stays timed_out with no fallback", async () => {
    const client = new ScriptedClient();
    client.scripts = [[{ type: "agent_start" }, { type: "agent_end", messages: [], willRetry: false }]];
    const timers = new ManualTimers();
    const broker = new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => client,
      now: tick,
      nonce: () => `n${++nonceSeq}`,
      timers,
      runTimeoutMs: 60_000,
      fallbackPolicyLoader: async () => POLICY,
    });
    const roomId = await makeRoom(["kimi"]);
    const dispatch = broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Review it." });
    // Give the async dispatch time to reach the pending state, then fire the
    // run timeout.
    await new Promise((resolve) => setTimeout(resolve, 20));
    timers.fireAll();
    const outcome = await dispatch;

    expect(outcome.status).toBe("timed_out");
    expect(client.setModelCalls).toEqual([]);
    const events = await readRoomEvents(roomId);
    expect(events.some((content) => content.includes("model_fallback"))).toBe(false);
  });

  it("prompt rejection stays ambiguous and launch failure stays launch_failure", async () => {
    const rejectClient = new ScriptedClient();
    rejectClient.scripts = [];
    rejectClient.prompt = async (message: string) => {
      rejectClient.prompts.push(message);
      throw new Error("prompt rejected (fake)");
    };
    const broker = new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => rejectClient,
      now: tick,
      nonce: () => `n${++nonceSeq}`,
      timers: new ManualTimers(),
      runTimeoutMs: 60_000,
      fallbackPolicyLoader: async () => POLICY,
    });
    const roomId = await makeRoom(["kimi"]);
    const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Review it." });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.failureKind).toBe("ambiguous");
    expect(rejectClient.setModelCalls).toEqual([]);
  });

  it("client exit stays ambiguous with no fallback", async () => {
    const client = new ScriptedClient();
    client.scripts = [[{ type: "agent_start" }]];
    const broker = new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => client,
      now: tick,
      nonce: () => `n${++nonceSeq}`,
      timers: new ManualTimers(),
      runTimeoutMs: 60_000,
      fallbackPolicyLoader: async () => POLICY,
    });
    const roomId = await makeRoom(["kimi"]);
    const dispatch = broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Review it." });
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.emitExit();
    const outcome = await dispatch;
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.failureKind).toBe("ambiguous");
    expect(client.setModelCalls).toEqual([]);
  });

  it("abort during a delayed set_model cancels the pending handoff re-prompt", async () => {
    const client = new ScriptedClient();
    client.scripts = [providerErrorEvents(false)];
    let releaseGate!: () => void;
    client.setModelGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const broker = new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => client,
      now: tick,
      nonce: () => `n${++nonceSeq}`,
      timers: new ManualTimers(),
      runTimeoutMs: 60_000,
      fallbackPolicyLoader: async () => POLICY,
    });
    const roomId = await makeRoom(["kimi"]);
    const dispatch = broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Review it." });
    // Wait until the rotation is inside setModel (gated), then abort.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const abortOutcome = await broker.abort(roomId, "kimi");
    expect(abortOutcome.status).toBe("cancelled");
    releaseGate();
    const outcome = await dispatch;

    // The abort won: run_cancelled terminal, and NO handoff re-prompt was
    // issued after the abort (only the original prompt ever ran).
    expect(outcome.status).toBe("cancelled");
    expect(client.prompts).toHaveLength(1);
    const events = await readRoomEvents(roomId);
    const kinds = events.map((content) => /^kind: (.+)$/m.exec(content)?.[1] ?? "");
    expect(kinds.filter((k) => k === "run_finished")).toHaveLength(0);
    expect(kinds.filter((k) => k === "run_cancelled")).toHaveLength(1);
  });

  it("absent/malformed/disabled/no-primary policy stays inert", async () => {
    for (const policy of [NO_PRIMARY, MALFORMED, policyWith(["openai/gpt-4.1"], false)]) {
      const client = new ScriptedClient();
      client.scripts = [providerErrorEvents(false)];
      const broker = new RoomBroker({
        vaultRoot: root,
        runnableAgents: ["kimi"],
        targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
        clientFactory: () => client,
        now: tick,
        nonce: () => `n${++nonceSeq}`,
        timers: new ManualTimers(),
        runTimeoutMs: 60_000,
        fallbackPolicyLoader: async () => policy,
      });
      const roomId = await makeRoom(["kimi"]);
      const outcome = await broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Review it." });
      expect(outcome.status).toBe("completed");
      expect(client.setModelCalls).toEqual([]);
      expect(client.prompts).toHaveLength(1);
      const events = await readRoomEvents(roomId);
      expect(events.some((content) => content.includes("model_fallback"))).toBe(false);
    }
  });

  it("room approval registered before settlement stays answerable while the rotation decision is in flight", async () => {
    const client = new ScriptedClient();
    // Primary run: an approval request then a settled provider error. The
    // approval request is itself a side effect, so the classifier correctly
    // marks the outcome ambiguous (no fallback) — what matters is that the
    // approval stays registered and answerable while the broker is deciding.
    // The policy-loader gate stalls the decision so the pending approval is
    // observed and answered while the run is still unsettled.
    client.scripts = [
      [
        { type: "agent_start" },
        { type: "extension_ui_request", id: "req-1", method: "confirm", title: "Approve?" },
        ...providerErrorEvents(false).slice(1),
      ],
    ];
    let releaseGate!: () => void;
    const policyGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const broker = new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => client,
      now: tick,
      nonce: () => `n${++nonceSeq}`,
      timers: new ManualTimers(),
      runTimeoutMs: 60_000,
      fallbackPolicyLoader: async () => {
        await policyGate;
        return POLICY;
      },
    });
    const roomId = await makeRoom(["kimi"]);
    const dispatch = broker.dispatchRoomMention({ roomId, agent: "kimi", text: "Review it." });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The run is still unsettled (rotation decision in flight) and the
    // approval is answerable; then the contaminated outcome settles completed
    // with NO fallback and clears the resolved approval.
    expect(broker.hasPendingApproval(roomId, "kimi", "req-1")).toBe(true);
    broker.respondToRoomApproval({ roomId, agent: "kimi", requestId: "req-1", response: { confirmed: true } });
    releaseGate();
    const outcome = await dispatch;
    expect(outcome.status).toBe("completed");
    expect(client.respondToUiCalls).toEqual([{ id: "req-1", response: { confirmed: true } }]);
    // The contaminated run never fell back.
    expect(client.setModelCalls).toEqual([]);
    expect(client.prompts).toHaveLength(1);
  });

  it("handoff preserves the original multiline prompt verbatim; durable bodies carry no raw error text", async () => {
    const client = new ScriptedClient();
    client.scripts = [providerErrorEvents(false), normalEvents("Fbk openai/gpt-4.1")];
    const broker = new RoomBroker({
      vaultRoot: root,
      runnableAgents: ["kimi"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => client,
      now: tick,
      nonce: () => `n${++nonceSeq}`,
      timers: new ManualTimers(),
      runTimeoutMs: 60_000,
      fallbackPolicyLoader: async () => POLICY,
    });
    const roomId = await makeRoom(["kimi"]);
    const text = "Line one\n\nLine two with details.\n1. First.\n2. Second.";
    await broker.dispatchRoomMention({ roomId, agent: "kimi", text });
    const handoff = client.prompts[1] ?? "";
    expect(handoff.endsWith(text)).toBe(true);
    expect(handoff).not.toContain("provider error (401)");
    expect(handoff).not.toContain("401");
    const events = await readRoomEvents(roomId);
    for (const content of events) {
      expect(content).not.toContain("401");
      expect(content).not.toMatch(/api[_-]?key|secret|token/i);
    }
  });
});

describe("ConversationBroker TB6 model fallback", () => {
  function makeConversationBroker(client: ScriptedClient, policy: GatewayFallbackPolicy): ConversationBroker {
    return new ConversationBroker({
      vaultRoot: root,
      runnableAgents: ["zai"],
      targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
      clientFactory: () => client,
      now: tick,
      nonce: () => `n${++nonceSeq}`,
      timers: new ManualTimers(),
      runTimeoutMs: 60_000,
      fallbackPolicyLoader: async () => policy,
    });
  }

  it("eligible provider_error_other rotates once on the same isolated client with durable evidence", async () => {
    const client = new ScriptedClient();
    client.scripts = [providerErrorEvents(false), normalEvents("Fbk openai/gpt-4.1")];
    const broker = makeConversationBroker(client, POLICY);
    const conversationId = await makeConversation();
    const stewardEventId = await makeStewardEvent(conversationId, "Please review @zai");
    const outcome = await broker.dispatchConversationMention({
      conversationId,
      agent: "zai",
      text: "Please review",
      stewardEventId,
      priorEvents: [],
    });

    expect(outcome.status).toBe("completed");
    expect(client.setModelCalls).toEqual([{ provider: "openai", modelId: "gpt-4.1" }]);
    expect(client.prompts).toHaveLength(2);
    expect(client.prompts[1]).toContain("[model fallback:");
    const bodies = await readConversationEventBodies(conversationId);
    expect(bodies.filter((body) => body.startsWith("Model ")).length).toBe(1);
    expect(bodies.some((body) => body.includes("unavailable"))).toBe(false);
    for (const body of bodies) {
      expect(body).not.toContain("401");
      expect(body).not.toContain("provider error (401)");
    }
  });

  it("terminal exhaustion → exactly one run_finished failed provider_error, no loop", async () => {
    const client = new ScriptedClient();
    client.scripts = [providerErrorEvents(false)];
    client.rejectSetModelIds = ["bogus/x"];
    const broker = makeConversationBroker(client, policyWith(["bogus/x"]));
    const conversationId = await makeConversation();
    const stewardEventId = await makeStewardEvent(conversationId, "Please review @zai");
    const outcome = await broker.dispatchConversationMention({
      conversationId,
      agent: "zai",
      text: "Please review",
      stewardEventId,
      priorEvents: [],
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.failureKind).toBe("provider_error");
    expect(client.prompts).toHaveLength(1);
    const records = await readConversationEvents({ vaultRoot: root, conversationId });
    const finished = records.filter((event) => event.kind === "run_finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]?.runStatus).toBe("failed");
    expect(finished[0]?.failureKind).toBe("provider_error");
    expect(finished[0]?.body).toContain("kimi-coding/k3");
    expect(finished[0]?.body).not.toContain("401");
  });

  it("abort during a delayed set_model cancels the pending handoff re-prompt", async () => {
    const client = new ScriptedClient();
    client.scripts = [providerErrorEvents(false)];
    let releaseGate!: () => void;
    client.setModelGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const broker = makeConversationBroker(client, POLICY);
    const conversationId = await makeConversation();
    const stewardEventId = await makeStewardEvent(conversationId, "Please review @zai");
    const dispatch = broker.dispatchConversationMention({
      conversationId,
      agent: "zai",
      text: "Please review",
      stewardEventId,
      priorEvents: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await broker.close();
    releaseGate();
    const outcome = await dispatch;

    expect(outcome.status).toBe("cancelled");
    expect(client.prompts).toHaveLength(1);
    const records = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(records.filter((event) => event.kind === "run_cancelled")).toHaveLength(1);
    expect(records.filter((event) => event.kind === "run_finished")).toHaveLength(0);
  });

  it("P6: inert no-primary policy keeps rotation inert but records the truthful provider_error terminal", async () => {
    const client = new ScriptedClient();
    client.scripts = [providerErrorEvents(false)];
    const broker = makeConversationBroker(client, NO_PRIMARY);
    const conversationId = await makeConversation();
    const stewardEventId = await makeStewardEvent(conversationId, "Please review @zai");
    const outcome = await broker.dispatchConversationMention({
      conversationId,
      agent: "zai",
      text: "Please review",
      stewardEventId,
      priorEvents: [],
    });
    // P6: no fallback continuation for a zero-side-effect provider error is a
    // truthful failed/provider_error terminal, never "completed". Rotation
    // semantics stay inert: no set_model, no re-prompt, no Model- evidence.
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.failureKind).toBe("provider_error");
    expect(client.setModelCalls).toEqual([]);
    expect(client.prompts).toHaveLength(1);
    expect(client.respondToUiCalls).toEqual([]);
    const bodies = await readConversationEventBodies(conversationId);
    expect(bodies.some((body) => body.startsWith("Model "))).toBe(false);
    expect(bodies.at(-1)).toBe("Run ended with a provider error.");
  });
});
