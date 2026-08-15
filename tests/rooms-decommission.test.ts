import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayServer, type GatewayHandle } from "../src/gateway-http.js";
import { initVault } from "../src/init.js";

/**
 * Rooms product decommission (accepted `rooms-product-decommission-contract.md`
 * + ADR-0043 2026-08-14 revision): the shipped product is Conversation-only.
 * There is no Rooms API/broker/tool/web/parser — `/api/room-agents` and the
 * `/api/rooms/**` family are ABSENT (404), never aliased or redirected; the
 * shared local-policy roster moves to the neutral `GET /api/conversation-agents`
 * with the exact bounded `{agents: [{name, online}]}` semantics; no
 * `room_mention` extension tool is ever registered (even with the retired
 * flag); and no room source/web module remains.
 *
 * These surfaces do not exist yet: RED.
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

describe("Rooms decommission: gateway surface (RED)", () => {
  let root: string;
  let server: GatewayServer;
  let handle: GatewayHandle;
  const token = "test-decommission-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-decommission-"));
    await initVault({ vaultRoot: root, agentName: "piren" });
    server = new GatewayServer({
      target: fakePiTarget(),
      vaultRoot: root,
      runnableAgents: ["piren"],
      vaultAgents: ["piren", "thor"],
      targetBuilder: async () => fakePiTarget(),
      authToken: token,
    });
    handle = await server.start();
  });

  afterEach(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  function url(path: string): string {
    return `http://127.0.0.1:${handle.port}${path}`;
  }

  it("the old room routes are absent (404) with no alias or redirect", async () => {
    const paths = [
      "/api/room-agents",
      "/api/rooms",
      "/api/rooms/some-room",
      "/api/rooms/some-room/events",
      "/api/rooms/some-room/events/stream",
      "/api/rooms/some-room/messages",
      "/api/rooms/some-room/abort",
      "/api/rooms/some-room/approve",
    ];
    for (const path of paths) {
      const res = await fetch(url(path), { headers: { authorization: `Bearer ${token}` } });
      expect(res.status, path).toBe(404);
      const body = (await res.json()) as { error?: unknown };
      expect(body.error, path).toBe("not found");
    }
  });

  it("GET /api/conversation-agents keeps the bounded authenticated local-policy roster", async () => {
    // Bearer auth is enforced exactly like every other protected /api route.
    const noAuth = await fetch(url("/api/conversation-agents"));
    expect(noAuth.status).toBe(401);

    const res = await fetch(url("/api/conversation-agents"), { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<{ name: string; online: boolean }> };
    // Deterministic sorted roster; `online` is local installation policy only
    // (membership in the resolved runnable set), never Pi/transport presence.
    expect(body.agents).toEqual([
      { name: "piren", online: true },
      { name: "thor", online: false },
    ]);
  });
});

describe("Rooms decommission: web + source surface (RED)", () => {
  const webSrc = join(process.cwd(), "web", "src");
  const srcDir = join(process.cwd(), "src");

  it("no room source module remains; the neutral conversation-agents core exists", async () => {
    const files = await readdir(srcDir);
    for (const roomFile of ["rooms.ts", "room-broker.ts", "room-handoff-protocol.ts", "room-agents.ts"]) {
      expect(files, roomFile).not.toContain(roomFile);
    }
    expect(files).toContain("conversation-agents.ts");
  });

  it("no room web module or room-only composer core remains; the web client fetches ONLY /api/conversation-agents", async () => {
    const files = await readdir(webSrc);
    for (const roomFile of ["RoomNavigator.tsx", "RoomTimeline.tsx", "RoomComposer.tsx", "rooms.ts", "composer.ts"]) {
      expect(files, roomFile).not.toContain(roomFile);
    }
    const api = await readFile(join(webSrc, "api.ts"), "utf8");
    expect(api).not.toContain("/api/rooms");
    expect(api).not.toContain("/api/room-agents");
    expect(api).toContain("/api/conversation-agents");
    const registry = await readFile(join(webSrc, "registry.ts"), "utf8");
    expect(registry).not.toContain("room-agents");
    expect(registry).toContain("conversation-agents");
  });

  it("the workbench roster consumers use the neutral conversation-agents module and type", async () => {
    // ADR-0044: the retired AgentsView page is gone; the Dashboard is the
    // roster consumer.
    for (const name of ["DashboardView.tsx", "ConversationNavigator.tsx", "ConversationComposer.tsx", "ConversationDetailsModal.tsx", "attach.ts", "conversation-autocomplete.ts", "ParticipantPicker.tsx"]) {
      const content = await readFile(join(webSrc, name), "utf8");
      expect(content, name).not.toContain("./rooms");
    }
  });
});
