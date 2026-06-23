import { type IncomingMessage, type ServerResponse, createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { PiRpcClient, type RpcEvent, type RpcSpawnTarget } from "./gateway-rpc.js";
import { piEventToSse, type SseEvent } from "./gateway-bridge.js";
import { vaultBrowserList, vaultBrowserRead } from "./vault-browser.js";

const HEARTBEAT_INTERVAL_MS = 30000;

export interface GatewayServerOptions {
  target: RpcSpawnTarget;
  vaultRoot?: string | undefined;
}

export interface GatewayHandle {
  port: number;
  hostname: string;
}

interface ChatStream {
  queue: SseEvent[];
  closed: boolean;
  waiters: Array<() => void>;
}

function wake(stream: ChatStream): void {
  const waiters = stream.waiters;
  stream.waiters = [];
  for (const waiter of waiters) {
    waiter();
  }
}

function enqueue(stream: ChatStream, event: SseEvent): void {
  stream.queue.push(event);
  wake(stream);
}

function closeStream(stream: ChatStream): void {
  stream.closed = true;
  wake(stream);
}

/**
 * Gateway HTTP/SSE server. One process, one shared Pi RPC client. The POST-start
 * plus GET-stream split decouples "kick off a turn" from "deliver the stream":
 * POST starts the RPC prompt and returns a stream_id immediately; GET drains the
 * bridge-translated SSE events until done or error.
 *
 * The HTTP layer is the transport. The bridge (gateway-bridge.ts) is the
 * mechanical Pi-event-to-SSE translation. The RPC client (gateway-rpc.ts) is the
 * transport-agnostic core. The gateway never imports Pi in-process.
 */
export class GatewayServer {
  private readonly server: Server;
  private readonly client: PiRpcClient;
  private readonly streams = new Map<string, ChatStream>();
  private readonly vaultRoot: string | undefined;
  private shuttingDown = false;

  constructor(options: GatewayServerOptions) {
    this.client = new PiRpcClient(options.target);
    this.vaultRoot = options.vaultRoot;
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  async start(port = 0, hostname = "127.0.0.1"): Promise<GatewayHandle> {
    await this.client.start();
    this.client.onExit(() => {
      if (this.shuttingDown) return;
      for (const stream of this.streams.values()) {
        if (!stream.closed) {
          enqueue(stream, { type: "error", data: { message: "Agent process exited unexpectedly." } });
        }
      }
    });

    await new Promise<void>((resolve) => {
      this.server.listen(port, hostname, resolve);
    });

    const address = this.server.address();
    const resolvedPort = typeof address === "object" && address ? address.port : port;
    return { port: resolvedPort, hostname };
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    await this.client.stop();
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/api/chat/start") {
      await this.handleStart(req, res);
    } else if (req.method === "GET" && url.pathname === "/api/chat/stream") {
      await this.handleStream(res, url);
    } else if (req.method === "GET" && url.pathname === "/api/vault/list") {
      await this.handleVaultList(res, url);
    } else if (req.method === "GET" && url.pathname === "/api/vault/read") {
      await this.handleVaultRead(res, url);
    } else {
      this.writeJson(res, 404, { error: "not found" });
    }
  }

  private async handleStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body = "";
    for await (const chunk of req) {
      body += typeof chunk === "string" ? chunk : chunk.toString();
    }

    let parsed: { message?: unknown };
    try {
      parsed = JSON.parse(body) as { message?: unknown };
    } catch {
      this.writeJson(res, 400, { error: "invalid JSON body" });
      return;
    }

    const message = parsed.message;
    if (typeof message !== "string" || message.trim() === "") {
      this.writeJson(res, 400, { error: "message is required" });
      return;
    }

    const streamId = randomUUID();
    const stream: ChatStream = { queue: [], closed: false, waiters: [] };
    this.streams.set(streamId, stream);

    const unsubscribe = this.client.onEvent((event: RpcEvent) => {
      const sse = piEventToSse(event);
      if (sse) {
        enqueue(stream, sse);
      }
      if (event.type === "agent_end") {
        unsubscribe();
        closeStream(stream);
      }
    });

    // Fire and forget: the POST returns immediately. Prompt errors and mid-stream
    // crashes surface as SSE error events via the catch and onExit paths.
    void this.client.prompt(message).catch((err: Error) => {
      unsubscribe();
      if (!stream.closed) {
        enqueue(stream, { type: "error", data: { message: err.message } });
        closeStream(stream);
      }
    });

    this.writeJson(res, 200, { stream_id: streamId });
  }

  private async handleStream(res: ServerResponse, url: URL): Promise<void> {
    const streamId = url.searchParams.get("stream_id");
    const stream = streamId ? this.streams.get(streamId) : undefined;
    if (!stream) {
      this.writeJson(res, 404, { error: "unknown stream_id" });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.flushHeaders?.();

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, HEARTBEAT_INTERVAL_MS);

    try {
      while (true) {
        while (stream.queue.length > 0) {
          const event = stream.queue.shift();
          if (!event) break;
          this.writeSse(res, event);
          if (event.type === "done" || event.type === "error") {
            return;
          }
        }
        if (stream.closed && stream.queue.length === 0) {
          return;
        }
        await new Promise<void>((resolve) => {
          stream.waiters.push(resolve);
        });
      }
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }

  private async handleVaultList(res: ServerResponse, url: URL): Promise<void> {
    if (!this.vaultRoot) {
      this.writeJson(res, 404, { error: "vault browser not configured" });
      return;
    }
    const path = url.searchParams.get("path") || ".";
    try {
      const result = await vaultBrowserList(this.vaultRoot, path);
      this.writeJson(res, 200, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("Path resolves outside vault")) {
        this.writeJson(res, 403, { error: msg });
      } else if (msg.startsWith("ENOENT") || msg.includes("ENOENT")) {
        this.writeJson(res, 404, { error: "path not found" });
      } else {
        this.writeJson(res, 400, { error: msg });
      }
    }
  }

  private async handleVaultRead(res: ServerResponse, url: URL): Promise<void> {
    if (!this.vaultRoot) {
      this.writeJson(res, 404, { error: "vault browser not configured" });
      return;
    }
    const path = url.searchParams.get("path");
    if (!path) {
      this.writeJson(res, 400, { error: "path is required" });
      return;
    }
    try {
      const result = await vaultBrowserRead(this.vaultRoot, path);
      this.writeJson(res, 200, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("Path resolves outside vault")) {
        this.writeJson(res, 403, { error: msg });
      } else if (msg.startsWith("ENOENT") || msg.includes("ENOENT")) {
        this.writeJson(res, 404, { error: "path not found" });
      } else {
        this.writeJson(res, 400, { error: msg });
      }
    }
  }

  private writeJson(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  }

  private writeSse(res: ServerResponse, event: SseEvent): void {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  }
}
