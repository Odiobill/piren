import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve, relative, join, extname } from "node:path";
import { PiRpcClient, extractAssistantText } from "./gateway-rpc.js";
import { piEventToSse } from "./gateway-bridge.js";
import { vaultBrowserList, vaultBrowserRead } from "./vault-browser.js";
import { listAgentSessions } from "./session-browser.js";
import { isBearerAuthorized } from "./gateway-auth.js";
import { createInboxTask } from "./inbox.js";
const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MIME_TYPES = {
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
function wake(stream) {
    const waiters = stream.waiters;
    stream.waiters = [];
    for (const waiter of waiters) {
        waiter();
    }
}
function enqueue(stream, event) {
    stream.queue.push(event);
    wake(stream);
}
function closeStream(stream) {
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
    server;
    client;
    streams = new Map();
    vaultRoot;
    runnableAgents;
    currentAgent;
    targetBuilder;
    authToken;
    publicDir;
    shuttingDown = false;
    constructor(options) {
        this.client = new PiRpcClient(options.target);
        this.vaultRoot = options.vaultRoot;
        this.runnableAgents = options.runnableAgents ?? [];
        this.targetBuilder = options.targetBuilder;
        this.authToken = options.authToken ?? "";
        this.publicDir = options.publicDir;
        if (options.initialAgent !== undefined) {
            this.currentAgent = options.initialAgent;
        }
        else if (this.runnableAgents.length > 0) {
            this.currentAgent = this.runnableAgents[0];
        }
        else {
            this.currentAgent = null;
        }
        this.server = createServer((req, res) => {
            void this.handle(req, res);
        });
    }
    async start(port = 0, hostname = "127.0.0.1") {
        await this.client.start();
        this.installExitHandler(this.client);
        await new Promise((resolve) => {
            this.server.listen(port, hostname, resolve);
        });
        const address = this.server.address();
        const resolvedPort = typeof address === "object" && address ? address.port : port;
        return { port: resolvedPort, hostname };
    }
    async close() {
        this.shuttingDown = true;
        await this.client.stop();
        await new Promise((resolve, reject) => {
            this.server.close((err) => (err ? reject(err) : resolve()));
        });
    }
    installExitHandler(client) {
        client.onExit(() => {
            if (this.shuttingDown)
                return;
            // Only surface exit errors if this is still the active client. After a
            // switch, the old client's intentional stop must not leak error events.
            if (client !== this.client)
                return;
            for (const stream of this.streams.values()) {
                if (!stream.closed) {
                    enqueue(stream, { type: "error", data: { message: "Agent process exited unexpectedly." } });
                }
            }
        });
    }
    async handle(req, res) {
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
        }
        else if (req.method === "GET" && url.pathname === "/api/chat/stream") {
            await this.handleStream(res, url);
        }
        else if (req.method === "GET" && url.pathname === "/api/chat/models") {
            await this.handleModels(res);
        }
        else if (req.method === "GET" && url.pathname === "/api/chat/state") {
            await this.handleState(res);
        }
        else if (req.method === "POST" && url.pathname === "/api/chat/model") {
            await this.handleSetModel(req, res);
        }
        else if (req.method === "POST" && url.pathname === "/api/chat/thinking") {
            await this.handleSetThinking(req, res);
        }
        else if (req.method === "GET" && url.pathname === "/api/chat/agents") {
            await this.handleAgents(res);
        }
        else if (req.method === "POST" && url.pathname === "/api/chat/switch") {
            await this.handleSwitch(req, res);
        }
        else if (req.method === "POST" && url.pathname === "/api/chat/approve") {
            await this.handleApprove(req, res);
        }
        else if (req.method === "POST" && url.pathname === "/api/chat/abort") {
            await this.handleAbort(res);
        }
        else if (req.method === "GET" && url.pathname === "/api/chat/messages") {
            await this.handleMessages(res);
        }
        else if (req.method === "POST" && url.pathname === "/api/chat/resume") {
            await this.handleResume(req, res);
        }
        else if (req.method === "GET" && url.pathname === "/api/chat/sessions") {
            await this.handleSessions(res);
        }
        else if (req.method === "POST" && url.pathname === "/api/v1/chat/completions") {
            await this.handleOpenAiChatCompletions(req, res);
        }
        else if (req.method === "GET" && url.pathname === "/api/vault/list") {
            await this.handleVaultList(res, url);
        }
        else if (req.method === "GET" && url.pathname === "/api/vault/read") {
            await this.handleVaultRead(res, url);
        }
        else if (req.method === "POST" && url.pathname === "/api/vault/inbox") {
            await this.handleVaultInbox(req, res);
        }
        else if (req.method === "GET" && this.publicDir) {
            await this.handleStatic(res, url.pathname);
        }
        else {
            this.writeJson(res, 404, { error: "not found" });
        }
    }
    /**
     * Serve a static file from publicDir. Path traversal is rejected: the
     * resolved path must be inside publicDir (checked via relative()).
     * GET / maps to index.html. Directories fall back to index.html if it
     * exists, otherwise 404.
     */
    async handleStatic(res, pathname) {
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
                }
                catch {
                    this.writeJson(res, 404, { error: "not found" });
                    return;
                }
            }
            await this.serveFile(res, filePath);
        }
        catch {
            this.writeJson(res, 404, { error: "not found" });
        }
    }
    async serveFile(res, filePath) {
        try {
            const content = await readFile(filePath);
            const ext = extname(filePath).toLowerCase();
            const mime = MIME_TYPES[ext] ?? "application/octet-stream";
            res.writeHead(200, { "content-type": mime });
            res.end(content);
        }
        catch {
            this.writeJson(res, 404, { error: "not found" });
        }
    }
    async handleStart(req, res) {
        const parsed = await this.readJsonBody(req);
        if (!parsed.ok) {
            this.writeJson(res, parsed.status, { error: parsed.error });
            return;
        }
        const message = parsed.value.message;
        if (typeof message !== "string" || message.trim() === "") {
            this.writeJson(res, 400, { error: "message is required" });
            return;
        }
        const mode = parsed.value.mode;
        if (mode !== undefined && mode !== "steer" && mode !== "follow_up") {
            this.writeJson(res, 400, { error: "mode must be 'steer' or 'follow_up'" });
            return;
        }
        const streamId = randomUUID();
        const stream = { queue: [], closed: false, waiters: [] };
        this.streams.set(streamId, stream);
        const unsubscribe = this.client.onEvent((event) => {
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
        const sendPromise = mode === "steer"
            ? this.client.steer(message)
            : mode === "follow_up"
                ? this.client.followUp(message)
                : this.client.prompt(message);
        void sendPromise.catch((err) => {
            unsubscribe();
            if (!stream.closed) {
                enqueue(stream, { type: "error", data: { message: err.message } });
                closeStream(stream);
            }
        });
        this.writeJson(res, 200, { stream_id: streamId });
    }
    async handleStream(res, url) {
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
                    if (!event)
                        break;
                    this.writeSse(res, event);
                    if (event.type === "done" || event.type === "error") {
                        return;
                    }
                }
                if (stream.closed && stream.queue.length === 0) {
                    return;
                }
                await new Promise((resolve) => {
                    stream.waiters.push(resolve);
                });
            }
        }
        finally {
            clearInterval(heartbeat);
            res.end();
        }
    }
    async handleModels(res) {
        try {
            const result = await this.client.getAvailableModels();
            this.writeJson(res, 200, result);
        }
        catch (err) {
            this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }
    async handleOpenAiChatCompletions(req, res) {
        const body = await this.readJsonBody(req);
        if (!body.ok) {
            this.writeJson(res, body.status, { error: body.error });
            return;
        }
        const messages = body.value.messages;
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
            const requestedStream = body.value.stream;
            if (requestedStream === true) {
                await this.handleOpenAiChatCompletionsStream(res, prompt, body.value);
                return;
            }
            const events = await this.client.promptAndWait(prompt);
            const content = extractAssistantText(events).trim();
            const requestedModel = body.value.model;
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
        }
        catch (err) {
            this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }
    openAiMessagesToPrompt(messages) {
        const parts = [];
        for (const item of messages) {
            if (typeof item !== "object" || item === null)
                continue;
            const record = item;
            const role = typeof record.role === "string" && record.role.trim() !== "" ? record.role : "user";
            const content = this.openAiContentToText(record.content);
            if (content.trim() !== "") {
                parts.push(`${role}: ${content}`);
            }
        }
        return parts.join("\n");
    }
    async handleOpenAiChatCompletionsStream(res, prompt, body) {
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
        await new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                unsubscribe();
                res.write("data: [DONE]\n\n");
                res.end();
                resolve();
            };
            const fail = (error) => {
                if (settled)
                    return;
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
    openAiTextDeltaFromEvent(event) {
        if (event.type !== "message_update")
            return null;
        const inner = event.assistantMessageEvent;
        if (typeof inner !== "object" || inner === null)
            return null;
        const record = inner;
        if (record.type === "text_delta" && typeof record.delta === "string") {
            return record.delta;
        }
        return null;
    }
    openAiContentToText(content) {
        if (typeof content === "string")
            return content;
        if (!Array.isArray(content))
            return "";
        const parts = [];
        for (const part of content) {
            if (typeof part === "object" && part !== null) {
                const record = part;
                if ((record.type === undefined || record.type === "text") && typeof record.text === "string") {
                    parts.push(record.text);
                }
            }
        }
        return parts.join("\n");
    }
    async handleState(res) {
        try {
            const state = await this.client.getState();
            this.writeJson(res, 200, state);
        }
        catch (err) {
            this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }
    async handleSetModel(req, res) {
        const body = await this.readJsonBody(req);
        if (!body.ok) {
            this.writeJson(res, body.status, { error: body.error });
            return;
        }
        const provider = body.value.provider;
        const modelId = body.value.modelId;
        if (typeof provider !== "string" || typeof modelId !== "string") {
            this.writeJson(res, 400, { error: "provider and modelId are required" });
            return;
        }
        try {
            const model = await this.client.setModel(provider, modelId);
            this.writeJson(res, 200, model);
        }
        catch (err) {
            this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }
    async handleSetThinking(req, res) {
        const body = await this.readJsonBody(req);
        if (!body.ok) {
            this.writeJson(res, body.status, { error: body.error });
            return;
        }
        const level = body.value.level;
        if (typeof level !== "string") {
            this.writeJson(res, 400, { error: "level is required" });
            return;
        }
        try {
            await this.client.setThinkingLevel(level);
            this.writeJson(res, 200, { ok: true });
        }
        catch (err) {
            this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }
    async readJsonBody(req) {
        let body = "";
        let bytes = 0;
        for await (const chunk of req) {
            bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
            if (bytes > MAX_JSON_BODY_BYTES) {
                return { ok: false, status: 413, error: "JSON request body is too large" };
            }
            body += typeof chunk === "string" ? chunk : chunk.toString();
        }
        try {
            const parsed = JSON.parse(body);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                return { ok: false, status: 400, error: "invalid JSON body" };
            }
            return { ok: true, value: parsed };
        }
        catch {
            return { ok: false, status: 400, error: "invalid JSON body" };
        }
    }
    async handleApprove(req, res) {
        const body = await this.readJsonBody(req);
        if (!body.ok) {
            this.writeJson(res, body.status, { error: body.error });
            return;
        }
        const id = body.value.id;
        if (typeof id !== "string") {
            this.writeJson(res, 400, { error: "id is required" });
            return;
        }
        // Exactly one of confirmed, value, or cancelled must be present.
        const confirmed = body.value.confirmed;
        const value = body.value.value;
        const cancelled = body.value.cancelled;
        try {
            if (cancelled === true) {
                this.client.respondToUiRequest(id, { cancelled: true });
            }
            else if (typeof confirmed === "boolean") {
                this.client.respondToUiRequest(id, { confirmed });
            }
            else if (typeof value === "string") {
                this.client.respondToUiRequest(id, { value });
            }
            else {
                this.writeJson(res, 400, { error: "one of confirmed, value, or cancelled is required" });
                return;
            }
            this.writeJson(res, 200, { ok: true });
        }
        catch (err) {
            this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }
    /**
     * Abort the current turn mid-stream. The abort RPC command emits agent_end,
     * which drains any active SSE streams so they close cleanly. There is no
     * dedicated stream for the abort itself: the outcome is observed on the
     * existing stream bound to the active turn.
     */
    async handleAbort(res) {
        try {
            await this.client.abort();
            this.writeJson(res, 200, { ok: true });
        }
        catch (err) {
            this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }
    /**
     * Return the full transcript of the current Pi session. Used to repopulate
     * the chat view after a browser reconnect so the steward sees prior context.
     */
    async handleMessages(res) {
        try {
            const result = await this.client.getMessages();
            this.writeJson(res, 200, result);
        }
        catch (err) {
            this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }
    /**
     * Resume a past Pi session by its on-disk path. On a successful resume,
     * subsequent prompts and events belong to the resumed session. The response
     * carries `cancelled` so the frontend can fall back gracefully when Pi could
     * not resume the requested session.
     */
    async handleResume(req, res) {
        const body = await this.readJsonBody(req);
        if (!body.ok) {
            this.writeJson(res, body.status, { error: body.error });
            return;
        }
        const sessionPath = body.value.sessionPath;
        if (typeof sessionPath !== "string" || sessionPath.trim() === "") {
            this.writeJson(res, 400, { error: "sessionPath is required" });
            return;
        }
        try {
            const result = await this.client.switchSession(sessionPath);
            this.writeJson(res, 200, result);
        }
        catch (err) {
            this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }
    /**
     * List vault session summaries under team/<currentAgent>/sessions/. These are
     * the agent's past conversations as recorded by session_write_summary. The
     * list is newest-first. Requires both vaultRoot and a current agent.
     */
    async handleSessions(res) {
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
        }
        catch (err) {
            this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }
    async handleAgents(res) {
        this.writeJson(res, 200, { agents: this.runnableAgents, current: this.currentAgent });
    }
    async handleSwitch(req, res) {
        if (!this.targetBuilder) {
            this.writeJson(res, 403, { error: "agent switching is not configured on this installation" });
            return;
        }
        const body = await this.readJsonBody(req);
        if (!body.ok) {
            this.writeJson(res, body.status, { error: body.error });
            return;
        }
        const agent = body.value.agent;
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
        }
        catch (err) {
            this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }
    async handleVaultList(res, url) {
        if (!this.vaultRoot) {
            this.writeJson(res, 404, { error: "vault browser not configured" });
            return;
        }
        const path = url.searchParams.get("path") || ".";
        try {
            const result = await vaultBrowserList(this.vaultRoot, path);
            this.writeJson(res, 200, result);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.startsWith("Path resolves outside vault")) {
                this.writeJson(res, 403, { error: msg });
            }
            else if (msg.startsWith("ENOENT") || msg.includes("ENOENT")) {
                this.writeJson(res, 404, { error: "path not found" });
            }
            else {
                this.writeJson(res, 400, { error: msg });
            }
        }
    }
    async handleVaultRead(res, url) {
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
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.startsWith("Path resolves outside vault")) {
                this.writeJson(res, 403, { error: msg });
            }
            else if (msg.startsWith("ENOENT") || msg.includes("ENOENT")) {
                this.writeJson(res, 404, { error: "path not found" });
            }
            else {
                this.writeJson(res, 400, { error: msg });
            }
        }
    }
    /**
     * Create an inbox task for an agent from the web UI. This is a steward
     * affordance: drop a one-file-per-task Markdown file into the target
     * agent's inbox without invoking the agent. The `from` is always
     * "steward" because the web UI has no agent identity of its own.
     * Configured vaultRoot is required, otherwise 403 (no write surface).
     */
    async handleVaultInbox(req, res) {
        if (!this.vaultRoot) {
            this.writeJson(res, 403, { error: "vault write surface not configured" });
            return;
        }
        const parsed = await this.readJsonBody(req);
        if (!parsed.ok) {
            this.writeJson(res, parsed.status, { error: parsed.error });
            return;
        }
        const to = parsed.value.to;
        const title = parsed.value.title;
        if (typeof to !== "string" || to.trim() === "") {
            this.writeJson(res, 400, { error: "to (agent name) is required" });
            return;
        }
        if (typeof title !== "string" || title.trim() === "") {
            this.writeJson(res, 400, { error: "title is required" });
            return;
        }
        const body = typeof parsed.value.body === "string" ? parsed.value.body : "";
        try {
            const result = await createInboxTask({
                vaultRoot: this.vaultRoot,
                from: "steward",
                to: to.trim(),
                title: title.trim(),
                body,
            });
            this.writeJson(res, 200, {
                taskId: result.taskId,
                path: result.path,
                from: result.from,
                to: result.to,
                status: result.status,
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.startsWith("Invalid agent name")) {
                this.writeJson(res, 400, { error: msg });
            }
            else if (msg.startsWith("Target agent not found")) {
                this.writeJson(res, 404, { error: msg });
            }
            else {
                this.writeJson(res, 400, { error: msg });
            }
        }
    }
    writeJson(res, status, payload) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
    }
    writeSse(res, event) {
        res.write(`event: ${event.type}\n`);
        res.write(`data: ${JSON.stringify(event.data)}\n\n`);
    }
}
//# sourceMappingURL=gateway-http.js.map