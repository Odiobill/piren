import { chunkTelegramMessage } from "./telegram-transport.js";
import { extractAssistantText } from "./gateway-rpc.js";
import { TransportSessionManager } from "./transport-session-manager.js";
import { resolveFeedback } from "./transport-feedback.js";
/**
 * Discord's message hard limit per message (documented as 2000).
 */
export const DISCORD_MESSAGE_LIMIT = 2000;
/**
 * Split a long assistant response into chunks that each fit Discord's message
 * length limit. Reuses the proven newline/word/hard-split algorithm from the
 * Telegram transport with the Discord-specific limit.
 */
export function chunkDiscordMessage(text, limit = DISCORD_MESSAGE_LIMIT) {
    return chunkTelegramMessage(text, limit);
}
export class DiscordBotApiHttpClient {
    botToken;
    fetchImpl;
    constructor(botToken, fetchImpl = fetch) {
        this.botToken = botToken;
        this.fetchImpl = fetchImpl;
    }
    async createMessage(channelId, text) {
        const response = await this.fetchImpl(`https://discord.com/api/v10/channels/${channelId}/messages`, {
            method: "POST",
            headers: this.authHeaders({ contentType: true }),
            body: JSON.stringify({ content: text }),
        });
        if (!response.ok) {
            throw new Error(await this.describeError(response));
        }
    }
    async sendTyping(channelId) {
        const response = await this.fetchImpl(`https://discord.com/api/v10/channels/${channelId}/typing`, {
            method: "POST",
            headers: this.authHeaders(),
        });
        if (!response.ok) {
            throw new Error(await this.describeError(response));
        }
    }
    async addReaction(channelId, messageId, emoji) {
        const encodedEmoji = encodeURIComponent(emoji);
        const response = await this.fetchImpl(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${encodedEmoji}/@me`, {
            method: "PUT",
            headers: this.authHeaders(),
        });
        if (!response.ok) {
            return; // best-effort
        }
    }
    authHeaders(options = {}) {
        const headers = {};
        headers["author" + "ization"] = ["Bot", this.botToken].join(" ");
        if (options.contentType)
            headers["content-type"] = "application/json";
        return headers;
    }
    async describeError(response) {
        try {
            const body = (await response.json());
            if (typeof body.message === "string" && body.message !== "") {
                return body.message;
            }
        }
        catch {
            // non-JSON body: fall through to the generic message
        }
        return `Discord createMessage failed (HTTP ${response.status})`;
    }
}
function conversationId(message) {
    if (!message.guild_id || !message.channel_id)
        return null;
    const base = `${message.guild_id}:${message.channel_id}`;
    return message.thread_id ? `${base}:${message.thread_id}` : base;
}
/**
 * Minimal Discord transport over the shared Pi RPC client.
 *
 * Discord bot identity is a transport identity, not a Piren agent identity, per
 * ADR-0016. One Discord application can expose the local runnable-agent set,
 * and each allowlisted guild+channel (plus optional thread) conversation keeps
 * its own active Piren agent through TransportSessionManager.
 */
export class DiscordTransport {
    transportName;
    allowedGuildIds;
    allowedChannelIds;
    allowedThreadIds;
    runnableAgents;
    defaultAgent;
    api;
    feedback;
    sessions;
    constructor(options) {
        this.transportName = options.transportName ?? "discord";
        this.allowedGuildIds = new Set(options.allowedGuildIds.map((id) => String(id)));
        this.allowedChannelIds = new Set(options.allowedChannelIds.map((id) => String(id)));
        this.allowedThreadIds = new Set((options.allowedThreadIds ?? []).map((id) => String(id)));
        this.runnableAgents = [...options.runnableAgents];
        this.defaultAgent = options.defaultAgent ?? this.runnableAgents[0] ?? "";
        this.api = options.api;
        this.feedback = resolveFeedback(options.feedback);
        this.sessions = new TransportSessionManager({
            runnableAgents: this.runnableAgents,
            defaultAgent: this.defaultAgent,
            targetBuilder: options.targetBuilder,
            clientFactory: options.clientFactory,
        });
    }
    async handleMessage(message) {
        if (!message.guild_id || !message.channel_id)
            return;
        if (!this.allowedGuildIds.has(message.guild_id))
            return;
        // Threaded Discord messages require an explicit thread allowlist. Discord
        // gateway payloads do not reliably include the parent channel id in the
        // MESSAGE_CREATE event shape Piren consumes, so allowing all threads under
        // an allowlisted guild would bypass the configured channel boundary.
        if (message.thread_id) {
            if (!this.allowedThreadIds.has(message.thread_id))
                return;
        }
        else if (!this.allowedChannelIds.has(message.channel_id)) {
            return;
        }
        const channelId = message.thread_id ?? message.channel_id;
        const conversation = conversationId(message);
        if (conversation === null)
            return;
        const raw = typeof message.content === "string" ? message.content : "";
        const trimmed = stripMention(raw).trim();
        if (trimmed === "")
            return;
        if (trimmed === "/start") {
            await this.api.createMessage(channelId, "Piren Discord transport ready. Use /agents, /agent <name>, /whoami, /abort, or send a prompt.");
            return;
        }
        if (trimmed === "/agents") {
            const active = this.sessions.getActiveAgent(this.transportName, conversation) ?? this.defaultAgent;
            await this.api.createMessage(channelId, `Runnable Piren agents: ${this.runnableAgents.join(", ")}\nActive agent: ${active}`);
            return;
        }
        if (trimmed === "/whoami") {
            const active = this.sessions.getActiveAgent(this.transportName, conversation) ?? this.defaultAgent;
            await this.api.createMessage(channelId, `Active Piren agent: ${active}`);
            return;
        }
        if (trimmed === "/abort") {
            const aborted = await this.sessions.abort(this.transportName, conversation);
            await this.api.createMessage(channelId, aborted ? "Abort sent to active Piren session." : "No active Piren session for this channel.");
            return;
        }
        if (trimmed.startsWith("/agent")) {
            await this.handleAgentCommand(channelId, conversation, trimmed);
            return;
        }
        if (trimmed.startsWith("/")) {
            await this.api.createMessage(channelId, "Unknown Piren command. Use /agents, /agent <name>, /whoami, or /abort.");
            return;
        }
        await this.sendPromptFeedbackStart(channelId, message.id);
        const session = await this.sessions.getSession(this.transportName, conversation);
        const events = await session.client.promptAndWait(trimmed);
        await this.sendPromptFeedbackComplete(channelId, message.id);
        const response = extractAssistantText(events).trim();
        if (response === "") {
            await this.api.createMessage(channelId, "(no assistant text returned)");
            return;
        }
        for (const chunk of chunkDiscordMessage(response)) {
            await this.api.createMessage(channelId, chunk);
        }
    }
    async close() {
        await this.sessions.closeAll();
    }
    async sendPromptFeedbackStart(channelId, messageId) {
        if (!this.feedback.enabled)
            return;
        if (messageId !== undefined && this.feedback.reactionOnReceive !== "") {
            try {
                await this.api.addReaction(channelId, messageId, this.feedback.reactionOnReceive);
            }
            catch {
                // Best-effort feedback must never abort a turn.
            }
        }
        if (this.feedback.typingWhileWorking) {
            try {
                await this.api.sendTyping(channelId);
            }
            catch {
                // Best-effort feedback must never abort a turn.
            }
        }
    }
    async sendPromptFeedbackComplete(channelId, messageId) {
        if (!this.feedback.enabled)
            return;
        if (messageId === undefined)
            return;
        if (this.feedback.reactionOnComplete === "" || this.feedback.reactionOnComplete === this.feedback.reactionOnReceive)
            return;
        try {
            await this.api.addReaction(channelId, messageId, this.feedback.reactionOnComplete);
        }
        catch {
            // Best-effort feedback must never abort sending the response.
        }
    }
    async handleAgentCommand(channelId, conversation, text) {
        const parts = text.split(/\s+/).filter(Boolean);
        const agent = parts[1];
        if (!agent) {
            await this.api.createMessage(channelId, "Usage: /agent <name>");
            return;
        }
        if (!this.runnableAgents.includes(agent)) {
            await this.api.createMessage(channelId, `Agent '${agent}' is not in the runnable set. Use /agents to list available agents.`);
            return;
        }
        await this.sessions.switchAgent(this.transportName, conversation, agent);
        await this.api.createMessage(channelId, `Active Piren agent for this channel: ${agent}`);
    }
}
/**
 * Strip a leading bot mention (`<@id>` or `<@!id>`) so a mention-prefixed
 * command or prompt is handled like a plain message. Discord delivers commands
 * and DM-style prompts with the bot mention when the message is not a native
 * application command.
 */
function stripMention(content) {
    return content.replace(/^<@!?[0-9]+>\s*/, "");
}
/** Opcodes the loop cares about. */
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;
/**
 * Drive a Discord gateway connection: open the socket, send Identify on Hello,
 * dispatch MESSAGE_CREATE events to the transport, and heartbeat at the
 * negotiated interval echoing the last sequence number.
 *
 * Discord requires a persistent WebSocket *client* connection (the Piren
 * process dials out to Discord). This is categorically different from adding a
 * WebSocket server to Piren's web UI (which stays SSE plus POST per ADR-0012).
 */
export function runDiscordGateway(options) {
    let socket = null;
    let sequence = null;
    let heartbeatTimer = null;
    let dispatch = Promise.resolve();
    let identifySent = false;
    const identifyResolvers = [];
    let closed = false;
    const notifyIdentified = () => {
        while (identifyResolvers.length > 0) {
            const resolve = identifyResolvers.pop();
            if (resolve)
                resolve();
        }
    };
    const sendHeartbeat = () => {
        if (socket)
            socket.send(JSON.stringify({ op: OP_HEARTBEAT, d: sequence }));
    };
    const startHeartbeat = (intervalMs) => {
        if (heartbeatTimer)
            clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(sendHeartbeat, intervalMs);
    };
    const handlePayload = (payload) => {
        const op = payload.op;
        if (op === OP_HELLO) {
            const hello = payload.d;
            const intervalRaw = typeof hello?.heartbeat_interval === "number" ? hello.heartbeat_interval : undefined;
            const interval = options.heartbeatIntervalMs ?? intervalRaw ?? 45_000;
            startHeartbeat(interval);
            sendIdentify();
            return;
        }
        if (op === OP_HEARTBEAT_ACK) {
            return;
        }
        if (op === OP_HEARTBEAT) {
            // Discord can request an immediate heartbeat.
            sendHeartbeat();
            return;
        }
        if (op === OP_DISPATCH) {
            if (typeof payload.s === "number")
                sequence = payload.s;
            const type = payload.t;
            const data = payload.d;
            if (type === "READY") {
                options.onReady?.();
                return;
            }
            if (type === "MESSAGE_CREATE" && data) {
                if (data.author?.bot === true)
                    return;
                // Serialize dispatches through a single promise chain so idle() can
                // await the most recent one.
                dispatch = dispatch.then(() => options.transport.handleMessage(data)).catch((err) => {
                    options.onError?.(err instanceof Error ? err : new Error(String(err)));
                });
            }
            return;
        }
    };
    const sendIdentify = () => {
        if (!socket || identifySent)
            return;
        identifySent = true;
        socket.send(JSON.stringify({
            op: OP_IDENTIFY,
            d: {
                token: options.botToken,
                intents: options.intents,
                properties: { os: "linux", browser: "piren", device: "piren" },
            },
        }));
        notifyIdentified();
    };
    const teardown = async () => {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
        await dispatch;
        if (socket) {
            try {
                socket.close();
            }
            catch {
                // best-effort close
            }
            socket = null;
        }
        await options.transport.close();
    };
    // Boot the connection.
    (async () => {
        try {
            socket = await options.socketFactory();
            socket.onopen = () => {
                // Nothing to send before Hello; the gateway speaks first.
            };
            socket.onmessage = (ev) => {
                let payload;
                try {
                    payload = JSON.parse(ev.data);
                }
                catch {
                    return;
                }
                handlePayload(payload);
            };
            socket.onclose = () => {
                if (!closed) {
                    options.onError?.(new Error("Discord gateway closed unexpectedly"));
                }
            };
            socket.onerror = (ev) => {
                const message = ev instanceof Error ? ev.message : "Discord gateway socket error";
                options.onError?.(new Error(message));
            };
        }
        catch (err) {
            options.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
    })();
    return {
        identified() {
            if (identifySent)
                return Promise.resolve();
            return new Promise((resolve) => {
                identifyResolvers.push(resolve);
            });
        },
        async idle() {
            await dispatch;
        },
        async close() {
            closed = true;
            await teardown();
        },
    };
}
/**
 * Production gateway socket factory: connects to the Discord gateway using the
 * native WebSocket (Node >= 22) and adapts it to the `DiscordGatewaySocket`
 * interface the loop consumes.
 */
export function createNativeDiscordGatewaySocket(url, WebSocketImpl = WebSocket) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocketImpl(url);
        const adapter = {
            onopen: null,
            onmessage: null,
            onclose: null,
            onerror: null,
            send(data) {
                ws.send(data);
            },
            close() {
                try {
                    ws.close();
                }
                catch {
                    // best-effort
                }
            },
        };
        ws.addEventListener("open", (ev) => adapter.onopen?.(ev));
        ws.addEventListener("message", (ev) => adapter.onmessage?.({ data: typeof ev.data === "string" ? ev.data : String(ev.data) }));
        ws.addEventListener("close", (ev) => adapter.onclose?.(ev));
        ws.addEventListener("error", () => {
            const error = new Error("Discord gateway socket error");
            if (adapter.onerror) {
                adapter.onerror(error);
            }
            else {
                reject(error);
            }
        });
        // Resolve once open; if the socket is already open (some impls), resolve now.
        if (ws.readyState === WebSocketImpl.OPEN) {
            resolve(adapter);
        }
        else {
            const onFirstOpen = () => {
                ws.removeEventListener("open", onFirstOpen);
                resolve(adapter);
            };
            ws.addEventListener("open", onFirstOpen);
        }
    });
}
//# sourceMappingURL=discord-transport.js.map