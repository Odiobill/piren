import { extractAssistantText } from "./gateway-rpc.js";
import { TransportSessionManager } from "./transport-session-manager.js";
export class TelegramBotApiHttpClient {
    botToken;
    fetchImpl;
    constructor(botToken, fetchImpl = fetch) {
        this.botToken = botToken;
        this.fetchImpl = fetchImpl;
    }
    async sendMessage(chatId, text) {
        const response = await this.fetchJson("sendMessage", {
            chat_id: chatId,
            text,
        });
        if (!response.ok) {
            throw new Error(response.description || "Telegram sendMessage failed");
        }
    }
    async getUpdates(offset, timeoutSeconds) {
        const body = { timeout: timeoutSeconds };
        if (offset !== undefined)
            body.offset = offset;
        const response = await this.fetchJson("getUpdates", body);
        if (!response.ok) {
            throw new Error(response.description || "Telegram getUpdates failed");
        }
        return Array.isArray(response.result) ? response.result : [];
    }
    async fetchJson(method, body) {
        const response = await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/${method}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        return (await response.json());
    }
}
/**
 * Minimal Telegram transport over the shared Pi RPC client.
 *
 * Telegram bot identity is a transport identity, not a Piren agent identity:
 * one bot can expose the local runnable-agent set and each allowlisted chat
 * keeps its own active Piren agent through TransportSessionManager.
 */
export class TelegramTransport {
    transportName;
    allowedChatIds;
    runnableAgents;
    defaultAgent;
    api;
    sessions;
    constructor(options) {
        this.transportName = options.transportName ?? "telegram";
        this.allowedChatIds = new Set(options.allowedChatIds.map((id) => String(id)));
        this.runnableAgents = [...options.runnableAgents];
        this.defaultAgent = options.defaultAgent ?? this.runnableAgents[0] ?? "";
        this.api = options.api;
        this.sessions = new TransportSessionManager({
            runnableAgents: this.runnableAgents,
            defaultAgent: this.defaultAgent,
            targetBuilder: options.targetBuilder,
            clientFactory: options.clientFactory,
        });
    }
    async handleUpdate(update) {
        const chatId = update.message?.chat?.id;
        const text = update.message?.text;
        if (chatId === undefined || typeof text !== "string" || text.trim() === "")
            return;
        if (!this.allowedChatIds.has(String(chatId)))
            return;
        const trimmed = text.trim();
        if (trimmed === "/start") {
            await this.api.sendMessage(chatId, "Piren Telegram transport ready. Use /agents, /agent <name>, /whoami, /abort, or send a prompt.");
            return;
        }
        if (trimmed === "/agents") {
            const active = this.sessions.getActiveAgent(this.transportName, String(chatId)) ?? this.defaultAgent;
            await this.api.sendMessage(chatId, `Runnable Piren agents: ${this.runnableAgents.join(", ")}\nActive agent: ${active}`);
            return;
        }
        if (trimmed === "/whoami") {
            const active = this.sessions.getActiveAgent(this.transportName, String(chatId)) ?? this.defaultAgent;
            await this.api.sendMessage(chatId, `Active Piren agent: ${active}`);
            return;
        }
        if (trimmed === "/abort") {
            const aborted = await this.sessions.abort(this.transportName, String(chatId));
            await this.api.sendMessage(chatId, aborted ? "Abort sent to active Piren session." : "No active Piren session for this chat.");
            return;
        }
        if (trimmed.startsWith("/agent")) {
            await this.handleAgentCommand(chatId, trimmed);
            return;
        }
        if (trimmed.startsWith("/")) {
            await this.api.sendMessage(chatId, "Unknown Piren command. Use /agents, /agent <name>, /whoami, or /abort.");
            return;
        }
        const session = await this.sessions.getSession(this.transportName, String(chatId));
        const events = await session.client.promptAndWait(trimmed);
        const response = extractAssistantText(events).trim();
        if (response === "") {
            await this.api.sendMessage(chatId, "(no assistant text returned)");
            return;
        }
        for (const chunk of chunkTelegramMessage(response)) {
            await this.api.sendMessage(chatId, chunk);
        }
    }
    async close() {
        await this.sessions.closeAll();
    }
    async handleAgentCommand(chatId, text) {
        const parts = text.split(/\s+/).filter(Boolean);
        const agent = parts[1];
        if (!agent) {
            await this.api.sendMessage(chatId, "Usage: /agent <name>");
            return;
        }
        if (!this.runnableAgents.includes(agent)) {
            await this.api.sendMessage(chatId, `Agent '${agent}' is not in the runnable set. Use /agents to list available agents.`);
            return;
        }
        await this.sessions.switchAgent(this.transportName, String(chatId), agent);
        await this.api.sendMessage(chatId, `Active Piren agent for this chat: ${agent}`);
    }
}
/**
 * Telegram's sendMessage hard limit per message.
 *
 * Kept below the documented 4096 to leave headroom for the chat-side rendering
 * and any metadata a client may prepend.
 */
export const TELEGRAM_MESSAGE_LIMIT = 4000;
/**
 * Split a long assistant response into chunks that each fit Telegram's
 * sendMessage length limit.
 *
 * Splits on newline boundaries first so paragraphs stay intact, then on word
 * boundaries within a long paragraph, and finally hard-splits a single run of
 * characters that has no boundary. Returns an empty array for empty input so
 * callers can skip sending.
 */
export function chunkTelegramMessage(text, limit = TELEGRAM_MESSAGE_LIMIT) {
    if (text === "")
        return [];
    if (text.length <= limit)
        return [text];
    const chunks = [];
    let i = 0;
    while (i < text.length) {
        let end = Math.min(i + limit, text.length);
        if (end < text.length) {
            // Prefer to break after the last newline within the window.
            const newline = text.lastIndexOf("\n", end);
            if (newline > i) {
                end = newline + 1;
            }
            else {
                // Otherwise break after the last space within the window.
                const space = text.lastIndexOf(" ", end);
                if (space > i)
                    end = space + 1;
                // No boundary found: hard-break at the limit.
            }
        }
        chunks.push(text.slice(i, end));
        i = end;
    }
    return chunks;
}
export async function runTelegramPolling(options) {
    let offset;
    const timeoutSeconds = options.timeoutSeconds ?? 30;
    while (!options.signal?.aborted) {
        try {
            const updates = await options.api.getUpdates(offset, timeoutSeconds);
            for (const update of updates) {
                if (typeof update.update_id === "number") {
                    offset = update.update_id + 1;
                }
                await options.transport.handleUpdate(update);
            }
        }
        catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            if (options.onError) {
                options.onError(error);
            }
            else {
                throw error;
            }
        }
    }
    await options.transport.close();
}
//# sourceMappingURL=telegram-transport.js.map