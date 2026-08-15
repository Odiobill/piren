import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONVERSATION_EVENT_KINDS,
  appendConversationEvent,
  createConversation,
  createConversationForAgentStart,
  readConversation,
  readConversationEvents,
  transitionConversationLifecycle,
} from "../src/conversations.js";
import {
  ConversationBroker,
  buildConversationAgentStartPrompt,
  type ConversationRpcClient,
} from "../src/conversation-broker.js";
import type { RpcEvent, RpcSpawnTarget, ExtensionUiResponse } from "../src/gateway-rpc.js";
import { initVault } from "../src/init.js";

type StartFakeBehavior = "complete" | "with-text" | "start-fail" | "prompt-fail" | "exit-mid-run" | "provider-error-empty";

/** Minimal fake ConversationRpcClient for the ADR-0044 broker start path. */
class FakeStartClient implements ConversationRpcClient {
  started = 0;
  stopped = 0;
  aborted = 0;
  prompts: string[] = [];
  responses: { id: string; response: ExtensionUiResponse }[] = [];
  private listeners: Array<(event: RpcEvent) => void> = [];
  private exitListeners: Array<() => void> = [];

  constructor(public behavior: StartFakeBehavior) {}

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
    if (this.behavior === "exit-mid-run") {
      for (const listener of [...this.exitListeners]) listener();
      return;
    }
    if (this.behavior === "with-text") {
      this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello, steward!" } });
    }
    if (this.behavior === "provider-error-empty") {
      const record = { role: "assistant", content: [], stopReason: "error", errorMessage: "403 provider error (fake)" };
      this.emit({ type: "message_start", message: record });
      this.emit({ type: "message_end", message: record });
      this.emit({ type: "turn_end", message: { ...record, toolResults: [] } });
      this.emit({ type: "agent_end", messages: [record], willRetry: false });
      this.emit({ type: "agent_settled" });
      return;
    }
    this.emit({ type: "agent_end", messages: [] });
    this.emit({ type: "agent_settled" });
  }

  respondToUiRequest(id: string, response: ExtensionUiResponse): void {
    this.responses.push({ id, response });
  }

  async steer(): Promise<void> {}

  async newSession(): Promise<{ cancelled: boolean }> {
    return { cancelled: false };
  }

  async compact(): Promise<{ tokensBefore: number | null; estimatedTokensAfter: number | null }> {
    return { tokensBefore: null, estimatedTokensAfter: null };
  }

  private emit(event: RpcEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

function makeStartBroker(options?: {
  runnableAgents?: string[];
  behaviors?: StartFakeBehavior[];
}): { broker: ConversationBroker; clients: FakeStartClient[]; targets: RpcSpawnTarget[] } {
  const behaviors = options?.behaviors ?? [];
  const clients: FakeStartClient[] = [];
  const targets: RpcSpawnTarget[] = [];
  const broker = new ConversationBroker({
    vaultRoot: root,
    runnableAgents: options?.runnableAgents ?? ["dipu", "zai"],
    targetBuilder: async (agent): Promise<RpcSpawnTarget> => ({ command: "fake", args: [agent], cwd: root, env: {} }),
    clientFactory: (target: RpcSpawnTarget) => {
      targets.push(target);
      const client = new FakeStartClient(behaviors[clients.length] ?? "complete");
      clients.push(client);
      return client;
    },
    now: tick,
    nonce: () => `n${++nonceSeq}`,
    runTimeoutMs: 60_000,
  });
  return { broker, clients, targets };
}

/** Create a started conversation + its durable system origin event; returns ids. */
async function makeStartedConversation(agent = "dipu"): Promise<{ conversationId: string; originEventId: string }> {
  const conversation = await createConversationForAgentStart({ vaultRoot: root, agent, now: tick });
  const origin = await appendConversationEvent({
    vaultRoot: root,
    conversationId: conversation.id,
    kind: "conversation_start_requested",
    authorKind: "system",
    author: "system",
    body: `The steward requested starting this conversation with agent '${agent}'.`,
    now: tick,
    nonce: () => `s${++nonceSeq}`,
  });
  return { conversationId: conversation.id, originEventId: origin.id };
}

/**
 * ADR-0044 — durable agent-first Conversation start core (Tracer 1).
 *
 * `createConversationForAgentStart` is the narrow durable start creation
 * path: an open Conversation with `audience: [agent]` and the deterministic
 * title `Conversation with <agent>` (the validated agent name, never
 * LLM/text-derived). It does NOT weaken the existing text-first
 * `createConversation` API. The additive `conversation_start_requested`
 * event kind is system-authored durable origin/correlation evidence.
 */

let root: string;
let nonceSeq = 0;
const NOW = new Date("2026-08-15T13:00:00.000Z");
let clockMs = 0;
function tick(): Date {
  clockMs += 1;
  return new Date(NOW.getTime() + clockMs);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-conversation-agent-start-"));
  await initVault({ vaultRoot: root, agentName: "piren" });
  nonceSeq = 0;
  clockMs = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("createConversationForAgentStart (ADR-0044 durable start core)", () => {
  it("creates an open Conversation with audience [agent] and the deterministic agent-name title", async () => {
    const conversation = await createConversationForAgentStart({ vaultRoot: root, agent: "dipu", now: tick });
    expect(conversation.status).toBe("open");
    expect(conversation.audience).toEqual(["dipu"]);
    expect(conversation.title).toBe("Conversation with dipu");
    expect(conversation.createdBy).toBe("steward");

    // P2 neutral id shape (no agent/text-derived slug content).
    expect(conversation.id).toMatch(/^\d{8}T\d{9}Z-c-[0-9a-f]{12}$/);

    const reread = await readConversation({ vaultRoot: root, conversationId: conversation.id });
    expect(reread.title).toBe("Conversation with dipu");
    expect(reread.audience).toEqual(["dipu"]);
    expect(reread.status).toBe("open");
  });

  it("rejects blank and malformed agent names before any durable write", async () => {
    for (const bad of ["", "   ", "Dipu", "di_pu", "dipu!", "../x"]) {
      await expect(createConversationForAgentStart({ vaultRoot: root, agent: bad, now: tick })).rejects.toThrow(
        /Invalid conversation agent name/,
      );
    }
    const conversationsDir = join(root, "collaboration", "conversations");
    await expect(readdir(conversationsDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not weaken the text-first createConversation API", async () => {
    await expect(createConversation({ vaultRoot: root, text: "", audience: [], now: tick })).rejects.toThrow(
      "Conversation first message text is required.",
    );
    await expect(createConversation({ vaultRoot: root, text: "   ", audience: [], now: tick })).rejects.toThrow(
      "Conversation first message text is required.",
    );
  });
});

describe("conversation_start_requested event kind (ADR-0044 system origin)", () => {
  it("is an additive member of the durable event-kind union", () => {
    expect(CONVERSATION_EVENT_KINDS).toContain("conversation_start_requested");
  });

  it("persists as a system-authored durable event on the started conversation", async () => {
    const conversation = await createConversationForAgentStart({ vaultRoot: root, agent: "dipu", now: tick });
    const event = await appendConversationEvent({
      vaultRoot: root,
      conversationId: conversation.id,
      kind: "conversation_start_requested",
      authorKind: "system",
      author: "system",
      body: "The steward requested starting this conversation with agent 'dipu'.",
      now: tick,
      nonce: () => `s${++nonceSeq}`,
    });
    expect(event.kind).toBe("conversation_start_requested");

    const events = await readConversationEvents({ vaultRoot: root, conversationId: conversation.id });
    expect(events).toHaveLength(1);
    const origin = events[0];
    expect(origin?.kind).toBe("conversation_start_requested");
    expect(origin?.authorKind).toBe("system");
    expect(origin?.author).toBe("system");
    expect(origin?.body).toBe("The steward requested starting this conversation with agent 'dipu'.");
    expect(origin?.sequence).toBe(1);
  });
});

describe("buildConversationAgentStartPrompt (ADR-0044 bounded greeting prompt)", () => {
  it("asks only for one brief bounded greeting and to stop, with no steward-message framing", () => {
    const prompt = buildConversationAgentStartPrompt({ conversationId: "conv-1", agent: "dipu" });
    expect(prompt).toContain("conversation 'conv-1'");
    expect(prompt).toContain("agent 'dipu'");
    expect(prompt).toContain("steward");
    expect(prompt).toMatch(/brief bounded greeting/i);
    expect(prompt).toMatch(/then stop/i);
    expect(prompt).toContain("Do not address, mention, or dispatch other agents");
    expect(prompt).toContain("no new authority");
    // Never the mention-dispatch framing and no transcript replay section.
    expect(prompt).not.toContain("Steward request:");
    expect(prompt).not.toContain("steward_message event");
    expect(prompt).not.toContain("Prior conversation context");
    // Never the C5 workflow framing.
    expect(prompt).not.toContain("workflow");
    expect(prompt).not.toContain("conversation_handoff");
  });
});

describe("ConversationBroker.startConversationAgentRun (ADR-0044 separately typed start path)", () => {
  it("runs the bounded greeting: run_started, agent greeting, and completed terminal all correlate to the origin event", async () => {
    const { broker, clients } = makeStartBroker({ behaviors: ["with-text"] });
    const { conversationId, originEventId } = await makeStartedConversation();
    const outcome = await broker.startConversationAgentRun({ conversationId, agent: "dipu", originEventId });

    expect(outcome.status).toBe("completed");
    expect(clients).toHaveLength(1);
    expect(clients[0]?.prompts).toHaveLength(1);
    expect(clients[0]?.prompts[0]).toBe(buildConversationAgentStartPrompt({ conversationId, agent: "dipu" }));

    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.map((e) => [e.kind, e.runStatus])).toEqual([
      ["conversation_start_requested", undefined],
      ["run_started", "running"],
      ["agent_message", undefined],
      ["run_finished", "completed"],
    ]);
    // Origin is first (durable order) and every run event correlates to it.
    expect(events[0]?.id).toBe(originEventId);
    expect(events[1]?.correlationId).toBe(originEventId);
    expect(events[2]?.correlationId).toBe(originEventId);
    expect(events[3]?.correlationId).toBe(originEventId);
    expect(events[2]?.author).toBe("dipu");
    expect(events[2]?.body).toBe("Hello, steward!");
    await broker.close();
  });

  it("spawns the isolated run WITHOUT the C5 handoff env flag and grants no handoff authority", async () => {
    const { broker, targets } = makeStartBroker({ behaviors: ["with-text"] });
    const { conversationId, originEventId } = await makeStartedConversation();
    await broker.startConversationAgentRun({ conversationId, agent: "dipu", originEventId });

    expect(targets).toHaveLength(1);
    const env = (targets[0]?.env ?? {}) as Record<string, string>;
    expect(env.PIREN_CONVERSATION_HANDOFF_ENABLED).toBeUndefined();

    // A completed start run holds no handoff eligibility at all.
    const handoff = await broker.requestConversationHandoff(conversationId, "dipu", { to: "zai", text: "help" });
    expect(handoff.status).toBe("rejected");
    if (handoff.status === "rejected") {
      expect(handoff.reason).toBe("no eligible conversation handoff run");
    }
    await broker.close();
  });

  it("records launch_failure correlated to the origin when the client cannot start (no run_started)", async () => {
    const { broker } = makeStartBroker({ behaviors: ["start-fail"] });
    const { conversationId, originEventId } = await makeStartedConversation();
    const outcome = await broker.startConversationAgentRun({ conversationId, agent: "dipu", originEventId });

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failureKind).toBe("launch_failure");
    }
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.map((e) => e.kind)).toEqual(["conversation_start_requested", "run_finished"]);
    expect(events[1]?.correlationId).toBe(originEventId);
    expect(events[1]?.failureKind).toBe("launch_failure");
    expect(events[1]?.runAgent).toBe("dipu");
    await broker.close();
  });

  it("records ambiguous failed terminals correlated to the origin on prompt failure or mid-run exit", async () => {
    for (const behavior of ["prompt-fail", "exit-mid-run"] as StartFakeBehavior[]) {
      const { broker } = makeStartBroker({ behaviors: [behavior] });
      const { conversationId, originEventId } = await makeStartedConversation();
      const outcome = await broker.startConversationAgentRun({ conversationId, agent: "dipu", originEventId });
      expect(outcome.status).toBe("failed");
      if (outcome.status === "failed") {
        expect(outcome.failureKind).toBe("ambiguous");
      }
      const events = await readConversationEvents({ vaultRoot: root, conversationId });
      const terminal = events.at(-1);
      expect(terminal?.kind).toBe("run_finished");
      expect(terminal?.runStatus).toBe("failed");
      expect(terminal?.failureKind).toBe("ambiguous");
      expect(terminal?.correlationId).toBe(originEventId);
      await broker.close();
    }
  });

  it("records a truthful provider_error terminal correlated to the origin for a settled zero-side-effect provider error", async () => {
    const { broker } = makeStartBroker({ behaviors: ["provider-error-empty"] });
    const { conversationId, originEventId } = await makeStartedConversation();
    const outcome = await broker.startConversationAgentRun({ conversationId, agent: "dipu", originEventId });

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failureKind).toBe("provider_error");
    }
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    const terminal = events.at(-1);
    expect(terminal?.failureKind).toBe("provider_error");
    expect(terminal?.correlationId).toBe(originEventId);
    // No fabricated agent_message for an empty provider-error output.
    expect(events.some((e) => e.kind === "agent_message")).toBe(false);
    await broker.close();
  });

  it("preserves the one active conversation × agent run invariant (conflict, never queued)", async () => {
    const { broker } = makeStartBroker({ behaviors: ["complete", "complete"] });
    const { conversationId, originEventId } = await makeStartedConversation();
    const first = broker.startConversationAgentRun({ conversationId, agent: "dipu", originEventId });
    await expect(
      broker.startConversationAgentRun({ conversationId, agent: "dipu", originEventId }),
    ).rejects.toThrow(/already active/);
    const outcome = await first;
    expect(outcome.status).toBe("completed");
    await broker.close();
  });

  it("rejects non-member, non-runnable, archived, and missing conversations before any run evidence", async () => {
    const { broker } = makeStartBroker();

    // Non-member: agent is runnable but not in the durable audience.
    const other = await createConversationForAgentStart({ vaultRoot: root, agent: "zai", now: tick });
    await expect(
      broker.startConversationAgentRun({ conversationId: other.id, agent: "dipu", originEventId: "origin-x" }),
    ).rejects.toThrow(/not a member of conversation/);

    // Non-runnable: agent is a member but not in the local runnable set.
    const { broker: limited } = makeStartBroker({ runnableAgents: ["zai"] });
    const { conversationId, originEventId } = await makeStartedConversation("dipu");
    await expect(
      limited.startConversationAgentRun({ conversationId, agent: "dipu", originEventId }),
    ).rejects.toThrow(/not in the runnable set/);

    // Archived.
    const archived = await createConversationForAgentStart({ vaultRoot: root, agent: "dipu", now: tick });
    await transitionConversationLifecycle({ vaultRoot: root, conversationId: archived.id, transition: "archive", now: tick });
    await expect(
      broker.startConversationAgentRun({ conversationId: archived.id, agent: "dipu", originEventId: "origin-y" }),
    ).rejects.toThrow(/is archived/);

    // Missing.
    await expect(
      broker.startConversationAgentRun({ conversationId: "missing-conversation", agent: "dipu", originEventId: "origin-z" }),
    ).rejects.toThrow(/Conversation not found/);

    // None of the rejections appended run evidence.
    for (const id of [other.id, conversationId, archived.id]) {
      const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
      expect(events.some((e) => e.kind === "run_started" || e.kind === "run_finished" || e.kind === "run_cancelled")).toBe(false);
    }
    await broker.close();
    await limited.close();
  });
});

describe("ADR-0044 origin publish ordering (the exact gateway mechanism)", () => {
  it("scoped live subscribers receive the committed origin BEFORE any run evidence", async () => {
    const { broker } = makeStartBroker({ behaviors: ["with-text"] });
    const { conversationId, originEventId } = await makeStartedConversation();

    const observed: string[] = [];
    const unsubscribe = broker.onConversationEvent(conversationId, (event) => {
      observed.push(event.kind);
    });
    try {
      // The gateway's exact sequence: publish the committed durable origin
      // record first, then invoke the broker start path.
      broker.publishConversationEvent(conversationId, {
        id: originEventId,
        conversationId,
        kind: "conversation_start_requested",
        authorKind: "system",
        author: "system",
        created: tick().toISOString(),
        sequence: 1,
        mentions: [],
        body: "The steward requested starting this conversation with agent 'dipu'.",
        path: `collaboration/conversations/${conversationId}/events/00000001.md`,
      });
      await broker.startConversationAgentRun({ conversationId, agent: "dipu", originEventId });
    } finally {
      unsubscribe();
    }
    expect(observed).toEqual(["conversation_start_requested", "run_started", "agent_message", "run_finished"]);
    await broker.close();
  });
});
