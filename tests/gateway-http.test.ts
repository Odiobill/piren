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

  it("rejects oversized JSON request bodies before parsing", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const oversized = JSON.stringify({ message: "x".repeat(1024 * 1024 + 1) });
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: oversized,
      });
      expect(res.status).toBe(413);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/too large/i);
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

  it("returns an OpenAI-compatible non-streaming chat completion", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "piren/default",
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        object: string;
        choices: Array<{ index: number; message: { role: string; content: string }; finish_reason: string }>;
      };
      expect(body.object).toBe("chat.completion");
      expect(body.choices).toEqual([
        { index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" },
      ]);
    } finally {
      await server.close();
    }
  });

  it("streams OpenAI-compatible chat completion chunks", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "piren/default",
          stream: true,
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      const text = await res.text();
      const dataLines = text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length));
      expect(dataLines[dataLines.length - 1]).toBe("[DONE]");
      const chunks = dataLines.slice(0, -1).map((line) => JSON.parse(line) as { object: string; choices: Array<{ delta: { content?: string } }> });
      expect(chunks.every((chunk) => chunk.object === "chat.completion.chunk")).toBe(true);
      expect(chunks.map((chunk) => chunk.choices[0]?.delta.content ?? "").join("")).toBe("Hello");
    } finally {
      await server.close();
    }
  });
});
