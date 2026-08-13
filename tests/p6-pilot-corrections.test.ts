import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayServer, type GatewayHandle } from "../src/gateway-http.js";
import { initVault } from "../src/init.js";
import { readConversationEvents } from "../src/conversations.js";

/**
 * P6 — accepted pilot corrections (`conversation-p6-pilot-correction-contract.md`):
 * (a) truthful provider-error terminal for a settled run whose final assistant
 * record is a real error with empty text and no fallback policy (the pilot's
 * 403 case — never durably "completed", no fabricated agent_message); (b) the
 * exact nested Pi 0.83 RPC `message_update.assistantMessageEvent.text_delta`
 * extraction pin (with contentIndex/partial) → exactly one durable
 * agent_message, exact dispatched author, correlation, ordering, and no
 * duplicate on reread/stream.
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

describe("P6 gateway pilot corrections", () => {
  let root: string;
  let server: GatewayServer;
  let handle: GatewayHandle;
  const token = "test-p6-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-p6-"));
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

  async function createConversationViaApi(text: string): Promise<{ id: string }> {
    const response = await post(url("/api/conversations"), { text }, token);
    const body = (await response.json()) as Record<string, unknown>;
    return { id: (body.conversation as { id?: string } | undefined)?.id ?? "" };
  }

  async function eventKinds(conversationId: string): Promise<string[]> {
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    return events.map((e) => e.kind);
  }

  describe("1. truthful provider-error terminal (release blocker)", () => {
    it("a settled provider-error run with empty text and no fallback policy records failed/provider_error, no agent_message, no raw provider text", async () => {
      await startServer();
      const { id } = await createConversationViaApi("providererror-empty @fake");
      await waitForStreamValue(async () => (await eventKinds(id)).includes("run_finished"));
      const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
      expect(events.map((e) => e.kind)).toEqual(["steward_message", "run_started", "run_finished"]);
      const terminal = events.at(-1);
      expect(terminal?.runStatus).toBe("failed");
      expect(terminal?.failureKind).toBe("provider_error");
      expect(terminal?.correlationId).toBe(events[0]?.id);
      expect(terminal?.runAgent).toBe("fake");
      // N3: exact exhaustion-less bounded body; never raw provider text.
      expect(terminal?.body).toBe("Run ended with a provider error.");
      expect(terminal?.body).not.toContain("403");
      expect(terminal?.body).not.toContain("RegionError");
    });

    it("a genuinely empty normal completion still persists completed with no agent_message (P5 pin)", async () => {
      await startServer();
      const { id } = await createConversationViaApi("emptyoutput @fake");
      await waitForStreamValue(async () => (await eventKinds(id)).includes("run_finished"));
      const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
      expect(events.map((e) => e.kind)).toEqual(["steward_message", "run_started", "run_finished"]);
      expect(events.at(-1)?.runStatus).toBe("completed");
    });
  });

  describe("2. exact nested Pi 0.83 RPC extraction pin", () => {
    it("real nested message_update.assistantMessageEvent text deltas persist exactly one agent_message, ordered and authored as the dispatched agent", async () => {
      await startServer();
      const { id } = await createConversationViaApi("realnested @fake");
      await waitForStreamValue(async () => (await eventKinds(id)).includes("run_finished"));
      const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual(["steward_message", "run_started", "agent_message", "run_finished"]);
      const agentEvent = events.find((e) => e.kind === "agent_message");
      // The nested deltas concatenate in order: "Real " + "nested.".
      expect(agentEvent?.body).toBe("Real nested.");
      // Authored as the exact dispatched agent, correlated to the requester.
      expect(agentEvent?.author).toBe("fake");
      expect(agentEvent?.authorKind).toBe("agent");
      expect(agentEvent?.correlationId).toBe(events[0]?.id);
      const runStarted = events.findIndex((e) => e.kind === "run_started");
      const agentIndex = events.findIndex((e) => e.kind === "agent_message");
      const terminalIndex = events.findIndex((e) => e.kind === "run_finished");
      expect(runStarted).toBeLessThan(agentIndex);
      expect(agentIndex).toBeLessThan(terminalIndex);
    });

    it("an attached stream receives exactly one agent_message frame; a reread never duplicates it", async () => {
      await startServer();
      const { id } = await createConversationViaApi("Seed @fake");
      await waitForStreamValue(async () => (await eventKinds(id)).includes("run_finished"));

      const stream = await fetch(url(`/api/conversations/${id}/events/stream`), {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(stream.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const response = await post(url(`/api/conversations/${id}/messages`), { text: "realnested @fake" }, token);
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
      const eventFrames = parseSseFrames(buffer).filter((f) => f.type === "conversation_event");
      const kinds = eventFrames.map((f) => f.data.kind as string);
      const agentFrames = eventFrames.filter((f) => f.data.kind === "agent_message");
      expect(agentFrames).toHaveLength(1);
      expect(agentFrames[0]?.data.body).toBe("Real nested.");
      const runStarted = kinds.indexOf("run_started");
      const agentIndex = kinds.indexOf("agent_message");
      const terminalIndex = kinds.indexOf("run_finished");
      expect(runStarted).toBeGreaterThanOrEqual(0);
      expect(runStarted).toBeLessThan(agentIndex);
      expect(agentIndex).toBeLessThan(terminalIndex);

      // A whole-history reread yields exactly one durable agent_message per
      // run — the stream replay never duplicates the follow-up's message.
      const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
      const agentBodies = events.filter((e) => e.kind === "agent_message").map((e) => e.body);
      expect(agentBodies).toEqual(["Hello", "Real nested."]);
    });
  });
});
