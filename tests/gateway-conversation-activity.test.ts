import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayServer, type GatewayHandle } from "../src/gateway-http.js";
import { initVault } from "../src/init.js";
import { readConversationEvents } from "../src/conversations.js";

/**
 * U4 — gateway forwarding of broker-authoritative `conversation_activity`
 * frames on the existing scoped conversation SSE stream (accepted
 * `conversation-live-activity-contract.md`). One additive named frame; the
 * existing `conversation_event`/`approval`/heartbeat behavior is unchanged.
 * Uses the fake-Pi integration fixture so the broker emits real
 * working → text_delta → settled activity backed by durable evidence.
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

describe("Gateway conversation_activity stream forwarding (U4)", () => {
  let root: string;
  let server: GatewayServer;
  let handle: GatewayHandle;
  const token = "test-activity-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-gateway-activity-"));
    await initVault({ vaultRoot: root, agentName: "piren" });
  });

  afterEach(async () => {
    if (server !== undefined) await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function startServer(): Promise<void> {
    server = new GatewayServer({
      target: fakePiTarget(),
      authToken: token,
      vaultRoot: root,
      runnableAgents: ["fake"],
      targetBuilder: async () => fakePiTarget(),
    });
    handle = await server.start();
  }

  function url(path: string): string {
    return `http://${handle.hostname}:${handle.port}${path}`;
  }

  async function createConversationViaApi(text: string): Promise<string> {
    const response = await post(url("/api/conversations"), { text }, token);
    const body = (await response.json()) as { conversation?: { id: string } };
    const id = body.conversation?.id ?? "";
    if (id === "") throw new Error("create failed in setup");
    return id;
  }

  it("forwards working → text_delta → settled activity for the attached conversation only, with durable runAgent evidence", async () => {
    await startServer();
    const id = await createConversationViaApi("Activity seed @fake");

    const streamResponse = await fetch(url(`/api/conversations/${id}/events/stream`), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(streamResponse.status).toBe(200);
    const reader = streamResponse.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readStream = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes('"settled"')) break;
      }
    })();
    try {
      // Wait for the SSE subscription to be live, then send a second message
      // whose run generates broker activity.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await post(url(`/api/conversations/${id}/messages`), { text: "Live activity @fake" }, token);
      await Promise.race([readStream, new Promise((_, reject) => setTimeout(() => reject(new Error("stream timeout")), 8000))]);
    } finally {
      await reader.cancel().catch(() => {});
    }

    const frames = parseSseFrames(buffer);
    const activity = frames.filter((frame) => frame.type === "conversation_activity");
    expect(activity.length).toBeGreaterThanOrEqual(3);
    expect(activity[0]?.data).toMatchObject({ conversationId: id, kind: "working", runId: expect.any(String), agent: "fake" });
    expect(activity[0]?.data).not.toHaveProperty("delta");
    expect(activity[0]?.data).not.toHaveProperty("outcome");
    // Real fake-Pi text deltas ("Hel" + "lo") arrive as text_delta frames.
    const deltas = activity.filter((frame) => frame.data.kind === "text_delta");
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    for (const delta of deltas) {
      expect(typeof delta.data.delta).toBe("string");
      expect((delta.data.delta as string).length).toBeGreaterThan(0);
      expect(delta.data).not.toHaveProperty("outcome");
    }
    expect(activity.at(-1)?.data).toMatchObject({ kind: "settled", outcome: "completed" });
    expect(activity.at(-1)?.data).not.toHaveProperty("delta");
    // A single runId keys every activity frame for this run.
    const runIds = new Set(activity.map((frame) => frame.data.runId as string));
    expect(runIds.size).toBe(1);

    // Durable evidence with the new runAgent attribution (system-authored).
    const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
    const started = events.find((event) => event.kind === "run_started");
    const finished = events.find((event) => event.kind === "run_finished");
    expect(started?.runAgent).toBe("fake");
    expect(finished?.runAgent).toBe("fake");
    // The stream also carries the ordinary conversation_event frames unchanged.
    expect(frames.some((frame) => frame.type === "conversation_event")).toBe(true);
  });

  it("the stream stays Bearer-gated and scoped: no auth means no stream and no activity", async () => {
    await startServer();
    const id = await createConversationViaApi("Auth activity");
    const streamResponse = await fetch(url(`/api/conversations/${id}/events/stream`));
    expect(streamResponse.status).toBe(401);
    // No run was dispatched, so no activity can leak anywhere.
    const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
    expect(events.map((event) => event.kind)).toEqual(["steward_message"]);
  });
});
