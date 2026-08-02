import { chunkTelegramMessage } from "./telegram-transport.js";
import { extractAssistantText, type RpcEvent, type RpcSpawnTarget } from "./gateway-rpc.js";
import { TransportSessionManager, type TransportRpcClient } from "./transport-session-manager.js";
import type { RpcTargetBuilder } from "./gateway-http.js";
import { resolveFeedback, type TransportFeedback, type TransportFeedbackConfig } from "./transport-feedback.js";
import {
  DISCORD_INTERACTION_CALLBACK_CHANNEL_MESSAGE,
  parseInteractionCommand,
  type DiscordCommandSpec,
  type DiscordInteractionPayload,
  type RegisteredCommandRef,
} from "./discord-commands.js";

/**
 * Discord's message hard limit per message (documented as 2000).
 */
export const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * Split a long assistant response into chunks that each fit Discord's message
 * length limit. Reuses the proven newline/word/hard-split algorithm from the
 * Telegram transport with the Discord-specific limit.
 */
export function chunkDiscordMessage(text: string, limit: number = DISCORD_MESSAGE_LIMIT): string[] {
  return chunkTelegramMessage(text, limit);
}

export interface DiscordMessage {
  id?: string;
  guild_id?: string;
  channel_id?: string;
  thread_id?: string;
  content?: string;
  /** Sender identity from the gateway payload. Never inferred from channel/guild IDs. */
  author?: { id?: string; bot?: boolean };
}

/** Discord channel type for a one-to-one direct message. Group DMs are type 3. */
export const DISCORD_CHANNEL_TYPE_DM = 1;

/**
 * Gateway intent mask declared at Identify: GUILDS (1 << 0) |
 * GUILD_MESSAGES (1 << 9) | DIRECT_MESSAGES (1 << 12) |
 * MESSAGE_CONTENT (1 << 15) = 37377. DIRECT_MESSAGES is required for the
 * gateway to dispatch the DM MESSAGE_CREATE events ADR-0040 D1 authorizes;
 * it is not a privileged intent and needs no Developer Portal toggle.
 */
export const DISCORD_GATEWAY_INTENTS = 37377;

/** Channel metadata used only for fail-closed DM authorization (ADR-0040 D1). */
export interface DiscordChannelMetadata {
  id?: string;
  type?: number;
}

export interface DiscordBotApi {
  createMessage(channelId: string, text: string): Promise<void>;
  /** Best-effort typing indicator. Discord typing expires after ~10s. */
  sendTyping(channelId: string): Promise<void>;
  /** Best-effort emoji reaction on a message. Must not throw on failure. */
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  /**
   * Channel metadata lookup. The gateway MESSAGE_CREATE payload has no
   * authoritative channel-type discriminator, so DM authorization verifies
   * the channel type through this lookup (only Discord type 1 is accepted).
   * Called ONLY for non-guild messages whose sender is already in the DM
   * allowlist; never for guild traffic.
   */
  getChannel(channelId: string): Promise<DiscordChannelMetadata>;
  /**
   * Respond to an application-command interaction through Discord's
   * interaction callback mechanism. The interaction token authenticates the
   * callback via the URL — no Bot authorization header — and must never be
   * logged or included in errors.
   */
  respondToInteraction(interactionId: string, interactionToken: string, content: string): Promise<void>;
}

export class DiscordBotApiHttpClient implements DiscordBotApi {
  constructor(private readonly botToken: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async createMessage(channelId: string, text: string): Promise<void> {
    const response = await this.fetchImpl(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: this.authHeaders({ contentType: true }),
      body: JSON.stringify({ content: text }),
    });
    if (!response.ok) {
      throw new Error(await this.describeError(response));
    }
  }

  async sendTyping(channelId: string): Promise<void> {
    const response = await this.fetchImpl(`https://discord.com/api/v10/channels/${channelId}/typing`, {
      method: "POST",
      headers: this.authHeaders(),
    });
    if (!response.ok) {
      throw new Error(await this.describeError(response));
    }
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const encodedEmoji = encodeURIComponent(emoji);
    const response = await this.fetchImpl(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${encodedEmoji}/@me`,
      {
        method: "PUT",
      headers: this.authHeaders(),
      },
    );
    if (!response.ok) {
      return; // best-effort
    }
  }

  async getChannel(channelId: string): Promise<DiscordChannelMetadata> {
    const response = await this.fetchImpl(`https://discord.com/api/v10/channels/${channelId}`, {
      headers: this.authHeaders(),
    });
    if (!response.ok) {
      throw new Error(await this.describeError(response));
    }
    return (await response.json()) as DiscordChannelMetadata;
  }

  async listApplicationCommands(applicationId: string): Promise<RegisteredCommandRef[]> {
    const response = await this.fetchImpl(`https://discord.com/api/v10/applications/${applicationId}/commands`, {
      headers: this.authHeaders(),
    });
    if (!response.ok) {
      throw new Error(await this.describeError(response));
    }
    return (await response.json()) as RegisteredCommandRef[];
  }

  async createApplicationCommand(applicationId: string, spec: DiscordCommandSpec): Promise<void> {
    const response = await this.fetchImpl(`https://discord.com/api/v10/applications/${applicationId}/commands`, {
      method: "POST",
      headers: this.authHeaders({ contentType: true }),
      body: JSON.stringify(spec),
    });
    if (!response.ok) {
      throw new Error(await this.describeError(response));
    }
  }

  async updateApplicationCommand(applicationId: string, commandId: string, spec: DiscordCommandSpec): Promise<void> {
    const response = await this.fetchImpl(`https://discord.com/api/v10/applications/${applicationId}/commands/${commandId}`, {
      method: "PATCH",
      headers: this.authHeaders({ contentType: true }),
      body: JSON.stringify(spec),
    });
    if (!response.ok) {
      throw new Error(await this.describeError(response));
    }
  }

  async respondToInteraction(interactionId: string, interactionToken: string, content: string): Promise<void> {
    // Interaction callbacks authenticate via the interaction token in the
    // URL — deliberately NO Bot authorization header.
    const response = await this.fetchImpl(`https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: DISCORD_INTERACTION_CALLBACK_CHANNEL_MESSAGE, data: { content } }),
    });
    if (!response.ok) {
      // Never include the URL or response body here: the URL carries the
      // interaction token.
      throw new Error(`Discord interaction callback failed (HTTP ${response.status})`);
    }
  }

  private authHeaders(options: { contentType?: boolean } = {}): Record<string, string> {
    const headers: Record<string, string> = {};
    headers["author" + "ization"] = ["Bot", this.botToken].join(" ");
    if (options.contentType) headers["content-type"] = "application/json";
    return headers;
  }

  private async describeError(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as { message?: unknown; code?: unknown };
      if (typeof body.message === "string" && body.message !== "") {
        return body.message;
      }
    } catch {
      // non-JSON body: fall through to the generic message
    }
    return `Discord createMessage failed (HTTP ${response.status})`;
  }
}

export interface DiscordPromptClient extends TransportRpcClient {
  promptAndWait(message: string): Promise<RpcEvent[]>;
}

export interface DiscordTransportOptions<TClient extends DiscordPromptClient> {
  transportName?: string | undefined;
  allowedGuildIds: Array<number | string>;
  allowedChannelIds: Array<number | string>;
  allowedThreadIds?: Array<number | string> | undefined;
  /**
   * Explicit one-to-one DM user allowlist (ADR-0040 D1). Omitted or empty
   * means every direct message is denied. Never widens guild, ordinary
   * channel, or thread access.
   */
  allowedDmUserIds?: Array<number | string> | undefined;
  runnableAgents: string[];
  defaultAgent?: string | undefined;
  targetBuilder: RpcTargetBuilder;
  clientFactory: (target: RpcSpawnTarget) => TClient;
  api: DiscordBotApi;
  feedback?: TransportFeedbackConfig | undefined;
}

function conversationId(message: DiscordMessage): string | null {
  if (!message.guild_id || !message.channel_id) return null;
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
export class DiscordTransport<TClient extends DiscordPromptClient> {
  private readonly transportName: string;
  private readonly allowedGuildIds: Set<string>;
  private readonly allowedChannelIds: Set<string>;
  private readonly allowedThreadIds: Set<string>;
  private readonly allowedDmUserIds: Set<string>;
  private readonly runnableAgents: string[];
  private readonly defaultAgent: string;
  private readonly api: DiscordBotApi;
  private readonly feedback: TransportFeedback;
  private readonly sessions: TransportSessionManager<TClient>;

  constructor(options: DiscordTransportOptions<TClient>) {
    this.transportName = options.transportName ?? "discord";
    this.allowedGuildIds = new Set(options.allowedGuildIds.map((id) => String(id)));
    this.allowedChannelIds = new Set(options.allowedChannelIds.map((id) => String(id)));
    this.allowedThreadIds = new Set((options.allowedThreadIds ?? []).map((id) => String(id)));
    this.allowedDmUserIds = new Set((options.allowedDmUserIds ?? []).map((id) => String(id)));
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

  async handleMessage(message: DiscordMessage): Promise<void> {
    // Defense-in-depth: the gateway loop already drops bot-authored events.
    if (message.author?.bot === true) return;
    if (!message.channel_id) return;

    let channelId: string;
    let conversation: string;

    if (message.guild_id !== undefined) {
      // Guild path. Only an actually absent guild field may enter the DM
      // path; a malformed empty-string guild_id fails the allowlist here and
      // is rejected before any metadata lookup, reply, or session.
      // `allowed_dm_user_ids` never widens guild, ordinary channel, or
      // thread access, and guild traffic never triggers the DM
      // channel-metadata lookup.
      if (!this.allowedGuildIds.has(message.guild_id)) return;
      // Threaded Discord messages require an explicit thread allowlist. Discord
      // gateway payloads do not reliably include the parent channel id in the
      // MESSAGE_CREATE event shape Piren consumes, so allowing all threads under
      // an allowlisted guild would bypass the configured channel boundary.
      if (message.thread_id) {
        // Legacy modeled shape: an explicit thread_id property.
        if (!this.allowedThreadIds.has(message.thread_id)) return;
      } else if (this.allowedThreadIds.has(message.channel_id)) {
        // Real Discord Gateway shape: a message sent inside a thread carries the
        // thread's own id in channel_id and has no thread_id property. An id in
        // allowed_thread_ids authorizes exactly that thread; it never widens
        // allowed_channel_ids because the two sets are checked independently.
      } else if (!this.allowedChannelIds.has(message.channel_id)) {
        return;
      }

      channelId = message.thread_id ?? message.channel_id;
      const guildConversation = conversationId(message);
      if (guildConversation === null) return;
      conversation = guildConversation;
    } else {
      // ADR-0040 D1: fail-closed one-to-one DM authorization. A non-guild
      // message carrying any thread_id field is an unknown direct shape and
      // is rejected before any identity work or lookup.
      if (message.thread_id !== undefined) return;
      // The sender identity comes only from author.id (never inferred from
      // channel/guild IDs), and the gateway payload has no authoritative
      // channel-type discriminator, so the channel type is verified through
      // an explicit metadata lookup AFTER the sender allowlist check. Group
      // DMs (type 3), every other/unknown type, metadata not bound to the
      // requested channel, lookup failures, and malformed responses are
      // rejected silently: no reply, no session, no error leakage.
      if (this.allowedDmUserIds.size === 0) return;
      const senderId = typeof message.author?.id === "string" ? message.author.id.trim() : "";
      if (senderId === "" || !this.allowedDmUserIds.has(senderId)) return;
      if (!(await this.isDirectMessageChannel(message.channel_id))) return;
      channelId = message.channel_id;
      // Collision-safe DM conversation key, distinct from every
      // guild/channel/thread key (which always contains a guild id prefix).
      conversation = `dm:${message.channel_id}`;
    }

    const raw = typeof message.content === "string" ? message.content : "";
    const trimmed = stripMention(raw).trim();
    if (trimmed === "") return;

    if (trimmed === "/start") {
      await this.api.createMessage(channelId, await this.executeCommand("start", undefined, conversation));
      return;
    }
    if (trimmed === "/agents") {
      await this.api.createMessage(channelId, await this.executeCommand("agents", undefined, conversation));
      return;
    }
    if (trimmed === "/whoami") {
      await this.api.createMessage(channelId, await this.executeCommand("whoami", undefined, conversation));
      return;
    }
    if (trimmed === "/abort") {
      await this.api.createMessage(channelId, await this.executeCommand("abort", undefined, conversation));
      return;
    }
    if (trimmed.startsWith("/agent")) {
      const parts = trimmed.split(/\s+/).filter(Boolean);
      await this.api.createMessage(channelId, await this.executeCommand("agent", parts[1], conversation));
      return;
    }
    if (trimmed === "/new") {
      await this.handleNewSessionCommand(channelId, conversation);
      return;
    }
    if (trimmed === "/compact") {
      await this.handleCompactCommand(channelId, conversation);
      return;
    }
    if (trimmed.startsWith("/")) {
      await this.api.createMessage(channelId, "Unknown Piren command. Use /agents, /agent <name>, /whoami, /abort, /new, or /compact.");
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

  async close(): Promise<void> {
    await this.sessions.closeAll();
  }

  /**
   * Verify through the Bot API that a channel is a one-to-one DM (Discord
   * channel type 1). Any failure — group DM (type 3), unknown type, lookup
   * error, malformed response — fails closed.
   */
  private async isDirectMessageChannel(channelId: string): Promise<boolean> {
    try {
      const metadata = await this.api.getChannel(channelId);
      // The metadata must be bound to the requested channel: a non-empty
      // string id exactly equal to channelId, and type exactly DM (1).
      if (typeof metadata?.id !== "string" || metadata.id === "" || metadata.id !== channelId) return false;
      return typeof metadata.type === "number" && metadata.type === DISCORD_CHANNEL_TYPE_DM;
    } catch {
      return false;
    }
  }

  private async sendPromptFeedbackStart(channelId: string, messageId: string | undefined): Promise<void> {
    if (!this.feedback.enabled) return;
    if (messageId !== undefined && this.feedback.reactionOnReceive !== "") {
      try {
        await this.api.addReaction(channelId, messageId, this.feedback.reactionOnReceive);
      } catch {
        // Best-effort feedback must never abort a turn.
      }
    }
    if (this.feedback.typingWhileWorking) {
      try {
        await this.api.sendTyping(channelId);
      } catch {
        // Best-effort feedback must never abort a turn.
      }
    }
  }

  private async sendPromptFeedbackComplete(channelId: string, messageId: string | undefined): Promise<void> {
    if (!this.feedback.enabled) return;
    if (messageId === undefined) return;
    if (this.feedback.reactionOnComplete === "" || this.feedback.reactionOnComplete === this.feedback.reactionOnReceive) return;
    try {
      await this.api.addReaction(channelId, messageId, this.feedback.reactionOnComplete);
    } catch {
      // Best-effort feedback must never abort sending the response.
    }
  }

  /**
   * Handle a native application-command interaction (ADR-0040 D3). The
   * interaction traverses the exact same fail-closed authorization policy as
   * an ordinary message — guild+channel/thread rules and D1 DM rules — and
   * only the five defined commands are translated; arbitrary interaction
   * data is never treated as a prompt. Authorized commands respond through
   * the interaction callback, never through an ordinary channel message.
   */
  async handleInteraction(interaction: DiscordInteractionPayload): Promise<void> {
    const parsed = parseInteractionCommand(interaction);
    if (!parsed.ok) return;
    if (typeof interaction.id !== "string" || interaction.id.trim() === "") return;
    if (typeof interaction.token !== "string" || interaction.token.trim() === "") return;
    if (typeof interaction.channel_id !== "string" || interaction.channel_id === "") return;

    let conversation: string;
    if (interaction.guild_id !== undefined) {
      // Guild path: identical policy to the message path. Interactions carry
      // no thread_id discriminator; a channel_id in the thread allowlist
      // authorizes exactly that thread, otherwise the channel allowlist
      // applies. The DM allowlist is never consulted here.
      if (!this.allowedGuildIds.has(interaction.guild_id)) return;
      if (this.allowedThreadIds.has(interaction.channel_id)) {
        // Explicitly allowlisted thread (same conversation key as the real
        // gateway thread message shape).
      } else if (!this.allowedChannelIds.has(interaction.channel_id)) {
        return;
      }
      const sender = interaction.member?.user;
      if (sender?.bot === true) return;
      if (typeof sender?.id !== "string" || sender.id.trim() === "") return;
      conversation = `${interaction.guild_id}:${interaction.channel_id}`;
    } else {
      // D1 direct-shape parity: a non-guild interaction carrying ANY
      // thread_id field (empty, null, or malformed presence included) is an
      // unknown direct shape, rejected before identity work, metadata
      // lookup, callback, or session — same guard as the D1 message path.
      if (interaction.thread_id !== undefined) return;
      // D1 DM path: sender allowlist first (no lookup for unlisted users),
      // then the verified one-to-one DM channel check.
      if (this.allowedDmUserIds.size === 0) return;
      const sender = interaction.user;
      if (sender?.bot === true) return;
      const senderId = typeof sender?.id === "string" ? sender.id.trim() : "";
      if (senderId === "" || !this.allowedDmUserIds.has(senderId)) return;
      if (!(await this.isDirectMessageChannel(interaction.channel_id))) return;
      conversation = `dm:${interaction.channel_id}`;
    }

    const content = await this.executeCommand(parsed.command, parsed.arg, conversation);
    await this.api.respondToInteraction(interaction.id, interaction.token, content);
  }

  /**
   * Execute one of the five shared transport commands and return its
   * response text. Used by both the legacy text path (which sends the text
   * as a channel message) and native application commands (which respond
   * through the interaction callback). Command outputs never contain local
   * config, tokens, or session internals.
   */
  private async executeCommand(command: "start" | "agents" | "agent" | "whoami" | "abort", arg: string | undefined, conversation: string): Promise<string> {
    if (command === "start") {
      return "Piren Discord transport ready. Use /agents, /agent <name>, /whoami, /abort, /new, /compact, or send a prompt.";
    }
    if (command === "agents") {
      const active = this.sessions.getActiveAgent(this.transportName, conversation) ?? this.defaultAgent;
      return `Runnable Piren agents: ${this.runnableAgents.join(", ")}\nActive agent: ${active}`;
    }
    if (command === "whoami") {
      const active = this.sessions.getActiveAgent(this.transportName, conversation) ?? this.defaultAgent;
      return `Active Piren agent: ${active}`;
    }
    if (command === "abort") {
      const aborted = await this.sessions.abort(this.transportName, conversation);
      return aborted ? "Abort sent to active Piren session." : "No active Piren session for this channel.";
    }
    // agent
    if (arg === undefined) return "Usage: /agent <name>";
    if (!this.runnableAgents.includes(arg)) {
      return `Agent '${arg}' is not in the runnable set. Use /agents to list available agents.`;
    }
    await this.sessions.switchAgent(this.transportName, conversation, arg);
    return `Active Piren agent for this channel: ${arg}`;
  }
  /**
   * `/new`: start a fresh Pi session for this conversation through Pi's
   * native control. Never creates a session; failures are acknowledged
   * generically so raw RPC error text, paths, and transcripts never leak
   * into the channel.
   */
  private async handleNewSessionCommand(channelId: string, conversation: string): Promise<void> {
    let text: string;
    try {
      const outcome = await this.sessions.newSession(this.transportName, conversation);
      text =
        outcome.status === "no-active-session"
          ? "No active Piren session for this channel."
          : outcome.status === "cancelled"
            ? "New Piren session cancelled; the current session is unchanged."
            : "Started a new Piren session for this channel.";
    } catch {
      text = "Failed to start a new Piren session for this channel.";
    }
    await this.api.createMessage(channelId, text);
  }

  /**
   * `/compact`: request Pi's native manual compaction for this conversation.
   * Same safety contract as `/new`: no session creation, no token/usage or
   * transcript details, generic failure acknowledgement.
   */
  private async handleCompactCommand(channelId: string, conversation: string): Promise<void> {
    let text: string;
    try {
      const outcome = await this.sessions.compact(this.transportName, conversation);
      text = outcome.status === "no-active-session" ? "No active Piren session for this channel." : "Compaction complete for this channel's Piren session.";
    } catch {
      text = "Failed to compact this channel's Piren session.";
    }
    await this.api.createMessage(channelId, text);
  }

}

/**
 * Strip a leading bot mention (`<@id>` or `<@!id>`) so a mention-prefixed
 * command or prompt is handled like a plain message. Discord delivers commands
 * and DM-style prompts with the bot mention when the message is not a native
 * application command.
 */
function stripMention(content: string): string {
  return content.replace(/^<@!?[0-9]+>\s*/, "");
}

// ---------------------------------------------------------------------------
// Discord Gateway (WebSocket) client
// ---------------------------------------------------------------------------

/**
 * A minimal gateway socket abstraction. The production implementation wraps the
 * native `WebSocket`; tests inject a fake. The loop only needs the standard
 * event-handler properties plus `send`/`close`.
 */
export interface DiscordGatewaySocket {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

/** Loose shape of a Discord gateway payload. Narrowed structurally in the loop. */
export interface GatewayMessage {
  op?: number;
  t?: string | null;
  s?: number | null;
  d?: unknown;
}

/** Opcodes the loop cares about. */
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

export interface RunDiscordGatewayOptions<TClient extends DiscordPromptClient> {
  botToken: string;
  applicationId: string;
  intents: number;
  transport: DiscordTransport<TClient>;
  socketFactory: () => Promise<DiscordGatewaySocket>;
  /** Overrides the Hello heartbeat_interval. Mainly for fast tests. */
  heartbeatIntervalMs?: number | undefined;
  /** Initial reconnect delay after an unexpected disconnect. Default 1000 ms. */
  reconnectInitialDelayMs?: number | undefined;
  /** Cap for the exponential reconnect delay. Default 30000 ms. */
  reconnectMaxDelayMs?: number | undefined;
  /** Injectable scheduling seam for reconnect delays. Tests avoid real timers. */
  scheduler?: DiscordGatewayScheduler | undefined;
  onReady?: (() => void) | undefined;
  onError?: ((error: Error) => void) | undefined;
  /** Non-secret reconnect notice with the scheduled delay and attempt number. */
  onReconnecting?: ((info: DiscordGatewayReconnectInfo) => void) | undefined;
}

/** Minimal scheduling seam so reconnect delays are testable without real timers. */
export interface DiscordGatewayScheduler {
  setTimeout(fn: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DiscordGatewayReconnectInfo {
  attempt: number;
  delayMs: number;
}

const defaultGatewayScheduler: DiscordGatewayScheduler = {
  setTimeout: (fn, delayMs) => setTimeout(fn, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

export interface DiscordGatewayHandle {
  /** Resolves once the Identify payload has been sent (after Hello). */
  identified(): Promise<void>;
  /** Resolves after one microtask, letting a pending dispatch settle. */
  idle(): Promise<void>;
  /** Closes the gateway and stops the transport. */
  close(): Promise<void>;
}

/**
 * Drive a Discord gateway connection: open the socket, send Identify on Hello,
 * dispatch MESSAGE_CREATE events to the transport, and heartbeat at the
 * negotiated interval echoing the last sequence number.
 *
 * Reconnect lifecycle: an unexpected socket close, socket error, or socket
 * factory/open failure schedules a replacement connection with bounded
 * exponential backoff (default 1 s initial, 30 s cap) and retries
 * indefinitely. Each attempt is a fresh generation: disconnecting supersedes
 * the old generation so its heartbeat timer and stale socket events become
 * inert, and a close/error pair for one socket schedules at most one retry.
 * The DiscordTransport (and its Pi RPC sessions) survives transient
 * reconnects; only an explicit close() cancels pending retries, prevents
 * future reconnects, and closes the transport exactly once.
 *
 * Discord requires a persistent WebSocket *client* connection (the Piren
 * process dials out to Discord). This is categorically different from adding a
 * WebSocket server to Piren's web UI (which stays SSE plus POST per ADR-0012).
 */
export function runDiscordGateway<TClient extends DiscordPromptClient>(
  options: RunDiscordGatewayOptions<TClient>,
): DiscordGatewayHandle {
  const scheduler = options.scheduler ?? defaultGatewayScheduler;
  const reconnectInitialDelayMs = options.reconnectInitialDelayMs ?? 1_000;
  const reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;

  let socket: DiscordGatewaySocket | null = null;
  let sequence: number | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let dispatch: Promise<void> = Promise.resolve();
  let identifySent = false;
  const identifyResolvers: Array<() => void> = [];
  let closed = false;
  let generation = 0;
  let reconnectTimer: unknown = null;
  let reconnectAttempt = 0;

  const notifyIdentified = (): void => {
    while (identifyResolvers.length > 0) {
      const resolve = identifyResolvers.pop();
      if (resolve) resolve();
    }
  };

  const sendHeartbeat = (): void => {
    if (socket) socket.send(JSON.stringify({ op: OP_HEARTBEAT, d: sequence }));
  };

  const clearHeartbeat = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const startHeartbeat = (intervalMs: number): void => {
    clearHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, intervalMs);
  };

  const handlePayload = (payload: GatewayMessage): void => {
    const op = payload.op;
    if (op === OP_HELLO) {
      const hello = payload.d as { heartbeat_interval?: unknown } | undefined;
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
      if (typeof payload.s === "number") sequence = payload.s;
      const type = payload.t;
      const data = payload.d as { id?: string; guild_id?: string; channel_id?: string; thread_id?: string; content?: string; author?: { id?: string; bot?: boolean } } | undefined;
      if (type === "READY") {
        // A completed handshake proves the connection healthy: reset backoff.
        reconnectAttempt = 0;
        options.onReady?.();
        return;
      }
      if (type === "MESSAGE_CREATE" && data) {
        if (data.author?.bot === true) return;
        // Serialize dispatches through a single promise chain so idle() can
        // await the most recent one.
        dispatch = dispatch.then(() => options.transport.handleMessage(data)).catch((err) => {
          options.onError?.(err instanceof Error ? err : new Error(String(err)));
        });
        return;
      }
      if (type === "INTERACTION_CREATE" && payload.d) {
        // Native application commands (ADR-0040 D3). The transport applies
        // the same fail-closed authorization as ordinary messages.
        const interaction = payload.d as DiscordInteractionPayload;
        dispatch = dispatch.then(() => options.transport.handleInteraction(interaction)).catch((err) => {
          options.onError?.(err instanceof Error ? err : new Error(String(err)));
        });
        return;
      }
      return;
    }
  };

  const sendIdentify = (): void => {
    if (!socket || identifySent) return;
    identifySent = true;
    socket.send(
      JSON.stringify({
        op: OP_IDENTIFY,
        d: {
          token: options.botToken,
          intents: options.intents,
          properties: { os: "linux", browser: "piren", device: "piren" },
        },
      }),
    );
    notifyIdentified();
  };

  const scheduleReconnect = (): void => {
    if (closed) return;
    if (reconnectTimer !== null) return; // at most one pending reconnect
    reconnectAttempt += 1;
    const delayMs = Math.min(reconnectInitialDelayMs * 2 ** (reconnectAttempt - 1), reconnectMaxDelayMs);
    options.onReconnecting?.({ attempt: reconnectAttempt, delayMs });
    reconnectTimer = scheduler.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delayMs);
  };

  const handleDisconnect = (gen: number, error: Error): void => {
    if (closed || gen !== generation) return;
    // Supersede this generation first so every stale handler and heartbeat
    // timer for it becomes inert. A close/error pair for one socket therefore
    // passes this guard exactly once and schedules at most one reconnect.
    generation += 1;
    clearHeartbeat();
    const stale = socket;
    socket = null;
    if (stale) {
      try {
        stale.close();
      } catch {
        // best-effort close
      }
    }
    options.onError?.(error);
    scheduleReconnect();
  };

  const connect = async (): Promise<void> => {
    if (closed) return;
    const gen = ++generation;
    identifySent = false;
    sequence = null;
    let fresh: DiscordGatewaySocket;
    try {
      fresh = await options.socketFactory();
    } catch (err) {
      if (closed) return;
      options.onError?.(err instanceof Error ? err : new Error(String(err)));
      scheduleReconnect();
      return;
    }
    if (closed || gen !== generation) {
      // Closed (or superseded) while the factory call was in flight: discard
      // the fresh socket best-effort instead of wiring a zombie connection.
      try {
        fresh.close();
      } catch {
        // best-effort close
      }
      return;
    }
    socket = fresh;
    fresh.onopen = () => {
      // Nothing to send before Hello; the gateway speaks first.
    };
    fresh.onmessage = (ev) => {
      if (closed || gen !== generation) return;
      let payload: GatewayMessage;
      try {
        payload = JSON.parse(ev.data) as GatewayMessage;
      } catch {
        return;
      }
      handlePayload(payload);
    };
    fresh.onclose = () => {
      handleDisconnect(gen, new Error("Discord gateway closed unexpectedly"));
    };
    fresh.onerror = (ev) => {
      const message = ev instanceof Error ? ev.message : "Discord gateway socket error";
      handleDisconnect(gen, new Error(message));
    };
  };

  const teardown = async (): Promise<void> => {
    if (reconnectTimer !== null) {
      scheduler.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    clearHeartbeat();
    await dispatch;
    const active = socket;
    socket = null;
    if (active) {
      try {
        active.close();
      } catch {
        // best-effort close
      }
    }
    await options.transport.close();
  };

  // Boot the connection.
  void connect();

  return {
    identified(): Promise<void> {
      if (identifySent) return Promise.resolve();
      return new Promise<void>((resolve) => {
        identifyResolvers.push(resolve);
      });
    },
    async idle(): Promise<void> {
      await dispatch;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await teardown();
    },
  };
}

/**
 * Production gateway socket factory: connects to the Discord gateway using the
 * native WebSocket (Node >= 22) and adapts it to the `DiscordGatewaySocket`
 * interface the loop consumes.
 *
 * The returned promise settles exactly once: open resolves it, while an error
 * or a close before open rejects it (a close during CONNECTING legitimately
 * arrives without any error event, and the reconnect lifecycle depends on the
 * factory settling). After settlement, events are only forwarded to the
 * adapter handlers and can never reverse or re-settle the promise.
 */
export function createNativeDiscordGatewaySocket(
  url: string,
  WebSocketImpl: typeof WebSocket = WebSocket,
): Promise<DiscordGatewaySocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(url);
    let settled = false;
    const adapter: DiscordGatewaySocket = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(data: string): void {
        ws.send(data);
      },
      close(): void {
        try {
          ws.close();
        } catch {
          // best-effort
        }
      },
    };
    ws.addEventListener("open", (ev) => {
      if (!settled) {
        settled = true;
        resolve(adapter);
      }
      adapter.onopen?.(ev);
    });
    ws.addEventListener("message", (ev: MessageEvent) => adapter.onmessage?.({ data: typeof ev.data === "string" ? ev.data : String(ev.data) }));
    ws.addEventListener("close", (ev) => {
      if (!settled) {
        settled = true;
        reject(new Error("Discord gateway socket closed before open"));
        return;
      }
      adapter.onclose?.(ev);
    });
    ws.addEventListener("error", () => {
      const error = new Error("Discord gateway socket error");
      if (!settled) {
        settled = true;
        reject(error);
        return;
      }
      adapter.onerror?.(error);
    });
    // Resolve immediately when the socket is already open (some impls).
    if (!settled && ws.readyState === WebSocketImpl.OPEN) {
      settled = true;
      resolve(adapter);
    }
  });
}

