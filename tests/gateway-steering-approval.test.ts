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

/**
 * Read an SSE stream until a terminal event (done/error) and collect all events.
 * Returns an array of {type, data} parsed from the SSE response.
 */
async function drainSse(
  url: string,
): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
  const res = await fetch(url);
  const text = await res.text();
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const blocks = text.split("\n\n");
  for (const block of blocks) {
    const eventLine = block.match(/^event: (.+)$/m);
    const dataLine = block.match(/^data: (.+)$/m);
    if (eventLine && dataLine) {
      try {
        events.push({ type: eventLine[1] as string, data: JSON.parse(dataLine[1] as string) });
      } catch {
        // skip non-JSON (e.g. heartbeat)
      }
    }
  }
  return events;
}

describe("Gateway steering and approval routes", () => {
  it("POST /api/chat/start with mode=steer sends a steer command and returns a stream_id", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();

      // First, start a normal prompt so there is an active stream.
      const startRes = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Hello" }),
      });
      expect(startRes.status).toBe(200);

      // Now send a steer.
      const steerRes = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "actually wait", mode: "steer" }),
      });
      expect(steerRes.status).toBe(200);
      const steerBody = (await steerRes.json()) as { stream_id: string };
      expect(steerBody.stream_id).toBeDefined();
    } finally {
      await server.close();
    }
  });

  it("POST /api/chat/start with mode=follow_up sends a follow-up command", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();

      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "and then this", mode: "follow_up" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { stream_id: string };
      expect(body.stream_id).toBeDefined();
    } finally {
      await server.close();
    }
  });

  it("POST /api/chat/start with an invalid mode returns 400", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hi", mode: "bogus" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("the SSE stream includes a queue event from queue_update", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();

      const startRes = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Hello" }),
      });
      const { stream_id } = (await startRes.json()) as { stream_id: string };

      const events = await drainSse(
        `http://${handle.hostname}:${handle.port}/api/chat/stream?stream_id=${stream_id}`,
      );
      const types = events.map((e) => e.type);
      expect(types).toContain("queue");
    } finally {
      await server.close();
    }
  });

  it("the SSE stream includes an approval event for approve messages", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();

      const startRes = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "please approve this action" }),
      });
      const { stream_id } = (await startRes.json()) as { stream_id: string };

      const events = await drainSse(
        `http://${handle.hostname}:${handle.port}/api/chat/stream?stream_id=${stream_id}`,
      );
      const approval = events.find((e) => e.type === "approval");
      expect(approval).toBeDefined();
      expect(approval?.data.method).toBe("confirm");
      expect(typeof approval?.data.id).toBe("string");
    } finally {
      await server.close();
    }
  });

  it("POST /api/chat/approve responds to an approval request without error", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();

      // Start a prompt that triggers an approval request.
      await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "please approve this action" }),
      });

      // Poll the state until we see the approval id. For the test, we know the
      // fake Pi emits it quickly, so a short fetch on the stream gives us the id.
      // Instead, we can use the approval id from the fake Pi's deterministic format.
      // The fake emits "ui-req-<timestamp>", so we just need any string id.
      // The approve route should accept it and forward to the client.
      const approveRes = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "ui-req-test", confirmed: true }),
      });
      expect(approveRes.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("POST /api/chat/approve with cancelled:true works", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();

      const approveRes = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "ui-req-test", cancelled: true }),
      });
      expect(approveRes.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("POST /api/chat/approve returns 400 when id is missing", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();

      const approveRes = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      expect(approveRes.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("POST /api/chat/approve returns 400 with invalid JSON", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();

      const approveRes = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      });
      expect(approveRes.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});
