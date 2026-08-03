import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRoomAgentsResponse } from "../src/room-agents.js";
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

/**
 * ADR-0041 R3b-2: room-agent roster contract. `online` is local installation
 * policy only — membership in this gateway's already-resolved runnableAgents
 * set. It is NOT Pi-process presence, provider reachability, transport state,
 * or identity. The roster is explicitly supplied; no config reread, no
 * directory creation, no probing, no polling.
 */
describe("buildRoomAgentsResponse (pure roster)", () => {
  it("marks only runnable agents online; all other vault-defined names are offline", () => {
    const result = buildRoomAgentsResponse(["piren", "researcher", "heimdall"], ["piren"]);
    expect(result).toEqual({
      agents: [
        { name: "heimdall", online: false },
        { name: "piren", online: true },
        { name: "researcher", online: false },
      ],
    });
  });

  it("sorts deterministically by name", () => {
    const result = buildRoomAgentsResponse(["zeta", "alpha", "mike"], ["alpha"]);
    expect(result.agents.map((a) => a.name)).toEqual(["alpha", "mike", "zeta"]);
  });

  it("returns an empty list when no vault roster was supplied", () => {
    expect(buildRoomAgentsResponse([], ["piren"])).toEqual({ agents: [] });
  });

  it("does not add runnable agents that are absent from the supplied roster", () => {
    const result = buildRoomAgentsResponse(["piren"], ["piren", "ghost"]);
    expect(result.agents).toEqual([{ name: "piren", online: true }]);
  });
});

describe("GET /api/room-agents (authenticated roster route)", () => {
  let root: string;
  let server: GatewayServer;
  let handle: GatewayHandle;
  const token = "test-roster-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-room-agents-"));
    await initVault({ vaultRoot: root, agentName: "piren" });
  });

  afterEach(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function url(path: string): string {
    return `http://${handle.hostname}:${handle.port}${path}`;
  }

  it("returns the deterministic online/offline roster and requires Bearer when a token is set", async () => {
    server = new GatewayServer({
      target: fakePiTarget(),
      authToken: token,
      vaultRoot: root,
      runnableAgents: ["piren"],
      targetBuilder: async () => fakePiTarget(),
      vaultAgents: ["piren", "researcher", "heimdall"],
    });
    handle = await server.start();

    // Bearer gate: no token -> 401.
    const unauthenticated = await fetch(url("/api/room-agents"));
    expect(unauthenticated.status).toBe(401);

    const res = await fetch(url("/api/room-agents"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<{ name: string; online: boolean }> };
    expect(body).toEqual({
      agents: [
        { name: "heimdall", online: false },
        { name: "piren", online: true },
        { name: "researcher", online: false },
      ],
    });
  });

  it("returns an empty roster when no vault roster is supplied", async () => {
    server = new GatewayServer({
      target: fakePiTarget(),
      authToken: token,
      vaultRoot: root,
      runnableAgents: ["piren"],
      targetBuilder: async () => fakePiTarget(),
    });
    handle = await server.start();
    const res = await fetch(url("/api/room-agents"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agents: [] });
  });

  it("keeps the existing /api/chat/agents contract untouched", async () => {
    server = new GatewayServer({
      target: fakePiTarget(),
      authToken: token,
      vaultRoot: root,
      runnableAgents: ["piren"],
      targetBuilder: async () => fakePiTarget(),
      vaultAgents: ["piren", "researcher"],
    });
    handle = await server.start();
    const res = await fetch(url("/api/chat/agents"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: string[]; current: string };
    expect(body.agents).toEqual(["piren"]);
    expect(body.current).toBe("piren");
  });
});

describe("POST /api/rooms participant runnable enforcement (R3b-2)", () => {
  let root: string;
  let server: GatewayServer;
  let handle: GatewayHandle;
  const token = "test-create-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-room-create-"));
    await initVault({ vaultRoot: root, agentName: "piren" });
    server = new GatewayServer({
      target: fakePiTarget(),
      authToken: token,
      vaultRoot: root,
      runnableAgents: ["piren", "researcher"],
      targetBuilder: async () => fakePiTarget(),
      vaultAgents: ["piren", "researcher", "heimdall"],
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

  async function createRoom(body: unknown): Promise<Response> {
    return fetch(url("/api/rooms"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  it("rejects an explicitly supplied offline/non-runnable participant with the non-secret 400 semantics", async () => {
    const res = await createRoom({ title: "research sync", participants: ["heimdall"] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not in the runnable set");
  });

  it("rejects when any one of several participants is non-runnable", async () => {
    const res = await createRoom({ title: "mixed", participants: ["piren", "heimdall"] });
    expect(res.status).toBe(400);
  });

  it("accepts rooms whose participants are all locally runnable", async () => {
    const res = await createRoom({ title: "all runnable", participants: ["piren", "researcher"] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { room: { participants: string[] } };
    expect(body.room.participants).toEqual(["piren", "researcher"]);
  });

  it("accepts rooms with no explicit participants", async () => {
    const res = await createRoom({ title: "empty roster" });
    expect(res.status).toBe(201);
  });
});
