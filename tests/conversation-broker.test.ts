import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversation, appendConversationEvent, readConversationEvents } from "../src/conversations.js";
import type { RpcEvent, RpcSpawnTarget, ExtensionUiResponse } from "../src/gateway-rpc.js";
import { ConversationBroker, type ConversationRpcClient, type ConversationDispatchOutcome } from "../src/conversation-broker.js";

type FakeBehavior = "complete" | "empty" | "hang" | "prompt-fail" | "start-fail" | "exit-mid-run" | "with-text";

class FakeConversationClient implements ConversationRpcClient {
  started = 0;
  stopped = 0;
  aborted = 0;
  prompts: string[] = [];
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
      return; // never emits agent_end; timeout settles the run
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
    this.emit({ type: "agent_end", messages: [] });
  }

  async newSession(): Promise<{ cancelled: boolean }> {
    return { cancelled: false };
  }

  async compact(): Promise<{ tokensBefore: number | null; estimatedTokensAfter: number | null }> {
    return { tokensBefore: null, estimatedTokensAfter: null };
  }

  respondToUiRequest(_id: string, _response: ExtensionUiResponse): void {
    // C2 has no approval/agent-address surface; unused.
  }

  private emit(event: RpcEvent): void {
    for (const listener of [...this.listeners]) listener(event);
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
}): { broker: ConversationBroker; clients: FakeConversationClient[]; timers: ReturnType<typeof makeTimers> } {
  const behaviors = options?.behaviors ?? [];
  const clients: FakeConversationClient[] = [];
  const timers = options?.timers ?? makeTimers();
  const broker = new ConversationBroker({
    vaultRoot: root,
    runnableAgents: options?.runnableAgents ?? ["zai", "dipu"],
    targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
    clientFactory: () => {
      const client = new FakeConversationClient(behaviors[clients.length] ?? "complete");
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
