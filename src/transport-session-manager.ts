import { PiRpcClient, type RpcSpawnTarget } from "./gateway-rpc.js";
import type { RpcTargetBuilder } from "./gateway-http.js";

export interface TransportRpcClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  abort(): Promise<void>;
}

export interface TransportSession<TClient extends TransportRpcClient = PiRpcClient> {
  transport: string;
  conversationId: string;
  agent: string;
  client: TClient;
  lastUsedAt: number;
}

export interface TransportSessionManagerOptions<TClient extends TransportRpcClient = PiRpcClient> {
  runnableAgents: string[];
  defaultAgent?: string | undefined;
  targetBuilder: RpcTargetBuilder;
  clientFactory?: ((target: RpcSpawnTarget) => TClient) | undefined;
  now?: (() => number) | undefined;
}

function sessionKey(transport: string, conversationId: string): string {
  return `${transport}:${conversationId}`;
}

/**
 * Owns one Pi RPC client per messaging-platform conversation.
 *
 * Messaging platforms such as Telegram and Discord can have many concurrent
 * chats, channels, or threads. Each conversation keeps one active Piren agent
 * selected from the local runnable set, with its own RPC child process. This
 * keeps platform identities separate from Piren agent identities per ADR-0016.
 */
export class TransportSessionManager<TClient extends TransportRpcClient = PiRpcClient> {
  private readonly runnableAgents: string[];
  private readonly defaultAgent: string;
  private readonly targetBuilder: RpcTargetBuilder;
  private readonly clientFactory: (target: RpcSpawnTarget) => TClient;
  private readonly now: () => number;
  private readonly sessions = new Map<string, TransportSession<TClient>>();

  constructor(options: TransportSessionManagerOptions<TClient>) {
    this.runnableAgents = [...options.runnableAgents];
    this.defaultAgent = options.defaultAgent ?? this.runnableAgents[0] ?? "";
    this.targetBuilder = options.targetBuilder;
    this.clientFactory = options.clientFactory ?? ((target) => new PiRpcClient(target) as unknown as TClient);
    this.now = options.now ?? (() => Date.now());

    if (this.defaultAgent !== "") {
      this.assertRunnable(this.defaultAgent);
    }
  }

  async getSession(transport: string, conversationId: string, agent?: string): Promise<TransportSession<TClient>> {
    const key = sessionKey(transport, conversationId);
    const existing = this.sessions.get(key);
    if (existing) {
      if (agent !== undefined && existing.agent !== agent) {
        return await this.switchAgent(transport, conversationId, agent);
      }
      existing.lastUsedAt = this.now();
      return existing;
    }

    const requestedAgent = agent ?? this.defaultAgent;
    if (requestedAgent === "") {
      throw new Error("No runnable Piren agents are configured for this transport");
    }
    this.assertRunnable(requestedAgent);

    const target = await this.targetBuilder(requestedAgent);
    const client = this.clientFactory(target);
    await client.start();

    const session: TransportSession<TClient> = {
      transport,
      conversationId,
      agent: requestedAgent,
      client,
      lastUsedAt: this.now(),
    };
    this.sessions.set(key, session);
    return session;
  }

  async switchAgent(transport: string, conversationId: string, agent: string): Promise<TransportSession<TClient>> {
    this.assertRunnable(agent);
    const key = sessionKey(transport, conversationId);
    const existing = this.sessions.get(key);
    if (existing?.agent === agent) {
      existing.lastUsedAt = this.now();
      return existing;
    }

    const target = await this.targetBuilder(agent);
    const nextClient = this.clientFactory(target);
    await nextClient.start();

    const nextSession: TransportSession<TClient> = {
      transport,
      conversationId,
      agent,
      client: nextClient,
      lastUsedAt: this.now(),
    };
    this.sessions.set(key, nextSession);

    if (existing) {
      await existing.client.stop();
    }

    return nextSession;
  }

  async abort(transport: string, conversationId: string): Promise<boolean> {
    const session = this.sessions.get(sessionKey(transport, conversationId));
    if (!session) return false;
    await session.client.abort();
    session.lastUsedAt = this.now();
    return true;
  }

  getActiveAgent(transport: string, conversationId: string): string | null {
    return this.sessions.get(sessionKey(transport, conversationId))?.agent ?? null;
  }

  async closeIdleSessions(maxIdleMs: number): Promise<number> {
    const cutoff = this.now() - maxIdleMs;
    let closed = 0;
    for (const [key, session] of [...this.sessions.entries()]) {
      if (session.lastUsedAt <= cutoff) {
        this.sessions.delete(key);
        await session.client.stop();
        closed += 1;
      }
    }
    return closed;
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      await session.client.stop();
    }
  }

  private assertRunnable(agent: string): void {
    if (!this.runnableAgents.includes(agent)) {
      throw new Error(`agent '${agent}' is not in the runnable set`);
    }
  }
}
