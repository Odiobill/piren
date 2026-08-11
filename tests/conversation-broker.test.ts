import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversation, appendConversationEvent, readConversation, readConversationEvents, transitionConversationLifecycle, acquireAudienceLock } from "../src/conversations.js";
import type { RpcEvent, RpcSpawnTarget, ExtensionUiResponse } from "../src/gateway-rpc.js";
import {
  ConversationBroker,
  parseConversationApprovalResponse,
  type ConversationApprovalNotification,
  type ConversationRpcClient,
  type ConversationDispatchOutcome,
} from "../src/conversation-broker.js";

type FakeBehavior =
  | "complete"
  | "empty"
  | "hang"
  | "end-only"
  | "maintenance-settle"
  | "prompt-fail"
  | "start-fail"
  | "exit-mid-run"
  | "with-text"
  | "approval"
  | "approval-hang";

class FakeConversationClient implements ConversationRpcClient {
  started = 0;
  stopped = 0;
  aborted = 0;
  prompts: string[] = [];
  /** respondToUiRequest calls recorded for approval tests. */
  responses: { id: string; response: ExtensionUiResponse }[] = [];
  /** Pi request id emitted by approval behaviors (fixed for deterministic keys). */
  approvalRequestId = "req-1";
  /** Pi UI method emitted by approval behaviors. */
  approvalMethod = "confirm";
  /** Optional barrier awaited inside start() (cancellation-during-init tests). */
  startBarrier: Promise<void> | undefined;
  private listeners: Array<(event: RpcEvent) => void> = [];
  private exitListeners: Array<() => void> = [];

  constructor(public behavior: FakeBehavior) {}

  async start(): Promise<void> {
    if (this.startBarrier !== undefined) {
      await this.startBarrier;
    }
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

  async prompt(message: string): Promise<void> {
    this.prompts.push(message);
    if (this.behavior === "prompt-fail") {
      throw new Error("prompt failed (fake)");
    }
    if (this.behavior === "hang") {
      return; // never emits agent_settled; timeout settles the run
    }
    if (this.behavior === "exit-mid-run") {
      for (const listener of [...this.exitListeners]) listener();
      return;
    }
    if (this.behavior === "with-text") {
      this.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Visible agent reply." },
      });
    }
    if (this.behavior === "end-only") {
      // TB0/G1: agent_end alone is NEVER terminal; the run stays active until
      // agent_settled arrives or the broker timeout settles it conservatively.
      this.emit({ type: "agent_end", messages: [] });
      return;
    }
    if (this.behavior === "maintenance-settle") {
      // Compaction/summarization maintenance traffic must never create a
      // completion; the run completes exactly once at agent_settled.
      this.emit({ type: "compaction_start", reason: "overflow" });
      this.emit({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: true });
      this.emit({ type: "agent_start" });
      this.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Settled." },
      });
      this.emit({ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3 });
      this.emit({ type: "summarization_retry_finished" });
      this.emit({ type: "agent_end", messages: [] });
      this.emit({ type: "agent_settled" });
      return;
    }
    if (this.behavior === "approval" || this.behavior === "approval-hang") {
      // Emit an approvable (or, via approvalMethod, a non-approvable) Pi UI
      // request. "approval" completes the turn; "approval-hang" holds the
      // run active until the matching extension_ui_response (or abort).
      this.emit({
        type: "extension_ui_request",
        id: this.approvalRequestId,
        method: this.approvalMethod,
        title: "Approve action?",
        message: "The agent wants to proceed.",
      });
      if (this.behavior === "approval-hang") {
        return;
      }
      this.emit({ type: "agent_end", messages: [] });
      this.emit({ type: "agent_settled" });
      return;
    }
    this.emit({ type: "agent_end", messages: [] });
    this.emit({ type: "agent_settled" });
  }

  async newSession(): Promise<{ cancelled: boolean }> {
    return { cancelled: false };
  }

  async compact(): Promise<{ tokensBefore: number | null; estimatedTokensAfter: number | null }> {
    return { tokensBefore: null, estimatedTokensAfter: null };
  }

  respondToUiRequest(id: string, response: ExtensionUiResponse): void {
    this.responses.push({ id, response });
    // A response to a held approval completes the held turn (approval-hang).
    if (this.behavior === "approval-hang" && id === this.approvalRequestId) {
      this.emit({
        type: "message_update",
        role: "assistant",
        assistantMessageEvent: { type: "text_delta", delta: "Approved." },
      });
      this.emit({ type: "agent_end", messages: [] });
      this.emit({ type: "agent_settled" });
    }
  }

  private emit(event: RpcEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  /** C5-1: settle a held (hang) run as completed on demand (defer-launch tests). */
  settleCompleted(): void {
    this.emit({ type: "agent_end", messages: [] });
    this.emit({ type: "agent_settled" });
  }
}

let root: string;
let nonceSeq = 0;
const NOW = new Date("2026-08-05T14:00:00.000Z");
/** Advancing fake clock so every durable event gets a distinct created stamp. */
let clockMs = 0;
function tick(): Date {
  clockMs += 1;
  return new Date(NOW.getTime() + clockMs);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-conversation-broker-"));
  clockMs = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function makeTimers() {
  let nextHandle = 1;
  const pending = new Map<number, () => void>();
  return {
    pending,
    setTimeout(callback: () => void): number {
      const handle = nextHandle++;
      pending.set(handle, callback);
      return handle;
    },
    clearTimeout(handle: number): void {
      pending.delete(handle);
    },
    fire(handle: number): void {
      const callback = pending.get(handle);
      if (callback) {
        pending.delete(handle);
        callback();
      }
    },
    pendingCount(): number {
      return pending.size;
    },
  };
}

function makeBroker(options?: {
  runnableAgents?: string[];
  behaviors?: FakeBehavior[];
  timers?: ReturnType<typeof makeTimers>;
  approvalMethods?: string[];
  clientSetup?: (client: FakeConversationClient) => void;
}): { broker: ConversationBroker; clients: FakeConversationClient[]; timers: ReturnType<typeof makeTimers> } {
  const behaviors = options?.behaviors ?? [];
  const approvalMethods = options?.approvalMethods ?? [];
  const clients: FakeConversationClient[] = [];
  const timers = options?.timers ?? makeTimers();
  const broker = new ConversationBroker({
    vaultRoot: root,
    runnableAgents: options?.runnableAgents ?? ["zai", "dipu"],
    targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
    clientFactory: () => {
      const client = new FakeConversationClient(behaviors[clients.length] ?? "complete");
      client.approvalMethod = approvalMethods[clients.length] ?? "confirm";
      if (options?.clientSetup !== undefined) options.clientSetup(client);
      clients.push(client);
      return client;
    },
    now: tick,
    nonce: () => `n${++nonceSeq}`,
    timers,
    runTimeoutMs: 60_000,
  });
  return { broker, clients, timers };
}

async function makeConversation(audience: string[] = ["zai"], text = "Hello @zai"): Promise<string> {
  const conversation = await createConversation({ vaultRoot: root, text, audience, now: tick });
  return conversation.id;
}

async function makeStewardEvent(conversationId: string, text: string, nonce?: () => string): Promise<string> {
  const event = await appendConversationEvent({
    vaultRoot: root,
    conversationId,
    kind: "steward_message",
    authorKind: "steward",
    author: "steward",
    body: text,
    mentions: ["zai"],
    now: tick,
    nonce: nonce ?? (() => `s${++nonceSeq}`),
  });
  return event.id;
}

async function priorEvents(conversationId: string): Promise<Awaited<ReturnType<typeof readConversationEvents>>[number][]> {
  return readConversationEvents({ vaultRoot: root, conversationId });
}

describe("ConversationBroker dispatch outcomes", () => {
  it("dispatches a complete run: run_started + run_finished completed, isolated client, prompt handed the context", async () => {
    const { broker, clients } = makeBroker();
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
    expect(clients).toHaveLength(1);
    expect(clients[0]?.prompts).toHaveLength(1);
    expect(clients[0]?.prompts[0]).toContain("conversation '");
    expect(clients[0]?.prompts[0]).toContain("Steward request:\nPlease review");

    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.map((e) => [e.kind, e.runStatus])).toEqual([
      ["steward_message", undefined],
      ["run_started", "running"],
      ["run_finished", "completed"],
    ]);
    expect(events[2]?.correlationId).toBe(stewardEventId);
    await broker.close();
  });

  it("records launch_failure with the typed failed outcome when the client cannot start", async () => {
    const { broker, clients } = makeBroker({ behaviors: ["start-fail"] });
    const conversationId = await makeConversation();
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    const outcome = await broker.dispatchConversationMention({
      conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: [],
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failureKind).toBe("launch_failure");
    }
    expect(clients[0]?.started).toBe(1);

    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    const terminal = events.at(-1);
    expect(terminal?.kind).toBe("run_finished");
    expect(terminal?.runStatus).toBe("failed");
    expect(terminal?.failureKind).toBe("launch_failure");
    await broker.close();
  });

  it("records an ambiguous failed outcome on prompt failure or mid-run exit (never inferred)", async () => {
    for (const [i, behavior] of (["prompt-fail", "exit-mid-run"] as FakeBehavior[]).entries()) {
      nonceSeq = 0;
      const { broker } = makeBroker({ behaviors: [behavior] });
      const conversationId = await makeConversation(["zai"], `Hello @zai ${i}`);
      const stewardEventId = await makeStewardEvent(conversationId, `Go ${i}`);
      const outcome = await broker.dispatchConversationMention({
        conversationId, agent: "zai", text: `Go ${i}`, stewardEventId, priorEvents: [],
      });
      expect(outcome.status).toBe("failed");
      if (outcome.status === "failed") {
        expect(outcome.failureKind).toBe("ambiguous");
      }
      const events = await readConversationEvents({ vaultRoot: root, conversationId });
      expect(events.at(-1)?.runStatus).toBe("failed");
      expect(events.at(-1)?.failureKind).toBe("ambiguous");
      await broker.close();
    }
  });

  it("settles a hanging run as timed_out", async () => {
    const timers = makeTimers();
    const { broker } = makeBroker({ behaviors: ["hang"], timers });
    const conversationId = await makeConversation();
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    let outcome: ConversationDispatchOutcome | undefined;
    const pending = broker.dispatchConversationMention({
      conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: [],
    }).then((value) => {
      outcome = value;
    });
    const deadline = Date.now() + 2000;
    while (outcome === undefined && Date.now() < deadline) {
      for (const handle of [...timers.pending.keys()]) timers.fire(handle);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await pending;
    expect(outcome?.status).toBe("timed_out");
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.at(-1)?.runStatus).toBe("timed_out");
    await broker.close();
  });

  it("does not complete on agent_end alone: an end-only run stays active and times out conservatively", async () => {
    const timers = makeTimers();
    const { broker, clients } = makeBroker({ behaviors: ["end-only"], timers });
    const conversationId = await makeConversation();
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    let outcome: ConversationDispatchOutcome | undefined;
    const pending = broker.dispatchConversationMention({
      conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: [],
    }).then((value) => {
      outcome = value;
    });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if ((clients[0]?.prompts.length ?? 0) === 1 && timers.pending.size > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(clients[0]?.prompts.length).toBe(1);
    // The agent_end (and its partial text) must NOT have settled the run:
    // no terminal event may have been written yet.
    const eventsSoFar = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(eventsSoFar.map((e) => e.kind)).toEqual(["steward_message", "run_started"]);
    for (const handle of [...timers.pending.keys()]) timers.fire(handle);
    await pending;
    expect(outcome?.status).toBe("timed_out");
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.at(-1)?.runStatus).toBe("timed_out");
    expect(events.filter((e) => e.kind === "agent_message")).toHaveLength(0);
    await broker.close();
  });

  it("completes exactly once at agent_settled across compaction/summarization maintenance traffic", async () => {
    const { broker } = makeBroker({ behaviors: ["maintenance-settle"] });
    const conversationId = await makeConversation();
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    const outcome = await broker.dispatchConversationMention({
      conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: [],
    });
    expect(outcome.status).toBe("completed");
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.map((e) => e.kind)).toEqual(["steward_message", "run_started", "agent_message", "run_finished"]);
    const agentEvent = events.find((e) => e.kind === "agent_message");
    expect(agentEvent?.body).toBe("Settled.");
    expect(events.at(-1)?.runStatus).toBe("completed");
    // Exactly one completion: maintenance lifecycle events never created an
    // extra terminal record.
    expect(events.filter((e) => e.kind === "run_finished")).toHaveLength(1);
    await broker.close();
  });

  it("persists exactly one correlated agent_message for visible assistant output before terminal evidence", async () => {
    const { broker } = makeBroker({ behaviors: ["with-text"] });
    const conversationId = await makeConversation();
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    const outcome = await broker.dispatchConversationMention({
      conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: [],
    });
    expect(outcome.status).toBe("completed");
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.map((e) => e.kind)).toEqual(["steward_message", "run_started", "agent_message", "run_finished"]);
    const agentEvent = events.find((e) => e.kind === "agent_message");
    expect(agentEvent?.author).toBe("zai");
    expect(agentEvent?.body).toBe("Visible agent reply.");
    expect(agentEvent?.correlationId).toBe(stewardEventId);
    expect(events.at(-1)?.kind).toBe("run_finished");
    await broker.close();
  });

  it("creates no agent_message when the assistant output is empty", async () => {
    const { broker } = makeBroker({ behaviors: ["complete"] });
    const conversationId = await makeConversation();
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    await broker.dispatchConversationMention({ conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: [] });
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.map((e) => e.kind)).toEqual(["steward_message", "run_started", "run_finished"]);
    await broker.close();
  });

  it("replays a persisted agent_message in the later dispatch context in durable order", async () => {
    const { broker, clients } = makeBroker({ behaviors: ["with-text"] });
    const conversationId = await makeConversation();
    const stewardEventId = await makeStewardEvent(conversationId, "First");
    await broker.dispatchConversationMention({ conversationId, agent: "zai", text: "First", stewardEventId, priorEvents: [] });

    const stewardEvent2 = await makeStewardEvent(conversationId, "Second");
    const prior = await priorEvents(conversationId);
    const priorExcludingCurrent = prior.filter((e) => e.id !== stewardEvent2);
    await broker.dispatchConversationMention({
      conversationId, agent: "zai", text: "Second", stewardEventId: stewardEvent2, priorEvents: priorExcludingCurrent,
    });

    // The second dispatch reuses the same isolated conversation×agent client.
    const secondPrompt = clients[0]?.prompts[1] as string;
    expect(secondPrompt).toContain("agent zai: Visible agent reply.");
    // The prior context appears before the current steward request, and the
    // current request is never duplicated as prior context.
    expect(secondPrompt.indexOf("Visible agent reply.")).toBeLessThan(secondPrompt.indexOf("Steward request:"));
    await broker.close();
  });

  it("rejects a concurrent active run for the same conversation×agent with an explicit conflict", async () => {
    const timers = makeTimers();
    const { broker } = makeBroker({ behaviors: ["hang"], timers });
    const conversationId = await makeConversation();
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    let first: ConversationDispatchOutcome | undefined;
    const pending = broker.dispatchConversationMention({ conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: [] })
      .then((value) => {
        first = value;
      });
    await expect(
      broker.dispatchConversationMention({ conversationId, agent: "zai", text: "Again", stewardEventId, priorEvents: [] }),
    ).rejects.toThrow(/already active/i);
    const deadline = Date.now() + 2000;
    while (first === undefined && Date.now() < deadline) {
      for (const handle of [...timers.pending.keys()]) timers.fire(handle);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await pending;
    expect(first?.status).toBe("timed_out");
    await broker.close();
  });

  it("rejects a closed broker, a non-runnable agent, a non-member, and an archived conversation", async () => {
    const { broker } = makeBroker({ runnableAgents: ["dipu"] });
    const conversationId = await makeConversation(["zai"]);
    const stewardEventId = await makeStewardEvent(conversationId, "Go");

    // zai is a member but NOT locally runnable: rejected fail-closed.
    await expect(
      broker.dispatchConversationMention({ conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: [] }),
    ).rejects.toThrow(/not in the runnable set/i);

    // dipu is runnable but NOT a member: rejected fail-closed.
    await expect(
      broker.dispatchConversationMention({ conversationId, agent: "dipu", text: "Go", stewardEventId, priorEvents: [] }),
    ).rejects.toThrow(/not a member/i);
    await broker.close();

    const closed = makeBroker().broker;
    await closed.close();
    await expect(
      closed.dispatchConversationMention({ conversationId, agent: "dipu", text: "Go", stewardEventId, priorEvents: [] }),
    ).rejects.toThrow(/closed/i);
  });

  it("publishes committed events to scoped conversation listeners (SSE seam)", async () => {
    const { broker } = makeBroker();
    const conversationId = await makeConversation();
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    const seen: string[] = [];
    const unsubscribe = broker.onConversationEvent(conversationId, (event) => seen.push(event.kind));
    await broker.dispatchConversationMention({ conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: [] });
    expect(seen).toEqual(["run_started", "run_finished"]);
    unsubscribe();
    await broker.close();
  });
});

describe("Conversation context handoff (8 / 16384, C1 selectDurableTranscript)", () => {
  it("replays the full prior durable transcript in order without duplicating the current message", async () => {
    const { broker, clients } = makeBroker();
    const conversationId = await makeConversation();
    let seq = 0;
    const nonce = () => `n${++seq}`;
    for (const body of ["first message", "second message"]) {
      await appendConversationEvent({
        vaultRoot: root, conversationId, kind: "steward_message", authorKind: "steward", author: "steward",
        body, now: () => NOW, nonce,
      });
    }
    const stewardEventId = await makeStewardEvent(conversationId, "CURRENT REQUEST");
    const prior = await priorEvents(conversationId);
    // The current steward message must be excluded from the prior transcript.
    const priorExcludingCurrent = prior.filter((e) => e.id !== stewardEventId);

    await broker.dispatchConversationMention({
      conversationId, agent: "zai", text: "CURRENT REQUEST", stewardEventId, priorEvents: priorExcludingCurrent,
    });

    const prompt = clients[0]?.prompts[0] as string;
    expect(prompt).toContain("first message");
    expect(prompt).toContain("second message");
    // The current request appears once, as the dispatch message, never as prior context.
    expect(prompt.split("CURRENT REQUEST")).toHaveLength(2);
    expect(prompt).toContain("Steward request:\nCURRENT REQUEST");
    await broker.close();
  });

  it("records truncation metadata on the run_started event when the budget is hit", async () => {
    const { broker } = makeBroker();
    const conversationId = await makeConversation();
    let seq = 0;
    const nonce = () => `n${++seq}`;
    for (let i = 0; i < 12; i++) {
      await appendConversationEvent({
        vaultRoot: root, conversationId, kind: "steward_message", authorKind: "steward", author: "steward",
        body: `message-${i}`.padEnd(40, "x"), now: tick, nonce,
      });
    }
    const stewardEventId = await makeStewardEvent(conversationId, "Go", () => `s${++nonceSeq}`);
    const prior = await priorEvents(conversationId);
    const priorExcludingCurrent = prior.filter((e) => e.id !== stewardEventId);

    await broker.dispatchConversationMention({
      conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: priorExcludingCurrent,
    });

    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    const started = events.find((e) => e.kind === "run_started");
    expect(started?.contextMetadata).toBeDefined();
    expect(started?.contextMetadata?.maxItems).toBe(8);
    expect(started?.contextMetadata?.maxChars).toBe(16384);
    // 12 prior messages (~40 chars each) exceed 8 items: 8 selected, 4 omitted.
    expect(started?.contextMetadata?.selectedCount).toBe(8);
    expect(started?.contextMetadata?.omittedCount).toBe(4);
    expect(started?.contextMetadata?.truncated).toBe(true);
    await broker.close();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("ConversationBroker approval/abort core (C3-C1)", () => {
  it("parseConversationApprovalResponse accepts exactly one of confirmed|value|cancelled and rejects everything else", () => {
    expect(parseConversationApprovalResponse({ confirmed: true })).toEqual({ confirmed: true });
    expect(parseConversationApprovalResponse({ confirmed: false })).toEqual({ confirmed: false });
    expect(parseConversationApprovalResponse({ value: "pick me" })).toEqual({ value: "pick me" });
    expect(parseConversationApprovalResponse({ cancelled: true })).toEqual({ cancelled: true });
    // Missing, wrong-typed, multiple, or non-object shapes are rejected.
    expect(parseConversationApprovalResponse({})).toBeNull();
    expect(parseConversationApprovalResponse({ confirmed: "yes" })).toBeNull();
    expect(parseConversationApprovalResponse({ value: 5 })).toBeNull();
    expect(parseConversationApprovalResponse({ cancelled: false })).toBeNull();
    expect(parseConversationApprovalResponse({ confirmed: true, value: "x" })).toBeNull();
    expect(parseConversationApprovalResponse({ cancelled: true, confirmed: true })).toBeNull();
    expect(parseConversationApprovalResponse(null)).toBeNull();
    expect(parseConversationApprovalResponse(undefined)).toBeNull();
    expect(parseConversationApprovalResponse("yes")).toBeNull();
    expect(parseConversationApprovalResponse(5)).toBeNull();
  });

  it("registers pending approvals only for confirm|select|input and never for other Pi UI methods", async () => {
    const { broker } = makeBroker({
      behaviors: ["approval-hang", "approval-hang", "approval-hang", "approval-hang"],
      approvalMethods: ["confirm", "select", "input", "notify"],
    });
    const conversationIds: string[] = [];
    const seen: string[] = [];
    for (const method of ["confirm", "select", "input", "notify"]) {
      const conversationId = await makeConversation(["zai"], `Hello @zai ${method}`);
      conversationIds.push(conversationId);
      broker.onConversationApproval(conversationId, (approval) => seen.push(approval.method));
      const stewardEventId = await makeStewardEvent(conversationId, `Go ${method}`);
      void broker.dispatchConversationMention({
        conversationId,
        agent: "zai",
        text: `Go ${method}`,
        stewardEventId,
        priorEvents: [],
      });
    }
    // Approvable methods register; notify never does (the run stays active).
    await waitFor(() => broker.hasPendingApproval(conversationIds[0] ?? "", "zai", "req-1"));
    await waitFor(() => broker.hasPendingApproval(conversationIds[1] ?? "", "zai", "req-1"));
    await waitFor(() => broker.hasPendingApproval(conversationIds[2] ?? "", "zai", "req-1"));
    expect(broker.hasPendingApproval(conversationIds[3] ?? "", "zai", "req-1")).toBe(false);
    expect(seen).toEqual(["confirm", "select", "input"]);
    // Abort every held run so the broker closes cleanly with no timeouts.
    for (const conversationId of conversationIds) {
      await broker.abort(conversationId, "zai");
    }
    await broker.close();
  });

  it("responds exactly once to the exact key, cleans up, and never persists approval payloads", async () => {
    const { broker, clients } = makeBroker({ behaviors: ["approval-hang"] });
    const conversationId = await makeConversation();
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    const dispatch = broker.dispatchConversationMention({
      conversationId,
      agent: "zai",
      text: "Go",
      stewardEventId,
      priorEvents: [],
    });
    await waitFor(() => broker.hasPendingApproval(conversationId, "zai", "req-1"));

    broker.respondToConversationApproval({
      conversationId,
      agent: "zai",
      requestId: "req-1",
      response: { confirmed: true },
    });
    expect(clients[0]?.responses).toEqual([{ id: "req-1", response: { confirmed: true } }]);
    expect(broker.hasPendingApproval(conversationId, "zai", "req-1")).toBe(false);

    const outcome = await dispatch;
    expect(outcome.status).toBe("completed");

    // A second response to the now-resolved request is a bounded rejection.
    await expect(
      broker.respondToConversationApproval({
        conversationId,
        agent: "zai",
        requestId: "req-1",
        response: { confirmed: true },
      }),
    ).rejects.toThrow(/Unknown or stale approval request 'req-1' for conversation '.*' and agent 'zai'\./);
    expect(clients[0]?.responses).toHaveLength(1);

    // Durable truth stays the ordinary run events; no approval record or
    // payload ever enters the vault.
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.map((e) => e.kind)).toEqual([
      "steward_message",
      "run_started",
      "agent_message",
      "run_finished",
    ]);
    expect(events.some((e) => e.kind.toLowerCase().includes("approval"))).toBe(false);
    expect(events.some((e) => JSON.stringify(e).includes("confirmed"))).toBe(false);
    await broker.close();
  });

  it("rejects a wrong conversation, wrong agent, or wrong request id with the bounded message and sends nothing", async () => {
    const { broker, clients } = makeBroker({ behaviors: ["approval-hang"] });
    const conversationId = await makeConversation();
    const otherId = await makeConversation();
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    const dispatch = broker.dispatchConversationMention({
      conversationId,
      agent: "zai",
      text: "Go",
      stewardEventId,
      priorEvents: [],
    });
    await waitFor(() => broker.hasPendingApproval(conversationId, "zai", "req-1"));

    await expect(
      broker.respondToConversationApproval({ conversationId: otherId, agent: "zai", requestId: "req-1", response: { confirmed: true } }),
    ).rejects.toThrow(/Unknown or stale approval request/);
    await expect(
      broker.respondToConversationApproval({ conversationId, agent: "dipu", requestId: "req-1", response: { confirmed: true } }),
    ).rejects.toThrow(/Unknown or stale approval request/);
    await expect(
      broker.respondToConversationApproval({ conversationId, agent: "zai", requestId: "req-999", response: { confirmed: true } }),
    ).rejects.toThrow(/Unknown or stale approval request/);
    expect(clients[0]?.responses).toHaveLength(0);
    // No unintended side effects: no extra clients/sessions and no extra events.
    expect(clients).toHaveLength(1);
    expect(clients[0]?.started).toBe(1);

    // The real response still works afterwards.
    broker.respondToConversationApproval({ conversationId, agent: "zai", requestId: "req-1", response: { value: "ok" } });
    expect(clients[0]?.responses).toEqual([{ id: "req-1", response: { value: "ok" } }]);
    await dispatch;
    await broker.close();
  });

  it("never cross-delivers the same Pi request id across conversation×agent keys", async () => {
    const { broker, clients } = makeBroker({ behaviors: ["approval-hang", "approval-hang"] });
    const convOne = await makeConversation(["zai"], "Hello @zai one");
    const convTwo = await makeConversation(["zai"], "Hello @zai two");
    const stewardOne = await makeStewardEvent(convOne, "Go one");
    const stewardTwo = await makeStewardEvent(convTwo, "Go two");
    const dispatchOne = broker.dispatchConversationMention({ conversationId: convOne, agent: "zai", text: "Go one", stewardEventId: stewardOne, priorEvents: [] });
    const dispatchTwo = broker.dispatchConversationMention({ conversationId: convTwo, agent: "zai", text: "Go two", stewardEventId: stewardTwo, priorEvents: [] });
    await waitFor(() => broker.hasPendingApproval(convOne, "zai", "req-1") && broker.hasPendingApproval(convTwo, "zai", "req-1"));

    broker.respondToConversationApproval({ conversationId: convOne, agent: "zai", requestId: "req-1", response: { confirmed: true } });
    // Only convOne's client received the response; convTwo's pending request stays.
    expect(clients[0]?.responses).toHaveLength(1);
    expect(clients[1]?.responses).toHaveLength(0);
    expect(broker.hasPendingApproval(convTwo, "zai", "req-1")).toBe(true);

    broker.respondToConversationApproval({ conversationId: convTwo, agent: "zai", requestId: "req-1", response: { cancelled: true } });
    expect(clients[1]?.responses).toEqual([{ id: "req-1", response: { cancelled: true } }]);
    await dispatchOne;
    await dispatchTwo;
    await broker.close();
  });

  it("rejects a malformed response at the core and keeps the entry answerable", async () => {
    const { broker, clients } = makeBroker({ behaviors: ["approval-hang"] });
    const conversationId = await makeConversation();
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    const dispatch = broker.dispatchConversationMention({ conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: [] });
    await waitFor(() => broker.hasPendingApproval(conversationId, "zai", "req-1"));

    await expect(
      broker.respondToConversationApproval({ conversationId, agent: "zai", requestId: "req-1", response: { confirmed: "yes" } }),
    ).rejects.toThrow(/Exactly one of confirmed, value, or cancelled is required\./);
    expect(clients[0]?.responses).toHaveLength(0);
    // The pending entry survives the malformed attempt.
    expect(broker.hasPendingApproval(conversationId, "zai", "req-1")).toBe(true);

    broker.respondToConversationApproval({ conversationId, agent: "zai", requestId: "req-1", response: { confirmed: true } });
    expect(clients[0]?.responses).toEqual([{ id: "req-1", response: { confirmed: true } }]);
    await dispatch;
    await broker.close();
  });

  it("cleans up a settled run's pending approval; a late response is a bounded rejection", async () => {
    const { broker, clients } = makeBroker({ behaviors: ["approval"] });
    const conversationId = await makeConversation();
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    await broker.dispatchConversationMention({ conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: [] });
    // The run completed at agent_settled; the registry entry was removed.
    expect(broker.hasPendingApproval(conversationId, "zai", "req-1")).toBe(false);
    expect(clients[0]?.responses).toHaveLength(0);
    await expect(
      broker.respondToConversationApproval({ conversationId, agent: "zai", requestId: "req-1", response: { confirmed: true } }),
    ).rejects.toThrow(/Unknown or stale approval request/);
    await broker.close();
  });

  it("aborts exactly one run: no-active-run for a missing key, exactly one run_cancelled, duplicate abort is a no-op", async () => {
    const { broker, clients } = makeBroker({ behaviors: ["hang"] });
    const conversationId = await makeConversation();
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    const dispatch = broker.dispatchConversationMention({ conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: [] });
    await waitFor(() => broker.hasActiveRun(conversationId, "zai"));

    const outcome = await broker.abort(conversationId, "zai");
    expect(outcome.status).toBe("cancelled");
    if (outcome.status === "cancelled") {
      expect(outcome.terminalEventId).toBeTruthy();
    }
    await dispatch;
    expect(clients[0]?.aborted).toBe(1);

    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.filter((e) => e.kind === "run_cancelled")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "run_finished")).toHaveLength(0);

    // Duplicate abort: no-active-run, no second run_cancelled.
    expect(await broker.abort(conversationId, "zai")).toEqual({ status: "no-active-run", conversationId, agent: "zai" });
    // Never-dispatched key: no-active-run.
    expect(await broker.abort("never-dispatched", "zai")).toEqual({ status: "no-active-run", conversationId: "never-dispatched", agent: "zai" });
    const eventsAfter = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(eventsAfter.filter((e) => e.kind === "run_cancelled")).toHaveLength(1);
    await broker.close();
  });

  it("abort during session start wins: no run_started, no launch_failure, exactly one run_cancelled", async () => {
    let releaseStart!: () => void;
    const startBarrier = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const { broker, clients } = makeBroker({
      behaviors: ["hang"],
      clientSetup: (client) => {
        client.startBarrier = startBarrier;
      },
    });
    const conversationId = await makeConversation();
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    const dispatch = broker.dispatchConversationMention({
      conversationId,
      agent: "zai",
      text: "Go",
      stewardEventId,
      priorEvents: [],
    });
    await waitFor(() => broker.hasActiveRun(conversationId, "zai"));
    const abortPromise = broker.abort(conversationId, "zai");
    releaseStart();
    const outcome = await abortPromise;
    expect(outcome.status).toBe("cancelled");
    await dispatch;
    // Cancellation wins over the startup outcome: the just-created session is
    // stopped and forgotten, never wired, never prompted, never launch_failure.
    expect(clients[0]?.stopped).toBe(1);
    expect(clients[0]?.prompts).toHaveLength(0);
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.map((e) => e.kind)).toEqual(["steward_message", "run_cancelled"]);
    expect(events.filter((e) => e.kind === "run_cancelled")).toHaveLength(1);
    await broker.close();
  });

  it("close clears pending approvals and cancels each active run exactly once", async () => {
    const { broker } = makeBroker({ behaviors: ["approval-hang", "approval-hang"] });
    const convOne = await makeConversation(["zai"], "Hello @zai one");
    const convTwo = await makeConversation(["zai"], "Hello @zai two");
    const stewardOne = await makeStewardEvent(convOne, "Go one");
    const stewardTwo = await makeStewardEvent(convTwo, "Go two");
    const dispatchOne = broker.dispatchConversationMention({ conversationId: convOne, agent: "zai", text: "Go one", stewardEventId: stewardOne, priorEvents: [] });
    const dispatchTwo = broker.dispatchConversationMention({ conversationId: convTwo, agent: "zai", text: "Go two", stewardEventId: stewardTwo, priorEvents: [] });
    await waitFor(() => broker.hasPendingApproval(convOne, "zai", "req-1") && broker.hasPendingApproval(convTwo, "zai", "req-1"));

    await broker.close();
    expect(broker.hasPendingApproval(convOne, "zai", "req-1")).toBe(false);
    expect(broker.hasPendingApproval(convTwo, "zai", "req-1")).toBe(false);
    await dispatchOne;
    await dispatchTwo;
    for (const conversationId of [convOne, convTwo]) {
      const events = await readConversationEvents({ vaultRoot: root, conversationId });
      expect(events.filter((e) => e.kind === "run_cancelled")).toHaveLength(1);
    }
    // Idempotent close writes nothing further.
    await broker.close();
    const eventsAfter = await readConversationEvents({ vaultRoot: root, conversationId: convOne });
    expect(eventsAfter.filter((e) => e.kind === "run_cancelled")).toHaveLength(1);
  });

  it("controls are run-scoped: a pending approval from an archived conversation stays answerable and abort still works", async () => {
    const { broker, clients } = makeBroker({ behaviors: ["approval-hang", "approval-hang"] });

    // 1. Approve a pending request from a run of a conversation archived mid-run.
    const convOne = await makeConversation(["zai"], "Hello @zai one");
    const stewardOne = await makeStewardEvent(convOne, "Go one");
    const dispatchOne = broker.dispatchConversationMention({ conversationId: convOne, agent: "zai", text: "Go one", stewardEventId: stewardOne, priorEvents: [] });
    await waitFor(() => broker.hasPendingApproval(convOne, "zai", "req-1"));
    const archived = await transitionConversationLifecycle({
      vaultRoot: root,
      conversationId: convOne,
      transition: "archive",
      now: tick,
      nonce: () => `a${++nonceSeq}`,
    });
    expect(archived.ok).toBe(true);
    // The pending approval is still answerable after the archive (run-scoped).
    broker.respondToConversationApproval({ conversationId: convOne, agent: "zai", requestId: "req-1", response: { confirmed: true } });
    expect(clients[0]?.responses).toEqual([{ id: "req-1", response: { confirmed: true } }]);
    await dispatchOne;

    // 2. Abort a still-running run of a conversation archived mid-run.
    const convTwo = await makeConversation(["zai"], "Hello @zai two");
    const stewardTwo = await makeStewardEvent(convTwo, "Go two");
    const dispatchTwo = broker.dispatchConversationMention({ conversationId: convTwo, agent: "zai", text: "Go two", stewardEventId: stewardTwo, priorEvents: [] });
    await waitFor(() => broker.hasActiveRun(convTwo, "zai"));
    await transitionConversationLifecycle({ vaultRoot: root, conversationId: convTwo, transition: "archive", now: tick, nonce: () => `a${++nonceSeq}` });
    const abortOutcome = await broker.abort(convTwo, "zai");
    expect(abortOutcome.status).toBe("cancelled");
    await dispatchTwo;
    const eventsTwo = await readConversationEvents({ vaultRoot: root, conversationId: convTwo });
    expect(eventsTwo.filter((e) => e.kind === "run_cancelled")).toHaveLength(1);
    await broker.close();
  });
});

describe("ConversationBroker C5-1 sequential handoff lifecycle", () => {
  it("accepts a handoff: durable handoff event + M1 audience growth, child launches only after the completed source terminal", async () => {
    const { broker, clients } = makeBroker({ runnableAgents: ["zai", "dipu"], behaviors: ["hang", "complete"] });
    const conversationId = await makeConversation(["zai"], "Hello @zai");
    const stewardEventId = await makeStewardEvent(conversationId, "Lead this workflow");
    const dispatch = broker.dispatchConversationMention({
      conversationId,
      agent: "zai",
      text: "Lead this workflow",
      stewardEventId,
      priorEvents: [],
    });
    await waitFor(() => broker.hasActiveRun(conversationId, "zai"));

    const accepted = await broker.requestConversationHandoff(conversationId, "zai", { to: "dipu", text: "Please review the diff" });
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") throw new Error("expected accepted");
    const handoffEventId = accepted.handoffEventId;

    // Durable handoff event + additive M1 membership, in that moment.
    const eventsAfterRequest = await readConversationEvents({ vaultRoot: root, conversationId });
    const handoff = eventsAfterRequest.find((e) => e.id === handoffEventId);
    expect(handoff?.kind).toBe("agent_message");
    expect(handoff?.author).toBe("zai");
    expect(handoff?.addressedAgent).toBe("dipu");
    expect(handoff?.correlationId).toBe(stewardEventId);
    expect(handoff?.body).toBe("Please review the diff");
    const manifestAfter = await readConversation({ vaultRoot: root, conversationId });
    expect(manifestAfter.audience).toEqual(["zai", "dipu"]);

    // Child launches only after the source settles completed.
    expect(clients).toHaveLength(1);
    clients[0]?.settleCompleted();
    const outcome = await dispatch;
    expect(outcome.status).toBe("completed");

    expect(clients).toHaveLength(2);
    const childPrompt = clients[1]?.prompts[0] ?? "";
    expect(childPrompt).toContain("agent 'dipu'");
    expect(childPrompt).toContain("Please review the diff");

    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "steward_message",
      "run_started",      // source
      "agent_message",    // handoff edge
      "run_finished",     // source completed
      "run_started",      // child
      "run_finished",     // child completed
    ]);
    const sourceTerminal = events.find((e) => e.kind === "run_finished" && e.correlationId === stewardEventId);
    const childStarted = events.find((e) => e.kind === "run_started" && e.correlationId === handoffEventId);
    const childTerminal = events.find((e) => e.kind === "run_finished" && e.correlationId === handoffEventId);
    expect(sourceTerminal).toBeDefined();
    expect(childStarted).toBeDefined();
    expect(childTerminal?.runStatus).toBe("completed");
    // Sequential: the child's run_started sequence is strictly after the source terminal.
    expect(childStarted?.sequence ?? 0).toBeGreaterThan(sourceTerminal?.sequence ?? 0);
    // The child is a workflow stage: it may hand off again within budget.
    expect(clients[1]?.prompts[0]).toContain("approved Piren conversation workflow");
    await broker.close();
  });

  it("rejects a second handoff request while one is already accepted and pending launch", async () => {
    const { broker, clients } = makeBroker({ runnableAgents: ["zai", "dipu", "sam"], behaviors: ["hang"] });
    const conversationId = await makeConversation(["zai"], "Hello @zai");
    const stewardEventId = await makeStewardEvent(conversationId, "Lead this workflow");
    const dispatch = broker.dispatchConversationMention({
      conversationId,
      agent: "zai",
      text: "Lead this workflow",
      stewardEventId,
      priorEvents: [],
    });
    await waitFor(() => broker.hasActiveRun(conversationId, "zai"));

    const first = await broker.requestConversationHandoff(conversationId, "zai", { to: "dipu", text: "First edge" });
    expect(first.status).toBe("accepted");

    // A second request before the deferred child launches would otherwise
    // overwrite the pending edge (its child would never launch) while still
    // consuming budget and audience. The sequential invariant rejects it.
    const second = await broker.requestConversationHandoff(conversationId, "zai", { to: "sam", text: "Second edge" });
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") {
      expect(second.reason).toBe("a conversation handoff is already accepted and pending launch");
    }

    // No second durable edge, no membership growth for sam, no budget consumed.
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.filter((e) => e.kind === "agent_message" && e.addressedAgent !== undefined)).toHaveLength(1);
    const manifest = await readConversation({ vaultRoot: root, conversationId });
    expect(manifest.audience).toEqual(["zai", "dipu"]);

    clients[0]?.settleCompleted();
    await dispatch;
    await broker.close();
  });

  it("never launches the deferred child when the source settles non-completed (timeout and abort)", async () => {
    // Timeout path.
    const timers = makeTimers();
    const { broker, clients } = makeBroker({ runnableAgents: ["zai", "dipu"], behaviors: ["hang"], timers });
    const conversationId = await makeConversation(["zai"], "Hello @zai");
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    let outcome: ConversationDispatchOutcome | undefined;
    const pending = broker
      .dispatchConversationMention({ conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: [] })
      .then((value) => {
        outcome = value;
      });
    await waitFor(() => broker.hasActiveRun(conversationId, "zai"));
    await broker.requestConversationHandoff(conversationId, "zai", { to: "dipu", text: "help" });
    for (const handle of [...timers.pending.keys()]) timers.fire(handle);
    await pending;
    expect(outcome?.status).toBe("timed_out");
    expect(clients).toHaveLength(1);
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.filter((e) => e.kind === "run_started")).toHaveLength(1);
    expect(events.some((e) => e.kind === "agent_message" && e.addressedAgent === "dipu")).toBe(true);
    expect(events.filter((e) => e.kind === "run_finished" && e.correlationId !== stewardEventId)).toHaveLength(0);
    await broker.close();

    // Abort path.
    const { broker: brokerB, clients: clientsB } = makeBroker({ runnableAgents: ["zai", "dipu"], behaviors: ["hang"] });
    const conversationB = await makeConversation(["zai"], "Hello @zai B");
    const stewardB = await makeStewardEvent(conversationB, "Go B");
    const dispatchB = brokerB.dispatchConversationMention({ conversationId: conversationB, agent: "zai", text: "Go B", stewardEventId: stewardB, priorEvents: [] });
    await waitFor(() => brokerB.hasActiveRun(conversationB, "zai"));
    await brokerB.requestConversationHandoff(conversationB, "zai", { to: "dipu", text: "help" });
    await brokerB.abort(conversationB, "zai");
    const outcomeB = await dispatchB;
    expect(outcomeB.status).toBe("cancelled");
    expect(clientsB).toHaveLength(1);
    await brokerB.close();
  });

  it("records exactly one correlated launch_failure terminal when the child cannot start", async () => {
    const { broker, clients } = makeBroker({ runnableAgents: ["zai", "dipu"], behaviors: ["hang", "start-fail"] });
    const conversationId = await makeConversation(["zai"], "Hello @zai");
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    const dispatch = broker.dispatchConversationMention({ conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: [] });
    await waitFor(() => broker.hasActiveRun(conversationId, "zai"));
    const accepted = await broker.requestConversationHandoff(conversationId, "zai", { to: "dipu", text: "help" });
    if (accepted.status !== "accepted") throw new Error("expected accepted");
    clients[0]?.settleCompleted();
    const outcome = await dispatch;
    expect(outcome.status).toBe("completed");
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    const launchFailures = events.filter((e) => e.kind === "run_finished" && e.failureKind === "launch_failure" && e.correlationId === accepted.handoffEventId);
    expect(launchFailures).toHaveLength(1);
    expect(launchFailures[0]?.body).toContain("could not be started");
    expect(events.filter((e) => e.kind === "run_started")).toHaveLength(1);
    await broker.close();
  });

  it("rejects a handoff to an agent with an active run: no event, no membership change", async () => {
    const { broker } = makeBroker({ runnableAgents: ["zai", "dipu"], behaviors: ["hang", "hang"] });
    const conversationId = await makeConversation(["zai", "dipu"], "Hello @zai @dipu");
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    const dispatchZai = broker.dispatchConversationMention({ conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: [] });
    const dispatchDipu = broker.dispatchConversationMention({ conversationId, agent: "dipu", text: "Go", stewardEventId, priorEvents: [] });
    await waitFor(() => broker.hasActiveRun(conversationId, "zai") && broker.hasActiveRun(conversationId, "dipu"));
    const rejected = await broker.requestConversationHandoff(conversationId, "zai", { to: "dipu", text: "help" });
    expect(rejected).toMatchObject({ status: "rejected" });
    if (rejected.status === "rejected") {
      expect(rejected.reason).toMatch(/has an active run/);
    }
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.some((e) => e.kind === "agent_message" && e.addressedAgent === "dipu")).toBe(false);
    const manifest = await readConversation({ vaultRoot: root, conversationId });
    expect(manifest.audience).toEqual(["zai", "dipu"]);
    await broker.abort(conversationId, "zai");
    await broker.abort(conversationId, "dipu");
    await dispatchZai;
    await dispatchDipu;
    await broker.close();
  });

  it("rejects a handoff when the audience lock is busy: no event, no membership change", async () => {
    const { broker } = makeBroker({ runnableAgents: ["zai", "dipu"], behaviors: ["hang"] });
    const conversationId = await makeConversation(["zai"], "Hello @zai");
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    const dispatch = broker.dispatchConversationMention({ conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: [] });
    await waitFor(() => broker.hasActiveRun(conversationId, "zai"));
    const lock = await acquireAudienceLock({ vaultRoot: root, conversationId });
    const rejected = await broker.requestConversationHandoff(conversationId, "zai", { to: "dipu", text: "help" });
    expect(rejected).toMatchObject({ status: "rejected" });
    if (rejected.status === "rejected") {
      expect(rejected.reason).toMatch(/could not grow the audience/i);
    }
    await lock.release();
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.some((e) => e.kind === "agent_message" && e.addressedAgent === "dipu")).toBe(false);
    const manifest = await readConversation({ vaultRoot: root, conversationId });
    expect(manifest.audience).toEqual(["zai"]);
    await broker.abort(conversationId, "zai");
    await dispatch;
    await broker.close();
  });

  it("rejects a handoff request with no eligible active run and keeps ordinary dispatch behavior unchanged", async () => {
    const { broker } = makeBroker({ runnableAgents: ["zai", "dipu"], behaviors: ["complete"] });
    const conversationId = await makeConversation(["zai"], "Hello @zai");
    expect(await broker.requestConversationHandoff(conversationId, "zai", { to: "dipu", text: "help" })).toMatchObject({
      status: "rejected",
    });
    // Ordinary dispatch still completes with the pre-C5 event sequence.
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    const outcome = await broker.dispatchConversationMention({ conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: [] });
    expect(outcome.status).toBe("completed");
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.map((e) => e.kind)).toEqual(["steward_message", "run_started", "run_finished"]);
    await broker.close();
  });

  it("replays the accepted handoff edge and the completed source terminal in the child's durable transcript", async () => {
    const { broker, clients } = makeBroker({ runnableAgents: ["zai", "dipu"], behaviors: ["hang", "complete"] });
    const conversationId = await makeConversation(["zai"], "Hello @zai");
    const stewardEventId = await makeStewardEvent(conversationId, "Lead this workflow");
    const dispatch = broker.dispatchConversationMention({ conversationId, agent: "zai", text: "Lead this workflow", stewardEventId, priorEvents: [] });
    await waitFor(() => broker.hasActiveRun(conversationId, "zai"));
    const accepted = await broker.requestConversationHandoff(conversationId, "zai", { to: "dipu", text: "Please review the diff" });
    if (accepted.status !== "accepted") throw new Error("expected accepted");
    clients[0]?.settleCompleted();
    await dispatch;

    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    const handoffEventId = accepted.handoffEventId;
    const sourceTerminal = events.find((e) => e.kind === "run_finished" && e.correlationId === stewardEventId);
    const childStarted = events.find((e) => e.kind === "run_started" && e.correlationId === handoffEventId);
    expect(sourceTerminal).toBeDefined();
    expect(childStarted).toBeDefined();

    // C5 §6.3: the child's bounded durable replay includes the accepted
    // handoff edge AND the completed source-stage terminal (which caused
    // defer-launch) — proven via the inspectable selection metadata, not the
    // separate "Handoff request" prompt section.
    const selectedIds = childStarted?.contextMetadata?.selectedIds ?? [];
    expect(selectedIds).toContain(handoffEventId);
    expect(selectedIds).toContain(sourceTerminal?.id ?? "");

    // The durable transcript evidence is also visible in the child prompt
    // (the completed source terminal body is only in the replay, never in the
    // Handoff request section).
    const childPrompt = clients[1]?.prompts[0] ?? "";
    expect(childPrompt).toContain("Run completed for agent 'zai'.");
    expect(childPrompt).toContain("Please review the diff");
    await broker.close();
  });

  it("enforces the depth budget end-to-end: a stage at max depth cannot hand off", async () => {
    const { broker, clients } = makeBroker({
      runnableAgents: ["zai", "dipu", "kimi", "sam"],
      behaviors: ["hang", "hang", "hang", "hang"],
    });
    const conversationId = await makeConversation(["zai"], "Hello @zai");
    const stewardEventId = await makeStewardEvent(conversationId, "Workflow");
    const dispatch = broker.dispatchConversationMention({ conversationId, agent: "zai", text: "Workflow", stewardEventId, priorEvents: [] });
    await waitFor(() => broker.hasActiveRun(conversationId, "zai"));
    // zai(root,0) -> dipu(1) -> kimi(2) -> sam(3).
    const steps: Array<[string, string]> = [
      ["zai", "dipu"],
      ["dipu", "kimi"],
      ["kimi", "sam"],
    ];
    for (const [source, to] of steps) {
      const accepted = await broker.requestConversationHandoff(conversationId, source, { to, text: `step to ${to}` });
      expect(accepted.status).toBe("accepted");
      const clientIndex = clients.findIndex((c) => (c.prompts[0] ?? "").includes(`agent '${source}'`));
      const sourceClient = clients[clientIndex >= 0 ? clientIndex : clients.length - 1];
      sourceClient?.settleCompleted();
      await waitFor(() => broker.hasActiveRun(conversationId, to));
    }
    // sam is at depth 3 (max); a further handoff is rejected with the depth reason.
    const rejected = await broker.requestConversationHandoff(conversationId, "sam", { to: "zai", text: "back" });
    expect(rejected).toMatchObject({ status: "rejected" });
    if (rejected.status === "rejected") {
      expect(rejected.reason).toMatch(/budget exhausted: depth/);
    }
    // Clean up: settle the final stage.
    const samClient = clients.find((c) => (c.prompts[0] ?? "").includes("agent 'sam'"));
    samClient?.settleCompleted();
    await dispatch;
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.filter((e) => e.kind === "agent_message" && typeof e.addressedAgent === "string")).toHaveLength(3);
    expect(events.filter((e) => e.kind === "run_finished" && e.runStatus === "completed")).toHaveLength(4);
    await broker.close();
  });
});

describe("ConversationBroker C5-2 initial steward gate", () => {
  it("registers a pending live confirm approval for a root gate request with NO side effects before confirmation", async () => {
    const { broker, clients } = makeBroker({ runnableAgents: ["zai", "dipu"], behaviors: ["hang"] });
    const conversationId = await makeConversation(["zai"], "Hello @zai");
    const stewardEventId = await makeStewardEvent(conversationId, "Lead this workflow");
    const dispatch = broker.dispatchConversationMention({
      conversationId,
      agent: "zai",
      text: "Lead this workflow",
      stewardEventId,
      priorEvents: [],
    });
    await waitFor(() => broker.hasActiveRun(conversationId, "zai"));

    const seen: ConversationApprovalNotification[] = [];
    broker.onConversationApproval(conversationId, (approval) => seen.push(approval));

    const gate = await broker.requestInitialHandoffGate(conversationId, "zai", { to: "dipu", text: "Please review the diff" });
    expect(gate).toMatchObject({ status: "pending" });
    if (gate.status !== "pending") throw new Error("expected pending");

    // The exact conversation×agent×requestId registry entry is pending and
    // one live confirm-only notification carries the bounded payload.
    expect(broker.hasPendingApproval(conversationId, "zai", gate.requestId)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      conversationId,
      agent: "zai",
      requestId: gate.requestId,
      method: "confirm",
      payload: { to: "dipu", text: "Please review the diff" },
    });

    // Before explicit confirmation: NO handoff event, NO audience mutation,
    // NO budget consumption (no derived workflow edge), NO child dispatch.
    // (run_started is the already-active root run's own event, present before
    // the gate request.)
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.map((e) => e.kind)).toEqual(["steward_message", "run_started"]);
    expect(events.some((e) => e.kind === "agent_message")).toBe(false);
    const manifest = await readConversation({ vaultRoot: root, conversationId });
    expect(manifest.audience).toEqual(["zai"]);
    expect(clients).toHaveLength(1);

    await broker.abort(conversationId, "zai");
    await dispatch;
    await broker.close();
  });

  it("gate confirmation accepts the stored root edge; the child launches only after the source completes", async () => {
    const { broker, clients } = makeBroker({ runnableAgents: ["zai", "dipu"], behaviors: ["hang", "complete"] });
    const conversationId = await makeConversation(["zai"], "Hello @zai");
    const stewardEventId = await makeStewardEvent(conversationId, "Lead this workflow");
    const dispatch = broker.dispatchConversationMention({
      conversationId,
      agent: "zai",
      text: "Lead this workflow",
      stewardEventId,
      priorEvents: [],
    });
    await waitFor(() => broker.hasActiveRun(conversationId, "zai"));
    const gate = await broker.requestInitialHandoffGate(conversationId, "zai", { to: "dipu", text: "Please review the diff" });
    if (gate.status !== "pending") throw new Error("expected pending");

    // Confirmation through the exact approval response path accepts the edge
    // durably: handoff event + M1 audience growth; the child stays deferred.
    await broker.respondToConversationApproval({
      conversationId,
      agent: "zai",
      requestId: gate.requestId,
      response: { confirmed: true },
    });
    expect(broker.hasPendingApproval(conversationId, "zai", gate.requestId)).toBe(false);
    const eventsAfterConfirm = await readConversationEvents({ vaultRoot: root, conversationId });
    const handoff = eventsAfterConfirm.find((e) => e.kind === "agent_message" && e.addressedAgent === "dipu");
    expect(handoff).toBeDefined();
    expect(handoff?.author).toBe("zai");
    expect(handoff?.correlationId).toBe(stewardEventId);
    expect(handoff?.body).toBe("Please review the diff");
    const manifestAfter = await readConversation({ vaultRoot: root, conversationId });
    expect(manifestAfter.audience).toEqual(["zai", "dipu"]);
    expect(clients).toHaveLength(1); // child deferred until source completion

    // The root cannot request another gate once the edge is accepted.
    const second = await broker.requestInitialHandoffGate(conversationId, "zai", { to: "dipu", text: "again" });
    expect(second).toMatchObject({ status: "rejected" });
    if (second.status === "rejected") {
      expect(second.reason).toBe("a conversation handoff is already accepted and pending launch");
    }

    // Source completes -> the deferred child launches with the C5-1 stage prompt.
    clients[0]?.settleCompleted();
    const outcome = await dispatch;
    expect(outcome.status).toBe("completed");
    expect(clients).toHaveLength(2);
    const childPrompt = clients[1]?.prompts[0] ?? "";
    expect(childPrompt).toContain("approved Piren conversation workflow");
    expect(childPrompt).toContain("Please review the diff");

    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "steward_message",
      "run_started", // root source
      "agent_message", // confirmed gate edge
      "run_finished", // root completed
      "run_started", // child
      "run_finished", // child completed
    ]);
    const sourceTerminal = events.find((e) => e.kind === "run_finished" && e.correlationId === stewardEventId);
    const childStarted = events.find((e) => e.kind === "run_started" && e.correlationId === handoff?.id);
    expect(sourceTerminal).toBeDefined();
    expect(childStarted).toBeDefined();
    // Sequential: the child's run_started sequence is strictly after the source terminal.
    expect(childStarted?.sequence ?? 0).toBeGreaterThan(sourceTerminal?.sequence ?? 0);
    await broker.close();
  });

  it("a cancelled or declined gate is a bounded rejection with no side effects and may be re-requested", async () => {
    const { broker, clients } = makeBroker({ runnableAgents: ["zai", "dipu"], behaviors: ["hang"] });
    const conversationId = await makeConversation(["zai"], "Hello @zai");
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    const dispatch = broker.dispatchConversationMention({ conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: [] });
    await waitFor(() => broker.hasActiveRun(conversationId, "zai"));
    const gate = await broker.requestInitialHandoffGate(conversationId, "zai", { to: "dipu", text: "help" });
    if (gate.status !== "pending") throw new Error("expected pending");

    await broker.respondToConversationApproval({ conversationId, agent: "zai", requestId: gate.requestId, response: { cancelled: true } });
    expect(broker.hasPendingApproval(conversationId, "zai", gate.requestId)).toBe(false);

    // A declined root may request a fresh card while still active; a
    // confirmed:false response declines the same way.
    const again = await broker.requestInitialHandoffGate(conversationId, "zai", { to: "dipu", text: "help again" });
    expect(again.status).toBe("pending");
    if (again.status !== "pending") throw new Error("expected pending");
    await broker.respondToConversationApproval({ conversationId, agent: "zai", requestId: again.requestId, response: { confirmed: false } });
    expect(broker.hasPendingApproval(conversationId, "zai", again.requestId)).toBe(false);

    // No handoff event, no audience change, no child; the run completes normally.
    clients[0]?.settleCompleted();
    const outcome = await dispatch;
    expect(outcome.status).toBe("completed");
    expect(clients).toHaveLength(1);
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.map((e) => e.kind)).toEqual(["steward_message", "run_started", "run_finished"]);
    expect(events.some((e) => e.addressedAgent !== undefined)).toBe(false);
    const manifest = await readConversation({ vaultRoot: root, conversationId });
    expect(manifest.audience).toEqual(["zai"]);
    await broker.close();
  });

  it("a value response to a gate approval is a bounded rejection and clears the entry", async () => {
    const { broker, clients } = makeBroker({ runnableAgents: ["zai", "dipu"], behaviors: ["hang"] });
    const conversationId = await makeConversation(["zai"], "Hello @zai");
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    const dispatch = broker.dispatchConversationMention({ conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: [] });
    await waitFor(() => broker.hasActiveRun(conversationId, "zai"));
    const gate = await broker.requestInitialHandoffGate(conversationId, "zai", { to: "dipu", text: "help" });
    if (gate.status !== "pending") throw new Error("expected pending");

    await expect(
      broker.respondToConversationApproval({ conversationId, agent: "zai", requestId: gate.requestId, response: { value: "ok" } }),
    ).rejects.toThrow(/a handoff gate approval accepts only confirmed or cancelled/);
    expect(broker.hasPendingApproval(conversationId, "zai", gate.requestId)).toBe(false);
    // No side effects: never delivered to Pi, no handoff event, no audience change.
    expect(clients[0]?.responses).toHaveLength(0);
    await broker.abort(conversationId, "zai");
    await dispatch;
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.some((e) => e.kind === "agent_message")).toBe(false);
    await broker.close();
  });

  it("stale gate responses after settlement, abort, or close are bounded rejections with no child", async () => {
    // Source settles completed without confirmation: the pending gate is
    // cleared and a late confirm is a bounded stale rejection.
    const { broker, clients } = makeBroker({ runnableAgents: ["zai", "dipu"], behaviors: ["hang"] });
    const conversationId = await makeConversation(["zai"], "Hello @zai");
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    const dispatch = broker.dispatchConversationMention({ conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: [] });
    await waitFor(() => broker.hasActiveRun(conversationId, "zai"));
    const gate = await broker.requestInitialHandoffGate(conversationId, "zai", { to: "dipu", text: "help" });
    if (gate.status !== "pending") throw new Error("expected pending");
    clients[0]?.settleCompleted();
    await dispatch;
    await expect(
      broker.respondToConversationApproval({ conversationId, agent: "zai", requestId: gate.requestId, response: { confirmed: true } }),
    ).rejects.toThrow(/Unknown or stale approval request/);
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.some((e) => e.kind === "agent_message")).toBe(false);
    const manifest = await readConversation({ vaultRoot: root, conversationId });
    expect(manifest.audience).toEqual(["zai"]);
    expect(clients).toHaveLength(1);
    await broker.close();

    // Abort while the gate is pending: exactly one run_cancelled, no child,
    // and the late confirm is stale.
    const { broker: brokerB, clients: clientsB } = makeBroker({ runnableAgents: ["zai", "dipu"], behaviors: ["hang"] });
    const conversationB = await makeConversation(["zai"], "Hello @zai B");
    const stewardB = await makeStewardEvent(conversationB, "Go B");
    const dispatchB = brokerB.dispatchConversationMention({ conversationId: conversationB, agent: "zai", text: "Go B", stewardEventId: stewardB, priorEvents: [] });
    await waitFor(() => brokerB.hasActiveRun(conversationB, "zai"));
    const gateB = await brokerB.requestInitialHandoffGate(conversationB, "zai", { to: "dipu", text: "help" });
    if (gateB.status !== "pending") throw new Error("expected pending");
    const abortOutcome = await brokerB.abort(conversationB, "zai");
    expect(abortOutcome.status).toBe("cancelled");
    await dispatchB;
    const eventsB = await readConversationEvents({ vaultRoot: root, conversationId: conversationB });
    expect(eventsB.filter((e) => e.kind === "run_cancelled")).toHaveLength(1);
    expect(eventsB.some((e) => e.kind === "agent_message")).toBe(false);
    expect(clientsB).toHaveLength(1);
    await expect(
      brokerB.respondToConversationApproval({ conversationId: conversationB, agent: "zai", requestId: gateB.requestId, response: { confirmed: true } }),
    ).rejects.toThrow(/Unknown or stale approval request/);
    await brokerB.close();

    // close() while the gate is pending clears it with no child.
    const { broker: brokerC, clients: clientsC } = makeBroker({ runnableAgents: ["zai", "dipu"], behaviors: ["hang"] });
    const conversationC = await makeConversation(["zai"], "Hello @zai C");
    const stewardC = await makeStewardEvent(conversationC, "Go C");
    const dispatchC = brokerC.dispatchConversationMention({ conversationId: conversationC, agent: "zai", text: "Go C", stewardEventId: stewardC, priorEvents: [] });
    await waitFor(() => brokerC.hasActiveRun(conversationC, "zai"));
    const gateC = await brokerC.requestInitialHandoffGate(conversationC, "zai", { to: "dipu", text: "help" });
    if (gateC.status !== "pending") throw new Error("expected pending");
    await brokerC.close();
    expect(brokerC.hasPendingApproval(conversationC, "zai", gateC.requestId)).toBe(false);
    await dispatchC;
    expect(clientsC).toHaveLength(1);
    const eventsC = await readConversationEvents({ vaultRoot: root, conversationId: conversationC });
    expect(eventsC.some((e) => e.kind === "agent_message")).toBe(false);
  });

  it("timeout during a pending gate clears it and never launches a child", async () => {
    const timers = makeTimers();
    const { broker, clients } = makeBroker({ runnableAgents: ["zai", "dipu"], behaviors: ["hang"], timers });
    const conversationId = await makeConversation(["zai"], "Hello @zai");
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    const dispatch = broker.dispatchConversationMention({ conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: [] });
    await waitFor(() => broker.hasActiveRun(conversationId, "zai"));
    const gate = await broker.requestInitialHandoffGate(conversationId, "zai", { to: "dipu", text: "help" });
    if (gate.status !== "pending") throw new Error("expected pending");

    for (const handle of [...timers.pending.keys()]) timers.fire(handle);
    const outcome = await dispatch;
    expect(outcome.status).toBe("timed_out");
    expect(clients).toHaveLength(1);
    await expect(
      broker.respondToConversationApproval({ conversationId, agent: "zai", requestId: gate.requestId, response: { confirmed: true } }),
    ).rejects.toThrow(/Unknown or stale approval request/);
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.map((e) => e.kind)).toEqual(["steward_message", "run_started", "run_finished"]);
    expect(events.at(-1)?.runStatus).toBe("timed_out");
    expect(events.some((e) => e.kind === "agent_message")).toBe(false);
    await broker.close();
  });

  it("a workflow-stage run cannot request the initial gate (no extra gate)", async () => {
    const { broker, clients } = makeBroker({ runnableAgents: ["zai", "dipu"], behaviors: ["hang", "hang"] });
    const conversationId = await makeConversation(["zai"], "Hello @zai");
    const stewardEventId = await makeStewardEvent(conversationId, "Workflow");
    const dispatch = broker.dispatchConversationMention({ conversationId, agent: "zai", text: "Workflow", stewardEventId, priorEvents: [] });
    await waitFor(() => broker.hasActiveRun(conversationId, "zai"));
    // The root uses the delivered C5-1 acceptance path; stages need no gate.
    const accepted = await broker.requestConversationHandoff(conversationId, "zai", { to: "dipu", text: "Please review" });
    expect(accepted.status).toBe("accepted");
    clients[0]?.settleCompleted();
    await waitFor(() => broker.hasActiveRun(conversationId, "dipu"));

    // The workflow stage cannot request a NEW initial gate: bounded rejection,
    // no pending approval, no notification.
    const seen: ConversationApprovalNotification[] = [];
    broker.onConversationApproval(conversationId, (approval) => seen.push(approval));
    const gate = await broker.requestInitialHandoffGate(conversationId, "dipu", { to: "zai", text: "back" });
    expect(gate).toMatchObject({ status: "rejected" });
    if (gate.status === "rejected") {
      expect(gate.reason).toBe("only a steward-dispatched root run may request the initial handoff gate");
    }
    expect(seen).toHaveLength(0);
    expect(broker.hasPendingApproval(conversationId, "dipu", "gate-any")).toBe(false);

    // The stage may still use the delivered C5-1 bounded handoff path.
    const stageHandoff = await broker.requestConversationHandoff(conversationId, "dipu", { to: "zai", text: "back to lead" });
    expect(stageHandoff.status).toBe("accepted");
    await broker.abort(conversationId, "dipu");
    await dispatch;
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.filter((e) => e.kind === "agent_message" && typeof e.addressedAgent === "string")).toHaveLength(2);
    await broker.close();
  });

  it("gate requests are bounded: malformed, no eligible run, and duplicate-while-pending all reject", async () => {
    const { broker, clients } = makeBroker({ runnableAgents: ["zai", "dipu"], behaviors: ["hang"] });
    const conversationId = await makeConversation(["zai"], "Hello @zai");
    const stewardEventId = await makeStewardEvent(conversationId, "Go");
    const dispatch = broker.dispatchConversationMention({ conversationId, agent: "zai", text: "Go", stewardEventId, priorEvents: [] });
    await waitFor(() => broker.hasActiveRun(conversationId, "zai"));

    // Malformed {to,text}: bounded rejection, nothing registered.
    const malformed = await broker.requestInitialHandoffGate(conversationId, "zai", { to: "", text: "" });
    expect(malformed).toMatchObject({ status: "rejected" });
    if (malformed.status === "rejected") expect(malformed.reason).toBeTruthy();
    expect(broker.hasPendingApproval(conversationId, "zai", "gate-any")).toBe(false);

    // No eligible run (never dispatched / no C5 context).
    expect(await broker.requestInitialHandoffGate("never-dispatched", "zai", { to: "dipu", text: "help" })).toMatchObject({
      status: "rejected",
    });

    // A valid request registers; a duplicate while pending is a bounded rejection.
    const first = await broker.requestInitialHandoffGate(conversationId, "zai", { to: "dipu", text: "help" });
    expect(first.status).toBe("pending");
    if (first.status !== "pending") throw new Error("expected pending");
    const second = await broker.requestInitialHandoffGate(conversationId, "zai", { to: "dipu", text: "help again" });
    expect(second).toMatchObject({ status: "rejected" });
    if (second.status === "rejected") {
      expect(second.reason).toBe("an initial handoff gate is already pending");
    }
    expect(broker.hasPendingApproval(conversationId, "zai", first.requestId)).toBe(true);

    await broker.abort(conversationId, "zai");
    await dispatch;
    await broker.close();
  });
});
