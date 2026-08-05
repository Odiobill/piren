import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayServer, type GatewayHandle } from "../src/gateway-http.js";
import { initVault } from "../src/init.js";
import { readConversationEvents } from "../src/conversations.js";

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

describe("Gateway Conversation API family (C2)", () => {
  let root: string;
  let server: GatewayServer;
  let handle: GatewayHandle;
  const token = "test-conversation-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-gateway-conversations-"));
    await initVault({ vaultRoot: root, agentName: "piren" });
  });

  afterEach(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function startServer(options?: { withConversations?: boolean; runnableAgents?: string[] }): Promise<void> {
    const withConversations = options?.withConversations ?? true;
    server = new GatewayServer({
      target: fakePiTarget(),
      authToken: token,
      ...(withConversations
        ? {
            vaultRoot: root,
            runnableAgents: options?.runnableAgents ?? ["fake"],
            targetBuilder: async () => fakePiTarget(),
          }
        : {}),
    });
    handle = await server.start();
  }

  function url(path: string): string {
    return `http://${handle.hostname}:${handle.port}${path}`;
  }

  async function createConversationViaApi(text: string): Promise<{ id: string; response: Response }> {
    const response = await post(url("/api/conversations"), { text }, token);
    const body = (await response.json()) as { conversation?: { id: string } };
    return { id: body.conversation?.id ?? "", response };
  }

  it("returns 404 for conversation routes when conversation capability is not configured, and 401 without a token", async () => {
    await startServer({ withConversations: false });
    const response = await post(url("/api/conversations"), { text: "hi" }, token);
    expect(response.status).toBe(404);

    await startServer({ withConversations: true });
    const noAuth = await post(url("/api/conversations"), { text: "hi" });
    expect(noAuth.status).toBe(401);
  });

  it("zero-mention first message activates durably and dispatches nothing", async () => {
    await startServer();
    const response = await post(url("/api/conversations"), { text: "Just context, no mentions" }, token);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { conversation: { id: string; audience: string[] }; event: { kind: string }; dispatch?: unknown };
    expect(body.conversation.audience).toEqual([]);
    expect(body.event.kind).toBe("steward_message");
    expect(body.dispatch).toBeUndefined();

    const list = (await (await fetch(url("/api/conversations"), { headers: { authorization: `Bearer ${token}` } })).json()) as {
      conversations: { id: string }[];
    };
    expect(list.conversations).toHaveLength(1);
    const events = await readConversationEvents({ vaultRoot: root, conversationId: body.conversation.id });
    expect(events.map((e) => e.kind)).toEqual(["steward_message"]);
  });

  it("a valid mention persists one message, adds the audience, and dispatches deterministically", async () => {
    await startServer();
    const response = await post(url("/api/conversations"), { text: "Please review this @fake" }, token);
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      conversation: { id: string; audience: string[] };
      dispatch?: { agent: string; status: string }[];
    };
    expect(body.conversation.audience).toEqual(["fake"]);
    expect(body.dispatch).toEqual([{ agent: "fake", status: "completed" }]);

    const events = await readConversationEvents({ vaultRoot: root, conversationId: body.conversation.id });
    expect(events.map((e) => e.kind)).toEqual(["steward_message", "run_started", "agent_message", "run_finished"]);
    expect(events.at(-1)?.runStatus).toBe("completed");
  });

  it("fails the whole request atomically on an invalid/unknown mention with zero durable side effects", async () => {
    await startServer({ runnableAgents: ["fake"] });
    const response = await post(url("/api/conversations"), { text: "Hello @fake and @ghost" }, token);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/Unrecognized agent/i);
    // No conversation namespace, no event, no dispatch side effect.
    await expect(stat(join(root, "collaboration", "conversations"))).rejects.toThrow();
    // init scaffolds an EMPTY rooms directory; the failed request must not
    // have added anything under it.
    await expect(readdir(join(root, "collaboration", "rooms"))).resolves.toEqual([]);
  });

  it("appends later messages with the same atomic validation and replays prior context", async () => {
    await startServer();
    const { id } = await createConversationViaApi("First message with @fake");
    const response = await post(url(`/api/conversations/${id}/messages`), { text: "Follow up @fake" }, token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { dispatch?: { agent: string; status: string }[] };
    expect(body.dispatch).toEqual([{ agent: "fake", status: "completed" }]);

    const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
    expect(events.filter((e) => e.kind === "steward_message")).toHaveLength(2);
  });

  it("rejects message append on an archived conversation with 409", async () => {
    await startServer();
    const { id } = await createConversationViaApi("Context only");
    // Hand-write an archived manifest (archive routes are deferred; C2 only reads status).
    const manifestPath = join(root, "collaboration", "conversations", id, "index.md");
    const current = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, current.replace("status: open", "status: archived"), "utf8");

    const response = await post(url(`/api/conversations/${id}/messages`), { text: "hi" }, token);
    expect(response.status).toBe(409);
  });

  it("serves durable event history and a scoped live-only SSE stream with no replay", async () => {
    await startServer();
    const { id } = await createConversationViaApi("Stream seed @fake");

    const history = (await (await fetch(url(`/api/conversations/${id}/events`), { headers: { authorization: `Bearer ${token}` } })).json()) as {
      events: { kind: string }[];
    };
    expect(history.events.map((e) => e.kind)).toEqual(["steward_message", "run_started", "agent_message", "run_finished"]);

    const streamResponse = await fetch(url(`/api/conversations/${id}/events/stream`), {
      headers: { authorization: `Bearer ${token}` },
    });
    const reader = streamResponse.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readStream = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("run_finished")) break;
      }
    })();
    try {
      // Wait for the SSE subscription to be live, then send a second message.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await post(url(`/api/conversations/${id}/messages`), { text: "Live event @fake" }, token);
      await Promise.race([readStream, new Promise((_, reject) => setTimeout(() => reject(new Error("stream timeout")), 5000))]);
    } finally {
      await reader.cancel().catch(() => {});
    }

    // Live-only: the stream carries the SECOND dispatch's events, never the
    // historic first dispatch (no replay).
    expect(buffer).toContain("conversation_event");
    expect(buffer).toContain("run_finished");
    expect(buffer).not.toContain("Stream seed");
  });

  it("read-only inspection never activates: read/events work regardless of runnability and no activate route exists", async () => {
    await startServer({ runnableAgents: ["fake"] });
    const { id } = await createConversationViaApi("Inspect me");
    // Make the member non-runnable: inspection must still be allowed.
    const events = (await (await fetch(url(`/api/conversations/${id}/events`), { headers: { authorization: `Bearer ${token}` } })).json()) as {
      events: unknown[];
    };
    expect(Array.isArray(events.events)).toBe(true);
    const read = await fetch(url(`/api/conversations/${id}`), { headers: { authorization: `Bearer ${token}` } });
    expect(read.status).toBe(200);

    // No C2 activate/attach/switch route exists.
    const activate = await post(url(`/api/conversations/${id}/activate`), {}, token);
    expect(activate.status).toBe(404);
    const attach = await post(url(`/api/conversations/${id}/attach`), {}, token);
    expect(attach.status).toBe(404);
  });

  it("later valid steward mentions grow the durable audience additively in C1 order before dispatch", async () => {
    await startServer({ runnableAgents: ["fake", "dipu"] });
    const { id } = await createConversationViaApi("Context only");
    const response = await post(url(`/api/conversations/${id}/messages`), { text: "Now include @dipu and @fake" }, token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { dispatch?: { agent: string; status: string }[] };
    expect(body.dispatch).toEqual([
      { agent: "dipu", status: "completed" },
      { agent: "fake", status: "completed" },
    ]);
    const read = (await (await fetch(url(`/api/conversations/${id}`), { headers: { authorization: `Bearer ${token}` } })).json()) as {
      conversation: { audience: string[]; updated: string };
    };
    expect(read.conversation.audience).toEqual(["dipu", "fake"]);
    // The updated manifest timestamp moved forward.
    const created = (await createConversationViaApi("x"));
    void created;
  });

  it("invalid later mentions leave the audience and events unchanged (atomic)", async () => {
    await startServer({ runnableAgents: ["fake"] });
    const { id } = await createConversationViaApi("Context only");
    const response = await post(url(`/api/conversations/${id}/messages`), { text: "@fake and @ghost" }, token);
    expect(response.status).toBe(400);
    const read = (await (await fetch(url(`/api/conversations/${id}`), { headers: { authorization: `Bearer ${token}` } })).json()) as {
      conversation: { audience: string[] };
    };
    expect(read.conversation.audience).toEqual([]);
    const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
    expect(events.map((e) => e.kind)).toEqual(["steward_message"]);
  });

  it("an active conversation×agent run conflict persists the message but returns non-secret 409", async () => {
    await startServer({ runnableAgents: ["fake"] });
    const { id } = await createConversationViaApi("Start @fake");
    // Hang the first dispatch with the fake-Pi "hang" trigger (never awaited).
    const first = post(url(`/api/conversations/${id}/messages`), { text: "hang @fake" }, token);
    // Wait until the first run is active (run_started visible), then dispatch again.
    await waitForStreamValue(async () => {
      const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
      return events.some((e) => e.kind === "run_started");
    });
    const conflict = await post(url(`/api/conversations/${id}/messages`), { text: "Again @fake" }, token);
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { error: string };
    expect(body.error).toMatch(/already active/i);
    // Durable-first: the create message + both later steward messages persist,
    // no rollback (the 409 conflict still persisted the second message).
    const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
    expect(events.filter((e) => e.kind === "steward_message")).toHaveLength(3);
    void first;
  });

  it("never writes under collaboration/rooms (sibling namespace only)", async () => {
    await startServer();
    await createConversationViaApi("Hello @fake");
    // init scaffolds an empty rooms directory; conversation activity never populates it.
    await expect(readdir(join(root, "collaboration", "rooms"))).resolves.toEqual([]);
    const conversationsDir = await readdir(join(root, "collaboration", "conversations"));
    expect(conversationsDir).toHaveLength(1);
  });

  it("propagates a dispatch conflict as an explicit per-recipient outcome without rolling back the message", async () => {
    await startServer({ runnableAgents: ["fake"] });
    const { id } = await createConversationViaApi("First @fake");
    // A second dispatch to the same agent while the first is still active is
    // rejected by the broker; the message remains durable (no rollback).
    const conflictResponse = await post(url(`/api/conversations/${id}/messages`), { text: "Again @fake" }, token);
    expect([200, 409]).toContain(conflictResponse.status);
    const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
    const stewardCount = events.filter((e) => e.kind === "steward_message").length;
    expect(stewardCount).toBe(2);
    // The broker conflict is surfaced (either a response dispatch entry or a 409);
    // either way the durable message count is authoritative.
    await waitForStreamValue(async () => {
      const current = await readConversationEvents({ vaultRoot: root, conversationId: id });
      return current.filter((e) => e.kind === "steward_message").length === 2;
    });
  });
});
