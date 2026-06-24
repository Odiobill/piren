import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayServer } from "../src/gateway-http.js";

const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");

function fakePiTarget() {
  return {
    command: process.execPath,
    args: [fakePiScript],
    cwd: process.cwd(),
    env: process.env,
  };
}

describe("Gateway HTTP model and state routes", () => {
  it("GET /api/chat/models returns the available models list", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/models`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { models: Array<{ provider: string; id: string }> };
      expect(body.models.length).toBeGreaterThan(0);
      expect(body.models[0]?.provider).toBe("anthropic");
    } finally {
      await server.close();
    }
  });

  it("GET /api/chat/state returns the current session state", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/state`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessionId: string; isStreaming: boolean };
      expect(body.sessionId).toBe("fake-session");
      expect(body.isStreaming).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("POST /api/chat/model switches the active model", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", modelId: "claude-sonnet-4-20250514" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { provider: string; id: string };
      expect(body.provider).toBe("anthropic");
      expect(body.id).toBe("claude-sonnet-4-20250514");
    } finally {
      await server.close();
    }
  });

  it("POST /api/chat/model rejects invalid JSON body with 400", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("POST /api/chat/model returns 400 when provider or modelId is missing", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "anthropic" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("POST /api/chat/model surfaces Pi rejection as an error", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "bogus", modelId: "nope" }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("model not found");
    } finally {
      await server.close();
    }
  });

  it("POST /api/chat/thinking sets the thinking level", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/thinking`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ level: "medium" }),
      });
      expect(res.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("POST /api/chat/thinking returns 400 when level is missing", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/thinking`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});
