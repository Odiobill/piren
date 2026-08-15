import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { GatewayServer, type GatewayHandle } from "../src/gateway-http.js";
import { initVault } from "../src/init.js";
import { listConversations, readConversationEvents } from "../src/conversations.js";

const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");

function fakePiTarget() {
  return {
    command: process.execPath,
    args: [fakePiScript],
    cwd: process.cwd(),
    env: process.env,
  };
}

async function post(url: string, body: unknown, token?: string, raw?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  return fetch(url, { method: "POST", headers, body: raw ?? JSON.stringify(body) });
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
      // incomplete chunk: not a complete frame
    }
  }
  return frames;
}

/**
 * ADR-0044 — authenticated POST /api/conversations/start (gateway-authoritative
 * agent-first Conversation start) against the fake-Pi fixture.
 *
 * The route accepts exactly `{agent}`, validates the steward-selected agent
 * against the gateway-resolved local runnable set BEFORE any vault
 * persistence or broker dispatch, creates the durable Conversation with the
 * deterministic `Conversation with <agent>` title and `audience: [agent]`,
 * persists the system-authored `conversation_start_requested` origin event
 * after the manifest and BEFORE dispatch, publishes that exact committed
 * record to the scoped SSE stream before any run evidence, and drives the
 * separately typed broker start path (bounded greeting, no C5/handoff).
 */
describe("POST /api/conversations/start (ADR-0044)", () => {
  let root: string;
  let server: GatewayServer | undefined;
  let handle: GatewayHandle;
  const token = "test-conversation-start-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-gateway-conversation-start-"));
    await initVault({ vaultRoot: root, agentName: "piren" });
  });

  afterEach(async () => {
    if (server !== undefined) await server.close();
    server = undefined;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function startServer(options?: {
    withConversations?: boolean;
    runnableAgents?: string[];
    vaultAgents?: string[];
    targetBuilder?: (agent: string) => Promise<ReturnType<typeof fakePiTarget>>;
  }): Promise<void> {
    const withConversations = options?.withConversations ?? true;
    server = new GatewayServer({
      target: fakePiTarget(),
      authToken: token,
      ...(withConversations
        ? {
            vaultRoot: root,
            runnableAgents: options?.runnableAgents ?? ["fake"],
            vaultAgents: options?.vaultAgents ?? ["fake"],
            targetBuilder: options?.targetBuilder ?? (async () => fakePiTarget()),
          }
        : {}),
    });
    handle = await server.start();
  }

  function url(path: string): string {
    return `http://${handle.hostname}:${handle.port}${path}`;
  }

  async function persistedConversationCount(): Promise<number> {
    try {
      return (await readdir(join(root, "collaboration", "conversations"))).length;
    } catch {
      return 0;
    }
  }

  it("requires Bearer auth and the conversation capability", async () => {
    await startServer({ withConversations: false });
    const capabilityMissing = await post(url("/api/conversations/start"), { agent: "fake" }, token);
    expect(capabilityMissing.status).toBe(404);

    await startServer({ withConversations: true });
    const noAuth = await post(url("/api/conversations/start"), { agent: "fake" });
    expect(noAuth.status).toBe(401);
  });

  it("rejects malformed, missing, non-string, blank, and extra-key bodies with 400 and zero persistence/dispatch", async () => {
    await startServer();
    const cases: Array<{ raw?: string; body?: unknown }> = [
      { raw: "not json" },
      { body: {} },
      { body: { agent: 1 } },
      { body: { agent: "" } },
      { body: { agent: "   " } },
      { body: { agent: "fake", text: "hello" } },
      { body: { agent: "fake", agent2: "fake" } },
      { body: { text: "@fake" } },
      { body: [] },
    ];
    for (const entry of cases) {
      const response =
        entry.raw !== undefined
          ? await post(url("/api/conversations/start"), undefined, token, entry.raw)
          : await post(url("/api/conversations/start"), entry.body, token);
      expect(response.status, JSON.stringify(entry)).toBe(400);
    }
    expect(await persistedConversationCount()).toBe(0);
  });

  it("rejects unknown, excluded, and non-runnable agents with 400 and zero persistence/dispatch", async () => {
    // "other" exists in the vault roster but is excluded from the runnable set.
    await startServer({ runnableAgents: ["fake"], vaultAgents: ["fake", "other"] });
    for (const agent of ["nobody", "other", "FAKE", "../fake"]) {
      const response = await post(url("/api/conversations/start"), { agent }, token);
      expect(response.status, agent).toBe(400);
      const body = (await response.json()) as { error: string };
      // Non-secret: never leaks vault paths or internals (echoing the
      // submitted name matches the existing mention-resolver vocabulary).
      expect(body.error).not.toContain(root);
      expect(body.error).not.toContain("collaboration");
    }
    expect(await persistedConversationCount()).toBe(0);
  });

  it("starts a conversation: deterministic title/audience, system origin before dispatch, origin-correlated greeting evidence", async () => {
    await startServer();
    const response = await post(url("/api/conversations/start"), { agent: "fake" }, token);
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      conversation: { id: string; title: string; audience: string[]; status: string };
      event: { id: string; kind: string };
      dispatch?: { agent: string; status: string }[];
    };
    expect(body.conversation.title).toBe("Conversation with fake");
    expect(body.conversation.audience).toEqual(["fake"]);
    expect(body.conversation.status).toBe("open");
    expect(body.event.kind).toBe("conversation_start_requested");
    expect(body.dispatch).toEqual([{ agent: "fake", status: "completed" }]);

    const events = await readConversationEvents({ vaultRoot: root, conversationId: body.conversation.id });
    // Durable order: origin FIRST, then the run evidence; never a steward_message.
    expect(events.map((e) => e.kind)).toEqual([
      "conversation_start_requested",
      "run_started",
      "agent_message",
      "run_finished",
    ]);
    const origin = events[0];
    expect(origin?.authorKind).toBe("system");
    expect(origin?.author).toBe("system");
    expect(origin?.body).toBe("The steward requested starting this conversation with agent 'fake'.");
    expect(events.some((e) => e.kind === "steward_message")).toBe(false);
    // Every run event correlates to the durable origin event id.
    expect(events[1]?.correlationId).toBe(origin?.id);
    expect(events[2]?.correlationId).toBe(origin?.id);
    expect(events[2]?.author).toBe("fake");
    expect(events[3]?.correlationId).toBe(origin?.id);
    expect(events[3]?.runStatus).toBe("completed");
    // The greeting is the fake agent's bounded reply, not a fabricated text.
    expect(events[2]?.body).toBe("Hello");
  });

  it("records a launch_failure terminal correlated to the origin when the client cannot start", async () => {
    await startServer({
      targetBuilder: async () => ({ command: "definitely-missing-piren-fake-binary", args: [], cwd: root, env: {} }),
    });
    const response = await post(url("/api/conversations/start"), { agent: "fake" }, token);
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      conversation: { id: string };
      dispatch?: { agent: string; status: string }[];
    };
    expect(body.dispatch).toEqual([{ agent: "fake", status: "failed" }]);

    const events = await readConversationEvents({ vaultRoot: root, conversationId: body.conversation.id });
    expect(events.map((e) => e.kind)).toEqual(["conversation_start_requested", "run_finished"]);
    expect(events[1]?.runStatus).toBe("failed");
    expect(events[1]?.failureKind).toBe("launch_failure");
    expect(events[1]?.correlationId).toBe(events[0]?.id);
  });

  it("scoped live SSE carries follow-up evidence but never replays the historic origin or greeting run", async () => {
    await startServer();
    const startResponse = await post(url("/api/conversations/start"), { agent: "fake" }, token);
    expect(startResponse.status).toBe(201);
    const started = (await startResponse.json()) as { conversation: { id: string }; event: { id: string } };
    const conversationId = started.conversation.id;
    const originEventId = started.event.id;

    // Attach AFTER the start completed: the stream is live-only, so the
    // committed origin/greeting evidence is durable history, never replayed.
    const streamResponse = await fetch(url(`/api/conversations/${conversationId}/events/stream`), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(streamResponse.status).toBe(200);
    const reader = streamResponse.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readStream = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("run_finished")) break;
      }
    })();
    try {
      // Let the subscription go live, then send a follow-up mention.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const followUp = await post(url(`/api/conversations/${conversationId}/messages`), { text: "Follow up @fake" }, token);
      expect(followUp.status).toBe(200);
      await Promise.race([readStream, new Promise((_, reject) => setTimeout(() => reject(new Error("stream timeout")), 5000))]);
    } finally {
      await reader.cancel().catch(() => {});
    }

    const frames = parseSseFrames(buffer).filter((frame) => frame.type === "conversation_event");
    expect(frames.length).toBeGreaterThan(0);
    // Live frames belong to the follow-up workflow only: no historic origin,
    // no greeting-run evidence correlated to the origin, no replay at all.
    expect(frames.some((frame) => frame.data.id === originEventId)).toBe(false);
    expect(frames.some((frame) => frame.data.correlationId === originEventId)).toBe(false);
    expect(frames.some((frame) => frame.data.kind === "conversation_start_requested")).toBe(false);
    expect(frames.some((frame) => frame.data.kind === "run_finished")).toBe(true);
  });

  it("publishes the committed origin to the scoped stream before broker dispatch (structural order pin)", async () => {
    // The start handler must publish the exact committed origin record BEFORE
    // invoking the broker start path (the same durable-first live parity as
    // the steward-message routes). This static pin complements the broker
    // notification-ordering proof in tests/conversation-agent-start.test.ts.
    const source = await readFile(join(process.cwd(), "src", "gateway-http.ts"), "utf8");
    const handlerStart = source.indexOf("handleConversationStart");
    expect(handlerStart).toBeGreaterThan(-1);
    const handler = source.slice(handlerStart);
    const publishIndex = handler.indexOf("publishConversationEvent");
    const dispatchIndex = handler.indexOf("startConversationAgentRun");
    const appendIndex = handler.indexOf('kind: "conversation_start_requested"');
    expect(appendIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeGreaterThan(-1);
    expect(dispatchIndex).toBeGreaterThan(-1);
    expect(appendIndex).toBeLessThan(publishIndex);
    expect(publishIndex).toBeLessThan(dispatchIndex);
  });

  it("the started conversation lists and re-reads through the existing conversation API", async () => {
    await startServer();
    const response = await post(url("/api/conversations/start"), { agent: "fake" }, token);
    expect(response.status).toBe(201);
    const started = (await response.json()) as { conversation: { id: string } };

    const list = (await (await fetch(url("/api/conversations"), { headers: { authorization: `Bearer ${token}` } })).json()) as {
      conversations: { id: string; title: string }[];
    };
    expect(list.conversations.map((c) => c.id)).toContain(started.conversation.id);

    const manifests = await listConversations({ vaultRoot: root });
    expect(manifests).toHaveLength(1);

    // The existing gated attach route opens the started conversation as active.
    const attach = await post(url(`/api/conversations/${started.conversation.id}/attach`), {}, token);
    expect(attach.status).toBe(200);
    const attached = (await attach.json()) as { attached: boolean };
    expect(attached.attached).toBe(true);
  });
});
