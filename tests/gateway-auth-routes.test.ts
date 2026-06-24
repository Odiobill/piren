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

describe("Gateway auth routes", () => {
  it("GET /api/auth/info reports authRequired=false when no token is configured", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/auth/info`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { authRequired: boolean };
      expect(body.authRequired).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("GET /api/auth/info reports authRequired=true when a token is configured", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), authToken: "secret-token" });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/auth/info`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { authRequired: boolean };
      expect(body.authRequired).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("rejects an API request without a token when auth is configured (401)", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), authToken: "secret-token" });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/state`);
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("rejects an API request with a wrong token (401)", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), authToken: "secret-token" });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/state`, {
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("accepts an API request with the correct Bearer token", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), authToken: "secret-token" });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/state`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(res.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("does not require auth when no token is configured (localhost dev)", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/state`);
      expect(res.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("GET /api/auth/info is always public (no token needed even when auth is on)", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), authToken: "secret-token" });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/auth/info`);
      expect(res.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("rejects POST /api/chat/start without a token when auth is configured", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), authToken: "secret-token" });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Hello" }),
      });
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });
});
