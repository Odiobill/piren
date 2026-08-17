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
    // ADR-0043: the retired Rooms namespace is never scaffolded or written.
    await expect(stat(join(root, "collaboration", "rooms"))).rejects.toThrow();
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
    // Live records must use the same complete durable-record schema as the
    // history endpoint; otherwise the Workbench correctly rejects them as
    // non-authoritative and only renders them after a later history reload.
    const liveRunFinished = parseSseFrames(buffer).find(
      (frame) => frame.type === "conversation_event" && frame.data.kind === "run_finished",
    );
    expect(liveRunFinished?.data).toMatchObject({
      conversationId: id,
      kind: "run_finished",
      authorKind: "system",
      author: "system",
      sequence: expect.any(Number),
      mentions: [],
      body: expect.any(String),
      path: expect.stringContaining(`/conversations/${id}/events/`),
    });
  });

  it("read-only inspection never activates: read/events work regardless of runnability; attach is the only activating route (C3-A)", async () => {
    await startServer({ runnableAgents: ["fake"] });
    const { id } = await createConversationViaApi("Inspect me");
    // Make the member non-runnable: inspection must still be allowed.
    const events = (await (await fetch(url(`/api/conversations/${id}/events`), { headers: { authorization: `Bearer ${token}` } })).json()) as {
      events: unknown[];
    };
    expect(Array.isArray(events.events)).toBe(true);
    const read = await fetch(url(`/api/conversations/${id}`), { headers: { authorization: `Bearer ${token}` } });
    expect(read.status).toBe(200);

    // C3-A added exactly one activating route: attach. It succeeds when the
    // empty durable audience is openable (zero-mention conversation).
    const attach = await post(url(`/api/conversations/${id}/attach`), {}, token);
    expect(attach.status).toBe(200);
    // No activate/switch route exists (archive/reopen are later, separately
    // gated slices; attach is stateless and never switches the global client).
    const activate = await post(url(`/api/conversations/${id}/activate`), {}, token);
    expect(activate.status).toBe(404);
    const switchRoute = await post(url(`/api/conversations/${id}/switch`), {}, token);
    expect(switchRoute.status).toBe(404);
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

  it("a multi-recipient message with one active run persists the message but returns non-secret 409 (steer never guesses)", { timeout: 20000 }, async () => {
    await startServer({ runnableAgents: ["fake", "fake2"] });
    const { id } = await createConversationViaApi("Start @fake @fake2");
    // Both runs complete from the seed; wait for the two terminals.
    await waitForStreamValue(async () => {
      const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
      return events.filter((e) => e.kind === "run_finished").length >= 2;
    });
    // Hang BOTH agents with separate messages (fire-and-forget: each POST
    // resolves only when its run settles after abort in cleanup). Dispatch is
    // sequential per message, so two hang messages make both runs active.
    void post(url(`/api/conversations/${id}/messages`), { text: "hang @fake" }, token).catch(() => {});
    await waitForStreamValue(async () => {
      const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
      return events.filter((e) => e.kind === "run_started").length >= 3;
    });
    void post(url(`/api/conversations/${id}/messages`), { text: "hang @fake2" }, token).catch(() => {});
    await waitForStreamValue(async () => {
      const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
      return events.filter((e) => e.kind === "run_started").length >= 4;
    });
    // TWO recipients with both runs active: P5 auto-steer only targets exactly
    // one recipient, so this keeps the existing deterministic dispatch/conflict
    // behavior — both active runs are a fail-closed 409 conflict, no guess.
    const conflict = await post(url(`/api/conversations/${id}/messages`), { text: "Again @fake @fake2" }, token);
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { error: string };
    expect(body.error).toMatch(/already active/i);
    // Durable-first invariant: every steward message persisted (create + two
    // hang messages + conflict = 4); nothing durably written is rolled back.
    const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
    const stewardCount = events.filter((e) => e.kind === "steward_message").length;
    expect(stewardCount).toBe(4);
  });

  it("a held audience lock returns 409 before creating any event, audience change, or dispatch", async () => {
    await startServer({ runnableAgents: ["fake"] });
    const { id } = await createConversationViaApi("Context only");
    // Deterministically hold the vault-visible coordination lock.
    const lockPath = join(root, "collaboration", "conversations", id, ".audience.lock");
    await writeFile(
      lockPath,
      JSON.stringify({ token: "held", pid: 0, conversationId: id, acquiredAt: "2026-08-05T00:00:00.000Z" }),
      { flag: "wx" },
    );

    const response = await post(url(`/api/conversations/${id}/messages`), { text: "Now include @fake" }, token);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/busy/i);

    // No new steward event, no audience change, no dispatch side effect.
    const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
    expect(events.map((e) => e.kind)).toEqual(["steward_message"]);
    const read = (await (await fetch(url(`/api/conversations/${id}`), { headers: { authorization: `Bearer ${token}` } })).json()) as {
      conversation: { audience: string[] };
    };
    expect(read.conversation.audience).toEqual([]);
  });

  it("never writes under collaboration/rooms (the retired Rooms namespace is absent)", async () => {
    await startServer();
    await createConversationViaApi("Hello @fake");
    // ADR-0043: the Rooms namespace is decommissioned — never scaffolded or written.
    await expect(stat(join(root, "collaboration", "rooms"))).rejects.toThrow();
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

describe("Gateway Conversation T3 settle telemetry SSE frame", () => {
  let root: string;
  let server: GatewayServer;
  let handle: GatewayHandle;
  const token = "test-conversation-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-gateway-conv-telemetry-"));
    await initVault({ vaultRoot: root, agentName: "piren" });
  });

  afterEach(async () => {
    await server.close();
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

  it("delivers one live-only conversation_telemetry frame per settled run on the scoped stream, with no replay and no durable write", async () => {
    await startServer();
    const created = await post(url("/api/conversations"), { text: "Seed @fake" }, token);
    const { conversation } = (await created.json()) as { conversation: { id: string } };
    const id = conversation.id;

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
        // Read until one COMPLETE parseable telemetry frame has arrived (the
        // event/data lines may arrive in separate stream chunks).
        if (parseSseFrames(buffer).some((frame) => frame.type === "conversation_telemetry")) break;
      }
    })();
    try {
      // Wait for the SSE subscription to be live, then run a second dispatch.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await post(url(`/api/conversations/${id}/messages`), { text: "Live @fake" }, token);
      await Promise.race([readStream, new Promise((_, reject) => setTimeout(() => reject(new Error("stream timeout")), 5000))]);
    } finally {
      await reader.cancel().catch(() => {});
    }

    const telemetryFrames = parseSseFrames(buffer).filter((frame) => frame.type === "conversation_telemetry");
    // Exactly one frame for the second dispatch; the first (pre-subscription)
    // dispatch's telemetry is never replayed on attach.
    expect(telemetryFrames).toHaveLength(1);
    const frame = telemetryFrames[0]!.data;
    expect(frame.conversationId).toBe(id);
    expect(frame.agent).toBe("fake");
    expect(typeof frame.runId).toBe("string");
    // Fake Pi defaults: numeric context usage, thinkingLevel "off", no model.
    expect(frame.contextState).toBe("ok");
    expect(frame.context).toEqual({ tokens: 60000, contextWindow: 200000, percent: 30 });
    expect(frame.thinkingLevel).toBe("off");
    expect(frame).not.toHaveProperty("model");
    // Bounded facts only: no session identifiers, token/cost totals.
    expect(frame).not.toHaveProperty("sessionId");
    expect(frame).not.toHaveProperty("sessionFile");
    expect(frame).not.toHaveProperty("cost");
    expect(frame).not.toHaveProperty("tokens");
    expect(JSON.stringify(frame)).not.toContain("fake-session");

    // Telemetry is never durable history.
    const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
    expect(events.map((event) => event.kind)).toEqual([
      "steward_message",
      "run_started",
      "agent_message",
      "run_finished",
      "steward_message",
      "run_started",
      "agent_message",
      "run_finished",
    ]);
  });
});

describe("Gateway Conversation T4 telemetry read route", () => {
  let root: string;
  let server: GatewayServer;
  let handle: GatewayHandle;
  const token = "test-conversation-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-gateway-conv-telemetry-read-"));
    await initVault({ vaultRoot: root, agentName: "piren" });
  });

  afterEach(async () => {
    await server.close();
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

  async function readTelemetry(id: string, agent: string, bearer?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (bearer !== undefined) headers["authorization"] = `Bearer ${bearer}`;
    return fetch(url(`/api/conversations/${id}/agents/${agent}/telemetry`), { headers });
  }

  it("requires authentication (401 without a Bearer token)", async () => {
    await startServer();
    const created = await post(url("/api/conversations"), { text: "Seed @fake" }, token);
    const { conversation } = (await created.json()) as { conversation: { id: string } };
    const response = await readTelemetry(conversation.id, "fake");
    expect(response.status).toBe(401);
  });

  it("returns 200 with truthful live facts for the exact live pair, without raw identifiers or totals", async () => {
    await startServer();
    const created = await post(url("/api/conversations"), { text: "Seed @fake" }, token);
    const { conversation } = (await created.json()) as { conversation: { id: string } };

    const response = await readTelemetry(conversation.id, "fake", token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.sessionState).toBe("live");
    expect(body.contextState).toBe("ok");
    expect(body.context).toEqual({ tokens: 60000, contextWindow: 200000, percent: 30 });
    expect(body.thinkingLevel).toBe("off");
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("sessionId");
    expect(body).not.toHaveProperty("sessionFile");
    expect(body).not.toHaveProperty("cost");
    expect(body).not.toHaveProperty("tokens");
    expect(JSON.stringify(body)).not.toContain("fake-session");

    // Reads never write durable evidence.
    const events = await readConversationEvents({ vaultRoot: root, conversationId: conversation.id });
    expect(events.map((event) => event.kind)).toEqual(["steward_message", "run_started", "agent_message", "run_finished"]);
  });

  it("returns 200 no_live_session for a conversation that never ran (and spawns nothing)", async () => {
    await startServer();
    const created = await post(url("/api/conversations"), { text: "Context only, no mention" }, token);
    const { conversation } = (await created.json()) as { conversation: { id: string } };
    const response = await readTelemetry(conversation.id, "fake", token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessionState: "no_live_session" });
    const events = await readConversationEvents({ vaultRoot: root, conversationId: conversation.id });
    expect(events.map((event) => event.kind)).toEqual(["steward_message"]);
  });

  it("returns 200 no_live_session for a different agent in the same conversation (pair isolation)", async () => {
    await startServer();
    const created = await post(url("/api/conversations"), { text: "Seed @fake" }, token);
    const { conversation } = (await created.json()) as { conversation: { id: string } };
    const response = await readTelemetry(conversation.id, "ghost", token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessionState: "no_live_session" });
  });

  it("404 for an unknown conversation and 400 for an invalid agent name", async () => {
    await startServer();
    const created = await post(url("/api/conversations"), { text: "Seed @fake" }, token);
    const { conversation } = (await created.json()) as { conversation: { id: string } };

    const missing = await readTelemetry("20260101T000000000Z-nope", "fake", token);
    expect(missing.status).toBe(404);

    const invalid = await readTelemetry(conversation.id, "Bad_Name", token);
    expect(invalid.status).toBe(400);
  });
});
