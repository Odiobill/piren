import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { GatewayServer } from "../src/gateway-http.js";
import type { RpcSpawnTarget } from "../src/gateway-rpc.js";

const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");

function fakePiTarget(): RpcSpawnTarget {
  return {
    command: process.execPath,
    args: [fakePiScript],
    cwd: process.cwd(),
    env: process.env,
  };
}

async function makeVault(): Promise<{ vault: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "piren-gw-sessions-"));
  const vault = join(root, "vault");
  const sessionsDir = join(vault, "team", "piren", "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, "20260623T090000Z-add-tests.md"),
    [
      "---",
      "type: session-summary",
      "agent: piren",
      "created: 2026-06-23T09:00:00.000Z",
      "---",
      "",
      "# Add Tests",
      "",
      "Session resume smoke.",
    ].join("\n"),
  );
  return {
    vault,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("Gateway session resume and abort routes", () => {
  it("POST /api/chat/abort aborts the active turn and returns ok", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();

      // Start a prompt so there is an active turn, then abort it.
      const startRes = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Hello" }),
      });
      expect(startRes.status).toBe(200);

      const abortRes = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/abort`, {
        method: "POST",
      });
      expect(abortRes.status).toBe(200);
      const abortBody = (await abortRes.json()) as { ok: boolean };
      expect(abortBody.ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("GET /api/chat/messages returns the current session transcript", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/messages`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: Array<{ role: string }> };
      expect(Array.isArray(body.messages)).toBe(true);
      expect(body.messages.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it("POST /api/chat/new starts a fresh conversation and clears the transcript", async () => {
    const freshTarget = fakePiTarget();
    freshTarget.env = { ...process.env, FAKE_PI_EMPTY_MESSAGES: "1" };
    const server = new GatewayServer({
      target: fakePiTarget(),
      runnableAgents: ["piren"],
      initialAgent: "piren",
      targetBuilder: async () => freshTarget,
    });
    try {
      const handle = await server.start();

      const beforeRes = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/messages`);
      const beforeBody = (await beforeRes.json()) as { messages: unknown[] };
      expect(beforeBody.messages.length).toBeGreaterThan(0);

      const newRes = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/new`, {
        method: "POST",
      });
      expect(newRes.status).toBe(200);
      const newBody = (await newRes.json()) as { ok: boolean; fresh: boolean };
      expect(newBody).toEqual({ ok: true, fresh: true });

      const afterRes = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/messages`);
      const afterBody = (await afterRes.json()) as { messages: unknown[] };
      expect(afterBody.messages).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("POST /api/chat/resume resumes a session and reports cancelled=false", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionPath: "/fake/session.jsonl" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { cancelled: boolean };
      expect(body.cancelled).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("POST /api/chat/resume reports cancelled=true when Pi cancels", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionPath: "cancel" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { cancelled: boolean };
      expect(body.cancelled).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("POST /api/chat/resume rejects missing sessionPath with 400", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("POST /api/chat/resume rejects invalid JSON with 400", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("GET /api/chat/sessions lists vault session summaries for the current agent", async () => {
    const { vault, cleanup } = await makeVault();
    const server = new GatewayServer({
      target: fakePiTarget(),
      vaultRoot: vault,
      runnableAgents: ["piren"],
      initialAgent: "piren",
    });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/sessions`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        agent: string;
        sessions: Array<{ name: string; title: string }>;
      };
      expect(body.agent).toBe("piren");
      expect(body.sessions.length).toBe(1);
      expect(body.sessions[0]?.name).toBe("20260623T090000Z-add-tests.md");
      expect(body.sessions[0]?.title).toBe("Add Tests");
    } finally {
      await server.close();
      await cleanup();
    }
  });

  it("GET /api/chat/sessions returns 404 when no vaultRoot is configured", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/sessions`);
      expect(res.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("GET /api/chat/sessions returns 404 when no current agent is set", async () => {
    const { vault, cleanup } = await makeVault();
    const server = new GatewayServer({ target: fakePiTarget(), vaultRoot: vault });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/sessions`);
      expect(res.status).toBe(404);
    } finally {
      await server.close();
      await cleanup();
    }
  });
});
