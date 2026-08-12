import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayServer, type GatewayHandle } from "../src/gateway-http.js";
import { initVault } from "../src/init.js";
import { readConversation, readConversationEvents } from "../src/conversations.js";

/**
 * P5 — pilot corrections (accepted `conversation-pilot-correction-contract.md`):
 * durable live-event parity (gateway-persisted steward events published to
 * scoped live subscribers BEFORE broker dispatch), single-member default
 * dispatch, automatic steer of an exact active run via the existing Pi RPC
 * capability, and empty-output diagnosis (no fabricated agent_message).
 */

const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");

function fakePiTarget() {
  return {
    command: process.execPath,
    args: [fakePiScript],
    cwd: process.cwd(),
    env: process.env,
  };
}

async function post(url: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
}

async function waitForStreamValue(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("stream condition not met in time");
}

function parseSseFrames(buffer: string): Array<{ type: string; data: Record<string, unknown> }> {
  const frames: Array<{ type: string; data: Record<string, unknown> }> = [];
  for (const block of buffer.split("\n\n")) {
    const type = /^event: (.+)$/m.exec(block)?.[1];
    const raw = /^data: (.+)$/m.exec(block)?.[1];
    if (type === undefined || raw === undefined) continue;
    try {
      const data = JSON.parse(raw) as unknown;
      if (typeof data === "object" && data !== null) frames.push({ type, data: data as Record<string, unknown> });
    } catch {
      // Test helper: incomplete stream chunks are not complete frames.
    }
  }
  return frames;
}

describe("P5 gateway pilot corrections", () => {
  let root: string;
  let server: GatewayServer;
  let handle: GatewayHandle;
  const token = "test-p5-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-p5-"));
    await initVault({ vaultRoot: root, agentName: "piren" });
  });

  afterEach(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function startServer(options?: { runnableAgents?: string[] }): Promise<void> {
    server = new GatewayServer({
      target: fakePiTarget(),
      authToken: token,
      vaultRoot: root,
      runnableAgents: options?.runnableAgents ?? ["fake"],
      targetBuilder: async () => fakePiTarget(),
    });
    handle = await server.start();
  }

  function url(path: string): string {
    return `http://${handle.hostname}:${handle.port}${path}`;
  }

  async function createConversationViaApi(text: string): Promise<{ id: string; body: Record<string, unknown> }> {
    const response = await post(url("/api/conversations"), { text }, token);
    const body = (await response.json()) as Record<string, unknown>;
    return { id: (body.conversation as { id?: string } | undefined)?.id ?? "", body };
  }

  async function eventKinds(conversationId: string): Promise<string[]> {
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    return events.map((e) => e.kind);
  }

  describe("1. durable live-event parity", () => {
    it("an attached stream receives the gateway-persisted steward requester BEFORE the broker run_started", async () => {
      await startServer();
      const { id } = await createConversationViaApi("Seed @fake");
      await waitForStreamValue(async () => (await eventKinds(id)).includes("run_finished"));

      const stream = await fetch(url(`/api/conversations/${id}/events/stream`), {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(stream.status).toBe(200);
      // Give the subscription a moment to attach, then send a follow-up.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const response = await post(url(`/api/conversations/${id}/messages`), { text: "Follow up @fake" }, token);
      expect(response.status).toBe(200);

      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("run_finished")) break;
      }
      const kinds = parseSseFrames(buffer)
        .filter((f) => f.type === "conversation_event")
        .map((f) => f.data.kind as string);
      const stewardIndex = kinds.indexOf("steward_message");
      const runStartedIndex = kinds.indexOf("run_started");
      expect(stewardIndex).toBeGreaterThanOrEqual(0);
      expect(runStartedIndex).toBeGreaterThanOrEqual(0);
      expect(stewardIndex).toBeLessThan(runStartedIndex);
      // The full safe event shape is published (id/conversationId/kind/sequence/body).
      const stewardFrame = parseSseFrames(buffer).find(
        (f) => f.type === "conversation_event" && f.data.kind === "steward_message",
      );
      expect(stewardFrame?.data.id).toBeDefined();
      expect(stewardFrame?.data.conversationId).toBe(id);
      expect(stewardFrame?.data.sequence).toBeGreaterThanOrEqual(1);
      expect(stewardFrame?.data.body).toBe("Follow up @fake");
    });
  });

  describe("2. single-member default dispatch", () => {
    it("the first zero-mention create stays context-only (no dispatch, empty audience)", async () => {
      await startServer();
      const { id, body } = await createConversationViaApi("Just context");
      expect((body as { dispatch?: unknown }).dispatch).toBeUndefined();
      expect(await eventKinds(id)).toEqual(["steward_message"]);
      expect((await readConversation({ vaultRoot: root, conversationId: id })).audience).toEqual([]);
    });

    it("a first explicit mention establishes membership and dispatches as today", async () => {
      await startServer();
      const { id, body } = await createConversationViaApi("Please @fake");
      const typed = body as { conversation: { audience: string[] }; dispatch?: { agent: string; status: string }[] };
      expect(typed.conversation.audience).toEqual(["fake"]);
      expect(typed.dispatch).toEqual([{ agent: "fake", status: "completed" }]);
      expect(await eventKinds(id)).toEqual(["steward_message", "run_started", "agent_message", "run_finished"]);
    });

    it("a zero-mention message in a single-member conversation dispatches the sole durable member without changing audience", async () => {
      await startServer();
      const { id } = await createConversationViaApi("Seed @fake");
      await waitForStreamValue(async () => (await eventKinds(id)).includes("run_finished"));

      const response = await post(url(`/api/conversations/${id}/messages`), { text: "Context only follow-up" }, token);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { dispatch?: { agent: string; status: string }[] };
      expect(body.dispatch).toEqual([{ agent: "fake", status: "completed" }]);
      const kinds = await eventKinds(id);
      expect(kinds.filter((k) => k === "steward_message")).toHaveLength(2);
      expect(kinds.filter((k) => k === "run_finished")).toHaveLength(2);
      expect((await readConversation({ vaultRoot: root, conversationId: id })).audience).toEqual(["fake"]);
    });

    it("a zero-mention message in a multi-member conversation stays context-only", async () => {
      await startServer({ runnableAgents: ["fake", "fake2"] });
      const { id } = await createConversationViaApi("Seed @fake @fake2");
      await waitForStreamValue(async () => (await eventKinds(id)).filter((k) => k === "run_finished").length === 2);

      const response = await post(url(`/api/conversations/${id}/messages`), { text: "Context only" }, token);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { dispatch?: unknown };
      expect(body.dispatch).toBeUndefined();
      const kinds = await eventKinds(id);
      expect(kinds.filter((k) => k === "steward_message")).toHaveLength(2);
      expect(kinds.filter((k) => k === "run_finished")).toHaveLength(2);
    });

    it("an invalid mention still fails atomically before any write", async () => {
      await startServer({ runnableAgents: ["fake"] });
      const { id } = await createConversationViaApi("Seed @fake");
      await waitForStreamValue(async () => (await eventKinds(id)).includes("run_finished"));
      const response = await post(url(`/api/conversations/${id}/messages`), { text: "Bad @ghost" }, token);
      expect(response.status).toBe(400);
      expect((await eventKinds(id)).filter((k) => k === "steward_message")).toHaveLength(1);
    });
  });

  describe("3. automatic steer of an active exact run", () => {
    async function startHangingRun(id: string): Promise<void> {
      // Fire-and-forget: the hang run stays active until settle/abort, so the
      // POST itself resolves only when the run settles (server.close aborts it
      // in afterEach cleanup). We wait on the durable run_started instead.
      void post(url(`/api/conversations/${id}/messages`), { text: "hang @fake" }, token).catch(() => {});
      await waitForStreamValue(async () => (await eventKinds(id)).filter((k) => k === "run_started").length >= 2);
    }

    it("a single-member zero-mention message steers the sole member's active run and fabricates no run/status evidence", { timeout: 20000 }, async () => {
      await startServer();
      const { id } = await createConversationViaApi("Seed @fake");
      await waitForStreamValue(async () => (await eventKinds(id)).includes("run_finished"));
      await startHangingRun(id);

      const response = await post(url(`/api/conversations/${id}/messages`), { text: "steer the active run" }, token);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { dispatch?: { agent: string; status: string }[] };
      expect(body.dispatch).toEqual([{ agent: "fake", status: "steered" }]);
      // No new run/terminal/status/membership evidence was appended.
      const kinds = await eventKinds(id);
      expect(kinds.filter((k) => k === "steward_message")).toHaveLength(3);
      expect(kinds.filter((k) => k === "run_started")).toHaveLength(2);
      expect(kinds.filter((k) => k === "run_finished")).toHaveLength(1);
      expect((await readConversation({ vaultRoot: root, conversationId: id })).audience).toEqual(["fake"]);
    });

    it("exactly one explicit mention targeting an active run steers that exact client", { timeout: 20000 }, async () => {
      await startServer();
      const { id } = await createConversationViaApi("Seed @fake");
      await waitForStreamValue(async () => (await eventKinds(id)).includes("run_finished"));
      await startHangingRun(id);

      const response = await post(url(`/api/conversations/${id}/messages`), { text: "steer please @fake" }, token);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { dispatch?: { agent: string; status: string }[] };
      expect(body.dispatch).toEqual([{ agent: "fake", status: "steered" }]);
    });

    it("steer rejection leaves the message durable and returns a bounded steer-failed entry", { timeout: 20000 }, async () => {
      await startServer();
      const { id } = await createConversationViaApi("Seed @fake");
      await waitForStreamValue(async () => (await eventKinds(id)).includes("run_finished"));
      await startHangingRun(id);

      const response = await post(url(`/api/conversations/${id}/messages`), { text: "steerfail please" }, token);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { dispatch?: { agent: string; status: string }[] };
      expect(body.dispatch).toEqual([{ agent: "fake", status: "steer-failed" }]);
      // The message stays durable; no run evidence changed.
      const kinds = await eventKinds(id);
      expect(kinds.filter((k) => k === "steward_message")).toHaveLength(3);
      expect(kinds.filter((k) => k === "run_finished")).toHaveLength(1);
    });

    it("a target with no active run follows existing dispatch behavior", async () => {
      await startServer();
      const { id } = await createConversationViaApi("Seed @fake");
      await waitForStreamValue(async () => (await eventKinds(id)).includes("run_finished"));

      const response = await post(url(`/api/conversations/${id}/messages`), { text: "run again" }, token);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { dispatch?: { agent: string; status: string }[] };
      expect(body.dispatch).toEqual([{ agent: "fake", status: "completed" }]);
    });

    it("a multi-recipient message keeps normal dispatch/conflict behavior (no steer guess)", async () => {
      await startServer({ runnableAgents: ["fake", "fake2"] });
      const { id } = await createConversationViaApi("Seed @fake @fake2");
      await waitForStreamValue(async () => (await eventKinds(id)).filter((k) => k === "run_finished").length === 2);

      const response = await post(url(`/api/conversations/${id}/messages`), { text: "both @fake @fake2" }, token);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { dispatch?: { agent: string; status: string }[] };
      expect(body.dispatch).toEqual([
        { agent: "fake", status: "completed" },
        { agent: "fake2", status: "completed" },
      ]);
    });
  });

  describe("6. empty-output diagnosis (no fabricated agent message)", () => {
    it("non-empty supported assistant text persists one agent_message BEFORE the completed terminal", async () => {
      await startServer();
      const { id } = await createConversationViaApi("Seed @fake");
      await waitForStreamValue(async () => (await eventKinds(id)).includes("run_finished"));
      const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
      const kinds = events.map((e) => e.kind);
      const agentIndex = kinds.indexOf("agent_message");
      const terminalIndex = kinds.indexOf("run_finished");
      expect(agentIndex).toBeGreaterThanOrEqual(0);
      expect(agentIndex).toBeLessThan(terminalIndex);
      expect(events[agentIndex]?.body).toBe("Hello");
    });

    it("an actual empty completed output persists NO agent_message; the completed terminal remains durable", async () => {
      await startServer();
      const { id } = await createConversationViaApi("emptyoutput @fake");
      await waitForStreamValue(async () => (await eventKinds(id)).includes("run_finished"));
      const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
      expect(events.map((e) => e.kind)).toEqual(["steward_message", "run_started", "run_finished"]);
      expect(events.at(-1)?.runStatus).toBe("completed");
    });
  });
});
