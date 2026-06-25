import { type IncomingMessage, type ServerResponse, createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve, relative, join, extname } from "node:path";
import { PiRpcClient, extractAssistantText, type RpcEvent, type RpcSpawnTarget } from "./gateway-rpc.js";
import { piEventToSse, type SseEvent } from "./gateway-bridge.js";
import { vaultBrowserList, vaultBrowserRead } from "./vault-browser.js";
import { listAgentSessions } from "./session-browser.js";
import { isBearerAuthorized } from "./gateway-auth.js";

const HEARTBEAT_INTERVAL_MS = 30000;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
};

export type RpcTargetBuilder = (agent: string) => Promise<RpcSpawnTarget>;

export interface GatewayServerOptions {
  target: RpcSpawnTarget;
  vaultRoot?: string | undefined;
  /** Runnable agents for the web UI. If absent, agent switching is disabled. */
  runnableAgents?: string[] | undefined;
  /** Initial active agent. Defaults to the first runnable agent or null. */
  initialAgent?: string | undefined;
  /**
   * Builds a new spawn target when switching agents. Required for agent
   * switching; if absent, POST /api/chat/switch returns 403.
   */
  targetBuilder?: RpcTargetBuilder | undefined;
  /**
   * Shared bootstrap token for Bearer auth. When set, all /api/* routes
   * except /api/auth/info require a matching `Authorization: Bearer <token>`
   * header. When absent (localhost dev), auth is not enforced.
   */
  authToken?: string | undefined;
  /**
   * Directory of static frontend files. When set, the gateway serves
   * index.html at GET / and other files by relative path with MIME type
   * detection. API routes always take priority over static files.
   */
  publicDir?: string | undefined;
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
  private client: PiRpcClient;
  private readonly streams = new Map<string, ChatStream>();
  private readonly vaultRoot: string | undefined;
  private readonly runnableAgents: string[];
  private currentAgent: string | null;
  private readonly targetBuilder: RpcTargetBuilder | undefined;
  private readonly authToken: string;
  private readonly publicDir: string | undefined;
  private shuttingDown = false;

  constructor(options: GatewayServerOptions) {
    this.client = new PiRpcClient(options.target);
    this.vaultRoot = options.vaultRoot;
    this.runnableAgents = options.runnableAgents ?? [];
    this.targetBuilder = options.targetBuilder;
    this.authToken = options.authToken ?? "";
    this.publicDir = options.publicDir;
    if (options.initialAgent !== undefined) {
      this.currentAgent = options.initialAgent;
    } else if (this.runnableAgents.length > 0) {
      this.currentAgent = this.runnableAgents[0] as string;
    } else {
      this.currentAgent = null;
    }
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  async start(port = 0, hostname = "127.0.0.1"): Promise<GatewayHandle> {
    await this.client.start();
    this.installExitHandler(this.client);

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

  private installExitHandler(client: PiRpcClient): void {
    client.onExit(() => {
      if (this.shuttingDown) return;
      // Only surface exit errors if this is still the active client. After a
      // switch, the old client's intentional stop must not leak error events.
      if (client !== this.client) return;
      for (const stream of this.streams.values()) {
        if (!stream.closed) {
          enqueue(stream, { type: "error", data: { message: "Agent process exited unexpectedly." } });
        }
      }
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    // The auth-info route is always public: the frontend needs to know whether
    // to prompt for a token before it can make any authenticated request.
    if (req.method === "GET" && url.pathname === "/api/auth/info") {
      this.writeJson(res, 200, { authRequired: this.authToken !== "" });
      return;
    }

    // Enforce Bearer auth on all other /api/* routes when a token is
    // configured. On localhost with no token, auth is optional and this gate
    // is a no-op.
    if (this.authToken !== "" && url.pathname.startsWith("/api/")) {
      if (!isBearerAuthorized(req.headers.authorization, this.authToken)) {
        res.writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": 'Bearer realm="piren"',
        });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }

    if (req.method === "POST" && url.pathname === "/api/chat/start") {
      await this.handleStart(req, res);
    } else if (req.method === "GET" && url.pathname === "/api/chat/stream") {
      await this.handleStream(res, url);
    } else if (req.method === "GET" && url.pathname === "/api/chat/models") {
      await this.handleModels(res);
    } else if (req.method === "GET" && url.pathname === "/api/chat/state") {
      await this.handleState(res);
    } else if (req.method === "POST" && url.pathname === "/api/chat/model") {
      await this.handleSetModel(req, res);
    } else if (req.method === "POST" && url.pathname === "/api/chat/thinking") {
      await this.handleSetThinking(req, res);
    } else if (req.method === "GET" && url.pathname === "/api/chat/agents") {
      await this.handleAgents(res);
    } else if (req.method === "POST" && url.pathname === "/api/chat/switch") {
      await this.handleSwitch(req, res);
    } else if (req.method === "POST" && url.pathname === "/api/chat/approve") {
      await this.handleApprove(req, res);
    } else if (req.method === "POST" && url.pathname === "/api/chat/abort") {
      await this.handleAbort(res);
    } else if (req.method === "GET" && url.pathname === "/api/chat/messages") {
      await this.handleMessages(res);
    } else if (req.method === "POST" && url.pathname === "/api/chat/resume") {
      await this.handleResume(req, res);
    } else if (req.method === "GET" && url.pathname === "/api/chat/sessions") {
      await this.handleSessions(res);
    } else if (req.method === "POST" && url.pathname === "/api/v1/chat/completions") {
      await this.handleOpenAiChatCompletions(req, res);
    } else if (req.method === "GET" && url.pathname === "/api/vault/list") {
      await this.handleVaultList(res, url);
    } else if (req.method === "GET" && url.pathname === "/api/vault/read") {
      await this.handleVaultRead(res, url);
    } else if (req.method === "GET" && this.publicDir) {
      await this.handleStatic(res, url.pathname);
    } else {
      this.writeJson(res, 404, { error: "not found" });
    }
  }

  /**
   * Serve a static file from publicDir. Path traversal is rejected: the
   * resolved path must be inside publicDir (checked via relative()).
   * GET / maps to index.html. Directories fall back to index.html if it
   * exists, otherwise 404.
   */
  private async handleStatic(res: ServerResponse, pathname: string): Promise<void> {
    if (!this.publicDir) {
      this.writeJson(res, 404, { error: "not found" });
      return;
    }

    const root = resolve(this.publicDir);
    const requestPath = pathname === "/" ? "/index.html" : pathname;
    const filePath = resolve(join(root, requestPath));

    // Hard path-boundary enforcement: the resolved path must be inside root.
    const rel = relative(root, filePath);
    if (rel.startsWith("..") || rel === "") {
      this.writeJson(res, 403, { error: "path traversal rejected" });
      return;
    }

    try {
      const stats = await stat(filePath);
      if (stats.isDirectory()) {
        const indexPath = join(filePath, "index.html");
        try {
          await stat(indexPath);
          await this.serveFile(res, indexPath);
          return;
        } catch {
          this.writeJson(res, 404, { error: "not found" });
          return;
        }
      }
      await this.serveFile(res, filePath);
    } catch {
      this.writeJson(res, 404, { error: "not found" });
    }
  }

  private async serveFile(res: ServerResponse, filePath: string): Promise<void> {
    try {
      const content = await readFile(filePath);
      const ext = extname(filePath).toLowerCase();
      const mime = MIME_TYPES[ext] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": mime });
      res.end(content);
    } catch {
      this.writeJson(res, 404, { error: "not found" });
    }
  }

  private async handleStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body = "";
    for await (const chunk of req) {
      body += typeof chunk === "string" ? chunk : chunk.toString();
    }

    let parsed: { message?: unknown; mode?: unknown };
    try {
      parsed = JSON.parse(body) as { message?: unknown; mode?: unknown };
    } catch {
      this.writeJson(res, 400, { error: "invalid JSON body" });
      return;
    }

    const message = parsed.message;
    if (typeof message !== "string" || message.trim() === "") {
      this.writeJson(res, 400, { error: "message is required" });
      return;
    }

    const mode = parsed.mode;
    if (mode !== undefined && mode !== "steer" && mode !== "follow_up") {
      this.writeJson(res, 400, { error: "mode must be 'steer' or 'follow_up'" });
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

    // Fire and forget: the POST returns immediately. Errors and mid-stream
    // crashes surface as SSE error events via the catch and onExit paths.
    //
    // When mode is "steer" or "follow_up", send the corresponding RPC command
    // instead of a new prompt. Events from the ongoing turn flow through the
    // same SSE stream.
    const sendPromise =
      mode === "steer"
        ? this.client.steer(message)
        : mode === "follow_up"
          ? this.client.followUp(message)
          : this.client.prompt(message);

    void sendPromise.catch((err: Error) => {
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

  private async handleModels(res: ServerResponse): Promise<void> {
    try {
      const result = await this.client.getAvailableModels();
      this.writeJson(res, 200, result);
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleOpenAiChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req);
    if (body === null) {
      this.writeJson(res, 400, { error: "invalid JSON body" });
      return;
    }

    const messages = (body as { messages?: unknown }).messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      this.writeJson(res, 400, { error: "messages array is required" });
      return;
    }

    const prompt = this.openAiMessagesToPrompt(messages);
    if (prompt.trim() === "") {
      this.writeJson(res, 400, { error: "at least one message with text content is required" });
      return;
    }

    try {
      const requestedStream = (body as { stream?: unknown }).stream;
      if (requestedStream === true) {
        await this.handleOpenAiChatCompletionsStream(res, prompt, body);
        return;
      }

      const events = await this.client.promptAndWait(prompt);
      const content = extractAssistantText(events).trim();
      const requestedModel = (body as { model?: unknown }).model;
      const model = typeof requestedModel === "string" && requestedModel.trim() !== "" ? requestedModel : "piren/default";
      this.writeJson(res, 200, {
        id: `chatcmpl-${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
      });
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private openAiMessagesToPrompt(messages: unknown[]): string {
    const parts: string[] = [];
    for (const item of messages) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as { role?: unknown; content?: unknown };
      const role = typeof record.role === "string" && record.role.trim() !== "" ? record.role : "user";
      const content = this.openAiContentToText(record.content);
      if (content.trim() !== "") {
        parts.push(`${role}: ${content}`);
      }
    }
    return parts.join("\n");
  }

  private async handleOpenAiChatCompletionsStream(res: ServerResponse, prompt: string, body: Record<string, unknown>): Promise<void> {
    const requestedModel = body.model;
    const model = typeof requestedModel === "string" && requestedModel.trim() !== "" ? requestedModel : "piren/default";
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.flushHeaders?.();

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        res.write("data: [DONE]\n\n");
        res.end();
        resolve();
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        resolve();
      };
      const unsubscribe = this.client.onEvent((event) => {
        const delta = this.openAiTextDeltaFromEvent(event);
        if (delta !== null) {
          res.write(`data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          })}\n\n`);
        }
        if (event.type === "agent_end") {
          res.write(`data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`);
          finish();
        }
      });
      this.client.prompt(prompt).catch((err) => fail(err instanceof Error ? err : new Error(String(err))));
    });
  }

  private openAiTextDeltaFromEvent(event: RpcEvent): string | null {
    if (event.type !== "message_update") return null;
    const inner = event.assistantMessageEvent;
    if (typeof inner !== "object" || inner === null) return null;
    const record = inner as { type?: unknown; delta?: unknown };
    if (record.type === "text_delta" && typeof record.delta === "string") {
      return record.delta;
    }
    return null;
  }

  private openAiContentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "object" && part !== null) {
        const record = part as { type?: unknown; text?: unknown };
        if ((record.type === undefined || record.type === "text") && typeof record.text === "string") {
          parts.push(record.text);
        }
      }
    }
    return parts.join("\n");
  }

  private async handleState(res: ServerResponse): Promise<void> {
    try {
      const state = await this.client.getState();
      this.writeJson(res, 200, state);
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleSetModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req);
    if (body === null) {
      this.writeJson(res, 400, { error: "invalid JSON body" });
      return;
    }

    const provider = (body as { provider?: unknown }).provider;
    const modelId = (body as { modelId?: unknown }).modelId;
    if (typeof provider !== "string" || typeof modelId !== "string") {
      this.writeJson(res, 400, { error: "provider and modelId are required" });
      return;
    }

    try {
      const model = await this.client.setModel(provider, modelId);
      this.writeJson(res, 200, model);
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleSetThinking(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req);
    if (body === null) {
      this.writeJson(res, 400, { error: "invalid JSON body" });
      return;
    }

    const level = (body as { level?: unknown }).level;
    if (typeof level !== "string") {
      this.writeJson(res, 400, { error: "level is required" });
      return;
    }

    try {
      await this.client.setThinkingLevel(level);
      this.writeJson(res, 200, { ok: true });
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    let body = "";
    for await (const chunk of req) {
      body += typeof chunk === "string" ? chunk : chunk.toString();
    }
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private async handleApprove(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req);
    if (body === null) {
      this.writeJson(res, 400, { error: "invalid JSON body" });
      return;
    }

    const id = (body as { id?: unknown }).id;
    if (typeof id !== "string") {
      this.writeJson(res, 400, { error: "id is required" });
      return;
    }

    // Exactly one of confirmed, value, or cancelled must be present.
    const confirmed = (body as { confirmed?: unknown }).confirmed;
    const value = (body as { value?: unknown }).value;
    const cancelled = (body as { cancelled?: unknown }).cancelled;

    try {
      if (cancelled === true) {
        this.client.respondToUiRequest(id, { cancelled: true });
      } else if (typeof confirmed === "boolean") {
        this.client.respondToUiRequest(id, { confirmed });
      } else if (typeof value === "string") {
        this.client.respondToUiRequest(id, { value });
      } else {
        this.writeJson(res, 400, { error: "one of confirmed, value, or cancelled is required" });
        return;
      }
      this.writeJson(res, 200, { ok: true });
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Abort the current turn mid-stream. The abort RPC command emits agent_end,
   * which drains any active SSE streams so they close cleanly. There is no
   * dedicated stream for the abort itself: the outcome is observed on the
   * existing stream bound to the active turn.
   */
  private async handleAbort(res: ServerResponse): Promise<void> {
    try {
      await this.client.abort();
      this.writeJson(res, 200, { ok: true });
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Return the full transcript of the current Pi session. Used to repopulate
   * the chat view after a browser reconnect so the steward sees prior context.
   */
  private async handleMessages(res: ServerResponse): Promise<void> {
    try {
      const result = await this.client.getMessages();
      this.writeJson(res, 200, result);
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Resume a past Pi session by its on-disk path. On a successful resume,
   * subsequent prompts and events belong to the resumed session. The response
   * carries `cancelled` so the frontend can fall back gracefully when Pi could
   * not resume the requested session.
   */
  private async handleResume(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req);
    if (body === null) {
      this.writeJson(res, 400, { error: "invalid JSON body" });
      return;
    }

    const sessionPath = (body as { sessionPath?: unknown }).sessionPath;
    if (typeof sessionPath !== "string" || sessionPath.trim() === "") {
      this.writeJson(res, 400, { error: "sessionPath is required" });
      return;
    }

    try {
      const result = await this.client.switchSession(sessionPath);
      this.writeJson(res, 200, result);
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * List vault session summaries under team/<currentAgent>/sessions/. These are
   * the agent's past conversations as recorded by session_write_summary. The
   * list is newest-first. Requires both vaultRoot and a current agent.
   */
  private async handleSessions(res: ServerResponse): Promise<void> {
    if (!this.vaultRoot) {
      this.writeJson(res, 404, { error: "session browser not configured" });
      return;
    }
    if (!this.currentAgent) {
      this.writeJson(res, 404, { error: "no active agent selected" });
      return;
    }
    try {
      const result = await listAgentSessions(this.vaultRoot, this.currentAgent);
      this.writeJson(res, 200, result);
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleAgents(res: ServerResponse): Promise<void> {
    this.writeJson(res, 200, { agents: this.runnableAgents, current: this.currentAgent });
  }

  private async handleSwitch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.targetBuilder) {
      this.writeJson(res, 403, { error: "agent switching is not configured on this installation" });
      return;
    }

    const body = await this.readJsonBody(req);
    if (body === null) {
      this.writeJson(res, 400, { error: "invalid JSON body" });
      return;
    }

    const agent = (body as { agent?: unknown }).agent;
    if (typeof agent !== "string") {
      this.writeJson(res, 400, { error: "agent is required" });
      return;
    }

    if (!this.runnableAgents.includes(agent)) {
      this.writeJson(res, 403, { error: `agent '${agent}' is not in the runnable set` });
      return;
    }

    // No-op: same agent already running. Avoids restarting Pi for nothing.
    if (agent === this.currentAgent) {
      this.writeJson(res, 200, { agent, switched: false });
      return;
    }

    const oldClient = this.client;
    try {
      const target = await this.targetBuilder(agent);
      const nextClient = new PiRpcClient(target);
      await nextClient.start();
      this.installExitHandler(nextClient);

      // Swap the active client before stopping the old one. The exit handler
      // guards against the old client's intentional stop leaking errors.
      this.client = nextClient;
      this.currentAgent = agent;

      // Close any streams still bound to the old client; they cannot continue
      // across an agent restart.
      for (const stream of this.streams.values()) {
        if (!stream.closed) {
          enqueue(stream, { type: "error", data: { message: "Agent switched; stream closed." } });
          closeStream(stream);
        }
      }
      this.streams.clear();

      await oldClient.stop();
      this.writeJson(res, 200, { agent, switched: true });
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
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
