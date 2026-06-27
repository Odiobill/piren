import { extractAssistantText, type RpcEvent, type RpcSpawnTarget } from "./gateway-rpc.js";
import { TransportSessionManager, type TransportRpcClient } from "./transport-session-manager.js";
import type { RpcTargetBuilder } from "./gateway-http.js";
import { resolveFeedback, type TransportFeedback, type TransportFeedbackConfig } from "./transport-feedback.js";

export interface TelegramMessage {
  message_id?: number;
  chat?: { id?: number | string };
  text?: string;
}

export interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
}

export interface TelegramBotApi {
  sendMessage(chatId: number | string, text: string): Promise<void>;
  /** Best-effort typing indicator. Telegram's chat action expires after ~5s. */
  sendChatAction(chatId: number | string, action: string): Promise<void>;
  /**
   * Best-effort emoji reaction on a message. Must not throw on failure:
   * reactions are advisory feedback and must never abort a turn.
   */
  setMessageReaction(chatId: number | string, messageId: number, emoji: string): Promise<void>;
}

export interface TelegramPollingApi extends TelegramBotApi {
  getUpdates(offset: number | undefined, timeoutSeconds: number): Promise<TelegramUpdate[]>;
}

export class TelegramBotApiHttpClient implements TelegramPollingApi {
  constructor(private readonly botToken: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async sendMessage(chatId: number | string, text: string): Promise<void> {
    const response = await this.fetchJson("sendMessage", {
      chat_id: chatId,
      text,
    });
    if (!response.ok) {
      throw new Error(response.description || "Telegram sendMessage failed");
    }
  }

  async sendChatAction(chatId: number | string, action: string): Promise<void> {
    const response = await this.fetchJson("sendChatAction", {
      chat_id: chatId,
      action,
    });
    if (!response.ok) {
      throw new Error(response.description || "Telegram sendChatAction failed");
    }
  }

  /**
   * Best-effort: a failed reaction (permissions, emoji not allowed, etc.)
   * resolves silently rather than rejecting. Feedback must never abort a turn.
   */
  async setMessageReaction(chatId: number | string, messageId: number, emoji: string): Promise<void> {
    const response = await this.fetchJson("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji }],
    });
    if (!response.ok) {
      return; // best-effort
    }
  }

  async getUpdates(offset: number | undefined, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    const body: Record<string, unknown> = { timeout: timeoutSeconds };
    if (offset !== undefined) body.offset = offset;
    const response = await this.fetchJson("getUpdates", body);
    if (!response.ok) {
      throw new Error(response.description || "Telegram getUpdates failed");
    }
    return Array.isArray(response.result) ? (response.result as TelegramUpdate[]) : [];
  }

  private async fetchJson(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; description?: string }> {
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await response.json()) as { ok: boolean; result?: unknown; description?: string };
  }
}

export interface TelegramPromptClient extends TransportRpcClient {
  promptAndWait(message: string): Promise<RpcEvent[]>;
}

export interface TelegramTransportOptions<TClient extends TelegramPromptClient> {
  transportName?: string | undefined;
  allowedChatIds: Array<number | string>;
  runnableAgents: string[];
  defaultAgent?: string | undefined;
  targetBuilder: RpcTargetBuilder;
  clientFactory: (target: RpcSpawnTarget) => TClient;
  api: TelegramBotApi;
  feedback?: TransportFeedbackConfig | undefined;
}

/**
 * Minimal Telegram transport over the shared Pi RPC client.
 *
 * Telegram bot identity is a transport identity, not a Piren agent identity:
 * one bot can expose the local runnable-agent set and each allowlisted chat
 * keeps its own active Piren agent through TransportSessionManager.
 */
export class TelegramTransport<TClient extends TelegramPromptClient> {
  private readonly transportName: string;
  private readonly allowedChatIds: Set<string>;
  private readonly runnableAgents: string[];
  private readonly defaultAgent: string;
  private readonly api: TelegramBotApi;
  private readonly feedback: TransportFeedback;
  private readonly sessions: TransportSessionManager<TClient>;

  constructor(options: TelegramTransportOptions<TClient>) {
    this.transportName = options.transportName ?? "telegram";
    this.allowedChatIds = new Set(options.allowedChatIds.map((id) => String(id)));
    this.runnableAgents = [...options.runnableAgents];
    this.defaultAgent = options.defaultAgent ?? this.runnableAgents[0] ?? "";
    this.api = options.api;
    this.feedback = resolveFeedback(options.feedback);
    this.sessions = new TransportSessionManager<TClient>({
      runnableAgents: this.runnableAgents,
      defaultAgent: this.defaultAgent,
      targetBuilder: options.targetBuilder,
      clientFactory: options.clientFactory,
    });
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const chatId = update.message?.chat?.id;
    const text = update.message?.text;
    if (chatId === undefined || typeof text !== "string" || text.trim() === "") return;
    if (!this.allowedChatIds.has(String(chatId))) return;

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

    const messageId = update.message?.message_id;
    await this.sendPromptFeedbackStart(chatId, messageId);
    const session = await this.sessions.getSession(this.transportName, String(chatId));
    const events = await session.client.promptAndWait(trimmed);
    await this.sendPromptFeedbackComplete(chatId, messageId);
    const response = extractAssistantText(events).trim();
    if (response === "") {
      await this.api.sendMessage(chatId, "(no assistant text returned)");
      return;
    }
    for (const chunk of chunkTelegramMessage(response)) {
      await this.api.sendMessage(chatId, chunk);
    }
  }

  async close(): Promise<void> {
    await this.sessions.closeAll();
  }

  private async sendPromptFeedbackStart(chatId: number | string, messageId: number | undefined): Promise<void> {
    if (!this.feedback.enabled) return;
    if (messageId !== undefined && this.feedback.reactionOnReceive !== "") {
      try {
        await this.api.setMessageReaction(chatId, messageId, this.feedback.reactionOnReceive);
      } catch {
        // Best-effort feedback must never abort a turn.
      }
    }
    if (this.feedback.typingWhileWorking) {
      try {
        await this.api.sendChatAction(chatId, "typing");
      } catch {
        // Best-effort feedback must never abort a turn.
      }
    }
  }

  private async sendPromptFeedbackComplete(chatId: number | string, messageId: number | undefined): Promise<void> {
    if (!this.feedback.enabled) return;
    if (messageId === undefined) return;
    if (this.feedback.reactionOnComplete === "" || this.feedback.reactionOnComplete === this.feedback.reactionOnReceive) return;
    try {
      await this.api.setMessageReaction(chatId, messageId, this.feedback.reactionOnComplete);
    } catch {
      // Best-effort feedback must never abort sending the response.
    }
  }

  private async handleAgentCommand(chatId: number | string, text: string): Promise<void> {
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
export function chunkTelegramMessage(text: string, limit: number = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (text === "") return [];
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + limit, text.length);
    if (end < text.length) {
      // Prefer to break after the last newline within the window.
      const newline = text.lastIndexOf("\n", end);
      if (newline > i) {
        end = newline + 1;
      } else {
        // Otherwise break after the last space within the window.
        const space = text.lastIndexOf(" ", end);
        if (space > i) end = space + 1;
        // No boundary found: hard-break at the limit.
      }
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

export interface RunTelegramPollingOptions<TClient extends TelegramPromptClient> {
  api: TelegramPollingApi;
  transport: TelegramTransport<TClient>;
  timeoutSeconds?: number | undefined;
  signal?: AbortSignal | undefined;
  onError?: ((error: Error) => void) | undefined;
}

export async function runTelegramPolling<TClient extends TelegramPromptClient>(
  options: RunTelegramPollingOptions<TClient>,
): Promise<void> {
  let offset: number | undefined;
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
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (options.onError) {
        options.onError(error);
      } else {
        throw error;
      }
    }
  }
  await options.transport.close();
}
