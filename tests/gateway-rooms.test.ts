import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayServer, type GatewayHandle } from "../src/gateway-http.js";
import { initVault } from "../src/init.js";

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

/** Wall-clock poll for stream-driven conditions (no sleeps in assertions). */
async function waitForStream(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("stream condition not met in time");
}

/** Async-condition variant of waitForStream. */
async function waitForStreamValue(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("stream condition not met in time");
}

describe("Gateway room CRUD routes", () => {
  let root: string;
  let server: GatewayServer;
  let handle: GatewayHandle;
  const token = "test-room-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-gateway-rooms-"));
    await initVault({ vaultRoot: root, agentName: "piren" });
  });

  afterEach(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function startServer(options?: { withRooms?: boolean }): Promise<void> {
    const withRooms = options?.withRooms ?? true;
    server = new GatewayServer({
      target: fakePiTarget(),
      authToken: token,
      ...(withRooms
        ? {
            vaultRoot: root,
            runnableAgents: ["fake"],
            targetBuilder: async () => fakePiTarget(),
          }
        : {}),
    });
    handle = await server.start();
  }

  function url(path: string): string {
    return `http://${handle.hostname}:${handle.port}${path}`;
  }

  it("returns 404 for room routes when room capability is not configured", async () => {
    await startServer({ withRooms: false });
    const response = await post(url("/api/rooms"), { title: "x" }, token);
    expect(response.status).toBe(404);
    const list = await fetch(url("/api/rooms"), { headers: { authorization: `Bearer ${token}` } });
    expect(list.status).toBe(404);
    // Legacy surface remains functional.
    const agents = await fetch(url("/api/chat/agents"), { headers: { authorization: `Bearer ${token}` } });
    expect(agents.status).toBe(200);
  });

  it("creates, lists, and reads rooms with the safe manifest shape and no absolute paths", async () => {
    await startServer();

    const created = await post(url("/api/rooms"), { title: "First room", participants: ["fake"] }, token);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { room: Record<string, unknown> };
    expect(createdBody.room.title).toBe("First room");
    expect(createdBody.room.createdBy).toBe("steward");
    expect(createdBody.room.participants).toEqual(["fake"]);
    expect(createdBody.room.status).toBe("open");
    expect(typeof createdBody.room.id).toBe("string");
    expect(createdBody.room.absolutePath).toBeUndefined();
    expect(createdBody.room.bytes).toBeUndefined();
    expect(String(createdBody.room.path).startsWith("/")).toBe(false);
    const roomId = String(createdBody.room.id);

    const list = await fetch(url("/api/rooms"), { headers: { authorization: `Bearer ${token}` } });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { rooms: Record<string, unknown>[] };
    expect(listBody.rooms).toHaveLength(1);
    expect(listBody.rooms[0]?.id).toBe(roomId);

    const read = await fetch(url(`/api/rooms/${roomId}`), { headers: { authorization: `Bearer ${token}` } });
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as { room: Record<string, unknown> };
    expect(readBody.room.id).toBe(roomId);

    const missing = await fetch(url("/api/rooms/no-such-room"), { headers: { authorization: `Bearer ${token}` } });
    expect(missing.status).toBe(404);

    const traversal = await fetch(url("/api/rooms/..%2F..%2Fteam"), { headers: { authorization: `Bearer ${token}` } });
    expect(traversal.status).toBe(404);
    expect([404, 400]).toContain(traversal.status);
  });

  it("validates create input with 400s and performs no writes", async () => {
    await startServer();

    const noTitle = await post(url("/api/rooms"), { participants: ["fake"] }, token);
    expect(noTitle.status).toBe(400);
    const blankTitle = await post(url("/api/rooms"), { title: "   " }, token);
    expect(blankTitle.status).toBe(400);
    const badParticipants = await post(url("/api/rooms"), { title: "x", participants: "fake" }, token);
    expect(badParticipants.status).toBe(400);
    const badName = await post(url("/api/rooms"), { title: "x", participants: ["Bad_Name"] }, token);
    expect(badName.status).toBe(400);

    const list = await fetch(url("/api/rooms"), { headers: { authorization: `Bearer ${token}` } });
    const listBody = (await list.json()) as { rooms: unknown[] };
    expect(listBody.rooms).toHaveLength(0);
  });

  it("returns structured chronological durable events from the events route", async () => {
    await startServer();
    const created = await post(url("/api/rooms"), { title: "Event room", participants: ["fake"] }, token);
    const { room } = (await created.json()) as { room: { id: string } };

    const message = await post(url(`/api/rooms/${room.id}/messages`), { agent: "fake", text: "Hello room" }, token);
    expect(message.status).toBe(200);

    const events = await fetch(url(`/api/rooms/${room.id}/events`), { headers: { authorization: `Bearer ${token}` } });
    expect(events.status).toBe(200);
    const body = (await events.json()) as { events: Record<string, unknown>[] };
    expect(body.events.map((event) => event.kind)).toEqual([
      "steward_message",
      "run_started",
      "agent_message",
      "run_finished",
    ]);
    for (const event of body.events) {
      expect(event.absolutePath).toBeUndefined();
      expect(String(event.path).startsWith("/")).toBe(false);
      expect(event.roomId).toBe(room.id);
    }
    const steward = body.events[0];
    expect(steward?.addressedAgent).toBe("fake");
    expect(steward?.body).toBe("Hello room");
    const reply = body.events[2];
    expect(reply?.author).toBe("fake");
    expect(reply?.body).toBe("Hello");
  });
});

describe("Gateway room dispatch, approval, abort, and auth", () => {
  let root: string;
  let server: GatewayServer;
  let handle: GatewayHandle;
  const token = "test-room-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-gateway-rooms-op-"));
    await initVault({ vaultRoot: root, agentName: "piren" });
    server = new GatewayServer({
      target: fakePiTarget(),
      authToken: token,
      vaultRoot: root,
      runnableAgents: ["fake"],
      targetBuilder: async () => fakePiTarget(),
    });
    handle = await server.start();
  });

  afterEach(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function url(path: string): string {
    return `http://${handle.hostname}:${handle.port}${path}`;
  }

  async function createRoom(title: string): Promise<string> {
    const response = await post(url("/api/rooms"), { title, participants: ["fake"] }, token);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { room: { id: string } };
    return body.room.id;
  }

  async function eventKinds(roomId: string): Promise<string[]> {
    const response = await fetch(url(`/api/rooms/${roomId}/events`), { headers: { authorization: `Bearer ${token}` } });
    const body = (await response.json()) as { events: { kind: string }[] };
    return body.events.map((event) => event.kind);
  }

  it("rejects every room route without a Bearer token, with no side effect", async () => {
    const create = await post(url("/api/rooms"), { title: "x" });
    expect(create.status).toBe(401);
    const list = await fetch(url("/api/rooms"));
    expect(list.status).toBe(401);
    const roomId = await createRoom("Authed room");
    expect(await (await fetch(url(`/api/rooms/${roomId}`))).status).toBe(401);
    expect(await (await fetch(url(`/api/rooms/${roomId}/events`))).status).toBe(401);
    expect(await (await post(url(`/api/rooms/${roomId}/messages`), { agent: "fake", text: "hi" })).status).toBe(401);
    expect(await (await post(url(`/api/rooms/${roomId}/abort`), { agent: "fake" })).status).toBe(401);
    expect(await (await post(url(`/api/rooms/${roomId}/approve`), { agent: "fake", request_id: "r", confirmed: true })).status).toBe(401);
    expect(await eventKinds(roomId)).toEqual([]);
  });

  it("rejects nonparticipant, nonrunnable, unknown-room, and malformed messages with zero side effects", async () => {
    const roomId = await createRoom("Reject room");

    const nonParticipant = await post(url(`/api/rooms/${roomId}/messages`), { agent: "other", text: "hi" }, token);
    expect(nonParticipant.status).toBe(400);

    // Participant in the room but outside the broker runnable set: create a
    // second server scoped to a different runnable set.
    await server.close();
    server = new GatewayServer({
      target: fakePiTarget(),
      authToken: token,
      vaultRoot: root,
      runnableAgents: ["someone-else"],
      targetBuilder: async () => fakePiTarget(),
    });
    handle = await server.start();
    const nonRunnable = await post(url(`/api/rooms/${roomId}/messages`), { agent: "fake", text: "hi" }, token);
    expect(nonRunnable.status).toBe(400);

    const unknownRoom = await post(url("/api/rooms/no-such-room/messages"), { agent: "fake", text: "hi" }, token);
    expect(unknownRoom.status).toBe(404);

    const missingText = await post(url(`/api/rooms/${roomId}/messages`), { agent: "fake" }, token);
    expect(missingText.status).toBe(400);

    expect(await eventKinds(roomId)).toEqual([]);
  });

  it("rejects a second message for an active room × agent with 409 and no queue", async () => {
    const roomId = await createRoom("Conflict room");

    // The fake Pi blocks on an approval request for text containing
    // "waitapprove", keeping the run active.
    const first = post(url(`/api/rooms/${roomId}/messages`), { agent: "fake", text: "waitapprove please" }, token);
    await new Promise((resolve) => {
      const interval = setInterval(async () => {
        const kinds = await eventKinds(roomId);
        if (kinds.includes("run_started")) {
          clearInterval(interval);
          resolve(undefined);
        }
      }, 10);
    });

    const conflict = await post(url(`/api/rooms/${roomId}/messages`), { agent: "fake", text: "second" }, token);
    expect(conflict.status).toBe(409);
    expect(await eventKinds(roomId)).toEqual(["steward_message", "run_started"]);

    // Resolve the pending run: fetch the approval request id via the broker
    // is not exposed over HTTP, so cancel it instead via abort.
    const abort = await post(url(`/api/rooms/${roomId}/abort`), { agent: "fake" }, token);
    expect(abort.status).toBe(200);
    const firstOutcome = (await (await first).json()) as { outcome: { status: string } };
    expect(firstOutcome.outcome.status).toBe("cancelled");
    expect(await eventKinds(roomId)).toEqual(["steward_message", "run_started", "run_cancelled"]);
  });

  it("routes an approval only to the exact room-agent request and completes the run", async () => {
    const roomId = await createRoom("Approval room");

    // Open the scoped stream FIRST (the intended client pattern), so the
    // live approval notification is observed.
    const streamResponse = await fetch(url(`/api/rooms/${roomId}/events/stream`), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(streamResponse.status).toBe(200);
    const reader = streamResponse.body!.getReader();
    const decoder = new TextDecoder();
    let approvalId = "";
    let sawTerminal = false;
    const readStream = (async () => {
      let buffer = "";
      while (!sawTerminal) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const approvalMatch = buffer.match(/event: approval\ndata: (\{.*\})/);
        if (approvalMatch && approvalId === "") {
          approvalId = String(JSON.parse(approvalMatch[1]!).requestId);
        }
        if (/event: room_event\ndata: \{[^\n]*"kind":"run_finished"/.test(buffer)) {
          sawTerminal = true;
        }
      }
    })();

    const dispatch = post(url(`/api/rooms/${roomId}/messages`), { agent: "fake", text: "waitapprove please" }, token);
    await waitForStream(() => approvalId !== "");

    // Wrong room / wrong agent / unknown request reject without approving.
    const wrongRoom = await post(url("/api/rooms/other-room/approve"), { agent: "fake", request_id: approvalId, confirmed: true }, token);
    expect(wrongRoom.status).toBe(404);
    const wrongAgent = await post(url(`/api/rooms/${roomId}/approve`), { agent: "other", request_id: approvalId, confirmed: true }, token);
    expect(wrongAgent.status).toBe(404);
    const wrongRequest = await post(url(`/api/rooms/${roomId}/approve`), { agent: "fake", request_id: "nope", confirmed: true }, token);
    expect(wrongRequest.status).toBe(404);

    const approve = await post(url(`/api/rooms/${roomId}/approve`), { agent: "fake", request_id: approvalId, confirmed: true }, token);
    expect(approve.status).toBe(200);

    const outcome = (await (await dispatch).json()) as { outcome: { status: string } };
    expect(outcome.outcome.status).toBe("completed");
    await waitForStream(() => sawTerminal);
    await readStream;
    expect(await eventKinds(roomId)).toEqual(["steward_message", "run_started", "agent_message", "run_finished"]);

    // Already-resolved approval rejects and writes nothing.
    const stale = await post(url(`/api/rooms/${roomId}/approve`), { agent: "fake", request_id: approvalId, confirmed: true }, token);
    expect(stale.status).toBe(404);
    await reader.cancel();
  });

  it("aborts exactly the addressed room-agent run and stays idempotent afterwards", async () => {
    const roomId = await createRoom("Abort room");

    const dispatch = post(url(`/api/rooms/${roomId}/messages`), { agent: "fake", text: "waitapprove please" }, token);
    await new Promise((resolve) => {
      const interval = setInterval(async () => {
        const kinds = await eventKinds(roomId);
        if (kinds.includes("run_started")) {
          clearInterval(interval);
          resolve(undefined);
        }
      }, 10);
    });

    const abort = await post(url(`/api/rooms/${roomId}/abort`), { agent: "fake" }, token);
    expect(abort.status).toBe(200);
    const abortBody = (await abort.json()) as { outcome: { status: string } };
    expect(abortBody.outcome.status).toBe("cancelled");

    const outcome = (await (await dispatch).json()) as { outcome: { status: string } };
    expect(outcome.outcome.status).toBe("cancelled");

    const again = await post(url(`/api/rooms/${roomId}/abort`), { agent: "fake" }, token);
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as { outcome: { status: string } };
    expect(againBody.outcome.status).toBe("no-active-run");

    expect(await eventKinds(roomId)).toEqual(["steward_message", "run_started", "run_cancelled"]);
  });
});

describe("Gateway room SSE scoping and shutdown", () => {
  let root: string;
  let server: GatewayServer;
  let handle: GatewayHandle;
  const token = "test-room-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-gateway-rooms-sse-"));
    await initVault({ vaultRoot: root, agentName: "piren" });
    server = new GatewayServer({
      target: fakePiTarget(),
      authToken: token,
      vaultRoot: root,
      runnableAgents: ["fake"],
      targetBuilder: async () => fakePiTarget(),
    });
    handle = await server.start();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function url(path: string): string {
    return `http://${handle.hostname}:${handle.port}${path}`;
  }

  async function createRoom(title: string): Promise<string> {
    const response = await post(url("/api/rooms"), { title, participants: ["fake"] }, token);
    const body = (await response.json()) as { room: { id: string } };
    return body.room.id;
  }

  function streamKinds(roomId: string, collected: { kinds: string[] }): { cancel: () => Promise<void>; done: Promise<void> } {
    const controller = new AbortController();
    const done = (async () => {
      const response = await fetch(url(`/api/rooms/${roomId}/events/stream`), {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { value, done: finished } = await reader.read();
          if (finished) break;
          buffer += decoder.decode(value, { stream: true });
          // The buffer is cumulative and never truncated, so each
          // recomputation yields the full ordered sequence exactly once.
          collected.kinds = [...buffer.matchAll(/event: ([a-z_]+)/g)].map((match) => match[1]!);
        }
      } catch {
        // aborted
      }
    })();
    return { cancel: async () => controller.abort(), done };
  }

  it("scopes committed room events to their own room stream only, with no raw Pi traffic", async () => {
    const roomOne = await createRoom("Stream one");
    const roomTwo = await createRoom("Stream two");

    const one: { kinds: string[] } = { kinds: [] };
    const two: { kinds: string[] } = { kinds: [] };
    const streamOne = streamKinds(roomOne, one);
    const streamTwo = streamKinds(roomTwo, two);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const message = await post(url(`/api/rooms/${roomOne}/messages`), { agent: "fake", text: "Hello room one" }, token);
    expect(message.status).toBe(200);
    await waitForStream(() => one.kinds.filter((kind) => kind === "room_event").length >= 4);

    expect(one.kinds).toEqual(["room_event", "room_event", "room_event", "room_event"]);
    expect(two.kinds).toEqual([]);

    await streamOne.cancel();
    await streamTwo.cancel();
    await streamOne.done;
    await streamTwo.done;
    await server.close();
  });

  it("gateway close during active room work produces durable cancellation evidence with no double terminal", async () => {
    const roomId = await createRoom("Close room");

    const dispatch = post(url(`/api/rooms/${roomId}/messages`), { agent: "fake", text: "waitapprove please" }, token);
    await waitForStreamValue(async () => {
      const events = await fetch(url(`/api/rooms/${roomId}/events`), { headers: { authorization: `Bearer ${token}` } });
      const body = (await events.json()) as { events: { kind: string }[] };
      return body.events.some((event) => event.kind === "run_started");
    });

    await server.close();
    const outcome = (await (await dispatch).json()) as { outcome: { status: string } };
    expect(outcome.outcome.status).toBe("cancelled");

    // The vault is untouched by close; durable evidence holds exactly one terminal.
    const { readdir, readFile } = await import("node:fs/promises");
    const dir = join(root, "collaboration", "rooms", roomId, "events");
    const names = await readdir(dir);
    const kinds: string[] = [];
    for (const name of names.sort()) {
      const content = await readFile(join(dir, name), "utf8");
      const kind = content.match(/^kind: ([a-z_]+)$/m)?.[1];
      if (kind) kinds.push(kind);
    }
    expect(kinds.sort()).toEqual(["run_cancelled", "run_started", "steward_message"]);
  });
});
