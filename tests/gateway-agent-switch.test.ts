import { join } from "node:path";
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

describe("Gateway agent switching", () => {
  it("GET /api/chat/agents returns the runnable set and current agent", async () => {
    const server = new GatewayServer({
      target: fakePiTarget(),
      runnableAgents: ["piren", "thor"],
      initialAgent: "piren",
      targetBuilder: async () => fakePiTarget(),
    });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/agents`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { agents: string[]; current: string };
      expect(body.agents).toEqual(["piren", "thor"]);
      expect(body.current).toBe("piren");
    } finally {
      await server.close();
    }
  });

  it("POST /api/chat/switch changes the current agent", async () => {
    const server = new GatewayServer({
      target: fakePiTarget(),
      runnableAgents: ["piren", "thor"],
      initialAgent: "piren",
      targetBuilder: async () => fakePiTarget(),
    });
    try {
      const handle = await server.start();

      const switchRes = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "thor" }),
      });
      expect(switchRes.status).toBe(200);
      const switchBody = (await switchRes.json()) as { agent: string };
      expect(switchBody.agent).toBe("thor");

      // The agents route now reports thor as current.
      const agentsRes = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/agents`);
      const agentsBody = (await agentsRes.json()) as { current: string };
      expect(agentsBody.current).toBe("thor");
    } finally {
      await server.close();
    }
  });

  it("POST /api/chat/switch rejects an agent not in the runnable set with 403", async () => {
    const server = new GatewayServer({
      target: fakePiTarget(),
      runnableAgents: ["piren", "thor"],
      initialAgent: "piren",
      targetBuilder: async () => fakePiTarget(),
    });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "evil-agent" }),
      });
      expect(res.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("POST /api/chat/switch returns 403 when no targetBuilder is configured", async () => {
    const server = new GatewayServer({
      target: fakePiTarget(),
    });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "thor" }),
      });
      expect(res.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("POST /api/chat/switch with the same agent is a no-op success", async () => {
    const server = new GatewayServer({
      target: fakePiTarget(),
      runnableAgents: ["piren", "thor"],
      initialAgent: "piren",
      targetBuilder: async () => fakePiTarget(),
    });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "piren" }),
      });
      expect(res.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("POST /api/chat/switch rejects invalid JSON with 400", async () => {
    const server = new GatewayServer({
      target: fakePiTarget(),
      runnableAgents: ["piren"],
      initialAgent: "piren",
      targetBuilder: async () => fakePiTarget(),
    });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("GET /api/chat/agents works without runnableAgents configured", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/agents`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { agents: string[]; current: string | null };
      expect(body.agents).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
