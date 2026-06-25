import { chunkTelegramMessage } from "./telegram-transport.js";
import { extractAssistantText, type RpcEvent, type RpcSpawnTarget } from "./gateway-rpc.js";
import { TransportSessionManager, type TransportRpcClient } from "./transport-session-manager.js";
import type { RpcTargetBuilder } from "./gateway-http.js";

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
  guild_id?: string;
  channel_id?: string;
  thread_id?: string;
  content?: string;
}

export interface DiscordBotApi {
  createMessage(channelId: string, text: string): Promise<void>;
}

export class DiscordBotApiHttpClient implements DiscordBotApi {
  constructor(private readonly botToken: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async createMessage(channelId: string, text: string): Promise<void> {
    const response = await this.fetchImpl(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        authorization: "Bot " + this.botToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content: text }),
    });
    if (!response.ok) {
      throw new Error(await this.describeError(response));
    }
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
  runnableAgents: string[];
  defaultAgent?: string | undefined;
  targetBuilder: RpcTargetBuilder;
  clientFactory: (target: RpcSpawnTarget) => TClient;
  api: DiscordBotApi;
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
  private readonly runnableAgents: string[];
  private readonly defaultAgent: string;
  private readonly api: DiscordBotApi;
  private readonly sessions: TransportSessionManager<TClient>;

  constructor(options: DiscordTransportOptions<TClient>) {
    this.transportName = options.transportName ?? "discord";
    this.allowedGuildIds = new Set(options.allowedGuildIds.map((id) => String(id)));
    this.allowedChannelIds = new Set(options.allowedChannelIds.map((id) => String(id)));
    this.allowedThreadIds = new Set((options.allowedThreadIds ?? []).map((id) => String(id)));
    this.runnableAgents = [...options.runnableAgents];
    this.defaultAgent = options.defaultAgent ?? this.runnableAgents[0] ?? "";
    this.api = options.api;
    this.sessions = new TransportSessionManager<TClient>({
      runnableAgents: this.runnableAgents,
      defaultAgent: this.defaultAgent,
      targetBuilder: options.targetBuilder,
      clientFactory: options.clientFactory,
    });
  }

  async handleMessage(message: DiscordMessage): Promise<void> {
    if (!message.guild_id || !message.channel_id) return;
    if (!this.allowedGuildIds.has(message.guild_id)) return;
    // When thread allowlists are configured, a threaded message must be in an
    // allowed thread; otherwise channels are checked directly.
    if (message.thread_id) {
      if (this.allowedThreadIds.size > 0 && !this.allowedThreadIds.has(message.thread_id)) return;
    } else if (!this.allowedChannelIds.has(message.channel_id)) {
      return;
    }

    const channelId = message.thread_id ?? message.channel_id;
    const conversation = conversationId(message);
    if (conversation === null) return;

    const raw = typeof message.content === "string" ? message.content : "";
    const trimmed = stripMention(raw).trim();
    if (trimmed === "") return;

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

    const session = await this.sessions.getSession(this.transportName, conversation);
    const events = await session.client.promptAndWait(trimmed);
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

  private async handleAgentCommand(channelId: string, conversation: string, text: string): Promise<void> {
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
  onReady?: (() => void) | undefined;
  onError?: ((error: Error) => void) | undefined;
}

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
 * Discord requires a persistent WebSocket *client* connection (the Piren
 * process dials out to Discord). This is categorically different from adding a
 * WebSocket server to Piren's web UI (which stays SSE plus POST per ADR-0012).
 */
export function runDiscordGateway<TClient extends DiscordPromptClient>(
  options: RunDiscordGatewayOptions<TClient>,
): DiscordGatewayHandle {
  let socket: DiscordGatewaySocket | null = null;
  let sequence: number | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let dispatch: Promise<void> = Promise.resolve();
  let identifySent = false;
  const identifyResolvers: Array<() => void> = [];
  let closed = false;

  const notifyIdentified = (): void => {
    while (identifyResolvers.length > 0) {
      const resolve = identifyResolvers.pop();
      if (resolve) resolve();
    }
  };

  const sendHeartbeat = (): void => {
    if (socket) socket.send(JSON.stringify({ op: OP_HEARTBEAT, d: sequence }));
  };

  const startHeartbeat = (intervalMs: number): void => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
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
      const data = payload.d as { guild_id?: string; channel_id?: string; thread_id?: string; content?: string; author?: { bot?: boolean } } | undefined;
      if (type === "READY") {
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

  const teardown = async (): Promise<void> => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    await dispatch;
    if (socket) {
      try {
        socket.close();
      } catch {
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
        let payload: GatewayMessage;
        try {
          payload = JSON.parse(ev.data) as GatewayMessage;
        } catch {
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
    } catch (err) {
      options.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  })();

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
export function createNativeDiscordGatewaySocket(
  url: string,
  WebSocketImpl: typeof WebSocket = WebSocket,
): Promise<DiscordGatewaySocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(url);
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
    ws.addEventListener("open", (ev) => adapter.onopen?.(ev));
    ws.addEventListener("message", (ev: MessageEvent) => adapter.onmessage?.({ data: typeof ev.data === "string" ? ev.data : String(ev.data) }));
    ws.addEventListener("close", (ev) => adapter.onclose?.(ev));
    ws.addEventListener("error", () => {
      const error = new Error("Discord gateway socket error");
      if (adapter.onerror) {
        adapter.onerror(error);
      } else {
        reject(error);
      }
    });
    // Resolve once open; if the socket is already open (some impls), resolve now.
    if (ws.readyState === WebSocketImpl.OPEN) {
      resolve(adapter);
    } else {
      const onFirstOpen = (): void => {
        ws.removeEventListener("open", onFirstOpen);
        resolve(adapter);
      };
      ws.addEventListener("open", onFirstOpen);
    }
  });
}

