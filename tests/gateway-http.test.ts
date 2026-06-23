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

interface SseFrame {
  event: string;
  data: string;
}

function parseSse(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim() || block.startsWith(":")) continue;
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice("event: ".length);
      else if (line.startsWith("data: ")) data = line.slice("data: ".length);
    }
    if (event) frames.push({ event, data });
  }
  return frames;
}

describe("GatewayServer HTTP/SSE transport against a fake Pi process", () => {
  it("streams a prompt response over POST-start plus GET-stream", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();

      const start = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Hello" }),
      });
      expect(start.status).toBe(200);
      const { stream_id } = (await start.json()) as { stream_id: string };
      expect(typeof stream_id).toBe("string");
      expect(stream_id.length).toBeGreaterThan(0);

      const stream = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/stream?stream_id=${stream_id}`);
      expect(stream.headers.get("content-type")).toBe("text/event-stream");

      const frames = parseSse(await stream.text());
      const tokenText = frames
        .filter((frame) => frame.event === "token")
        .map((frame) => (JSON.parse(frame.data) as { text: string }).text)
        .join("");
      const last = frames[frames.length - 1] ?? { event: "", data: "" };

      expect(tokenText).toBe("Hello");
      expect(last.event).toBe("done");
    } finally {
      await server.close();
    }
  });

  it("rejects a start request without a message with 400", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("returns 404 for an unknown stream id", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/stream?stream_id=does-not-exist`);
      expect(res.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
