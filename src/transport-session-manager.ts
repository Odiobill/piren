import { PiRpcClient, type RpcCompaction, type RpcNewSession, type RpcSpawnTarget } from "./gateway-rpc.js";
import type { RpcTargetBuilder } from "./gateway-http.js";

export interface TransportRpcClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  abort(): Promise<void>;
  /** Pi-native fresh session in the same process. Rejects on RPC failure. */
  newSession(): Promise<RpcNewSession>;
  /** Pi-native manual compaction. Rejects on RPC failure. */
  compact(): Promise<RpcCompaction>;
}

/**
 * Outcome of a conversation-scoped `newSession` control. `no-active-session`
 * means the conversation has no live Pi RPC client (nothing was created);
 * `cancelled` means a Pi extension declined the fresh session; `completed`
 * means Pi started the fresh session. Client/RPC errors always reject.
 */
export type TransportNewSessionOutcome =
  | { status: "no-active-session" }
  | { status: "completed" }
  | { status: "cancelled" };

/**
 * Outcome of a conversation-scoped `compact` control. Token figures are
 * Pi's heuristic estimates (null when Pi omits them); raw summary/transcript
 * data is never surfaced.
 */
export type TransportCompactOutcome =
  | { status: "no-active-session" }
  | { status: "completed"; tokensBefore: number | null; estimatedTokensAfter: number | null };

export interface TransportSession<TClient extends TransportRpcClient = PiRpcClient> {
  transport: string;
  conversationId: string;
  agent: string;
  client: TClient;
  lastUsedAt: number;
  /**
   * TB7 active-incident cancellation flag. Set by `abort()`/`closeAll()`
   * BEFORE calling `client.abort()`/`stop()` so a supported transport
   * abort/shutdown path marks the active fallback incident; the transport's
   * fallback runner observes it at its next await boundary and never issues
   * a handoff re-prompt. Reset by the transport when a fresh prompt incident
   * starts and completes.
   */
  abortRequested: boolean;
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
 * Merge per-spawn env overrides into a NEW target with a NEW env object: the
 * caller's targetBuilder output and its env are never mutated, and the global
 * `process.env` is never touched (mirrors the room broker's decorate helper).
 * C5-3 uses this to stamp the broker-owned conversation handoff role flag on
 * only its own Conversation run spawn targets.
 */
function withEnvOverrides(target: RpcSpawnTarget, overrides: Record<string, string>): RpcSpawnTarget {
  return {
    ...target,
    env: {
      ...target.env,
      ...overrides,
    },
  };
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

  async getSession(
    transport: string,
    conversationId: string,
    agent?: string,
    envOverrides?: Record<string, string>,
  ): Promise<TransportSession<TClient>> {
    const key = sessionKey(transport, conversationId);
    const existing = this.sessions.get(key);
    if (existing) {
      if (agent !== undefined && existing.agent !== agent) {
        return await this.switchAgent(transport, conversationId, agent, envOverrides);
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
    const effectiveTarget = envOverrides !== undefined ? withEnvOverrides(target, envOverrides) : target;
    const client = this.clientFactory(effectiveTarget);
    await client.start();

    const session: TransportSession<TClient> = {
      transport,
      conversationId,
      agent: requestedAgent,
      client,
      lastUsedAt: this.now(),
      abortRequested: false,
    };
    this.sessions.set(key, session);
    return session;
  }

  async switchAgent(
    transport: string,
    conversationId: string,
    agent: string,
    envOverrides?: Record<string, string>,
  ): Promise<TransportSession<TClient>> {
    this.assertRunnable(agent);
    const key = sessionKey(transport, conversationId);
    const existing = this.sessions.get(key);
    if (existing?.agent === agent) {
      existing.lastUsedAt = this.now();
      return existing;
    }

    const target = await this.targetBuilder(agent);
    const effectiveTarget = envOverrides !== undefined ? withEnvOverrides(target, envOverrides) : target;
    const nextClient = this.clientFactory(effectiveTarget);
    await nextClient.start();

    const nextSession: TransportSession<TClient> = {
      transport,
      conversationId,
      agent,
      client: nextClient,
      lastUsedAt: this.now(),
      abortRequested: false,
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
    // TB7 §5.6: mark the active fallback incident BEFORE calling
    // client.abort() so the runner observes the cancellation at its next
    // await boundary (policy load, notice delivery, or delayed set_model).
    session.abortRequested = true;
    await session.client.abort();
    session.lastUsedAt = this.now();
    return true;
  }

  getActiveAgent(transport: string, conversationId: string): string | null {
    return this.sessions.get(sessionKey(transport, conversationId))?.agent ?? null;
  }

  /**
   * Start a fresh Pi session for an existing conversation through Pi's
   * native `new_session` control. Never creates a client when none is
   * active; the active agent and RPC client identity are preserved (no
   * process restart or swap). RPC errors reject.
   */
  async newSession(transport: string, conversationId: string): Promise<TransportNewSessionOutcome> {
    const session = this.sessions.get(sessionKey(transport, conversationId));
    if (!session) return { status: "no-active-session" };
    const result = await session.client.newSession();
    session.lastUsedAt = this.now();
    return result.cancelled ? { status: "cancelled" } : { status: "completed" };
  }

  /**
   * Manually compact an existing conversation's Pi session through Pi's
   * native `compact` control. Never creates a client when none is active and
   * does not change automatic-compaction policy. RPC errors reject.
   */
  async compact(transport: string, conversationId: string): Promise<TransportCompactOutcome> {
    const session = this.sessions.get(sessionKey(transport, conversationId));
    if (!session) return { status: "no-active-session" };
    const result = await session.client.compact();
    session.lastUsedAt = this.now();
    return { status: "completed", tokensBefore: result.tokensBefore, estimatedTokensAfter: result.estimatedTokensAfter };
  }

  /**
   * Remove exactly one known-dead session from the map WITHOUT stopping its
   * client. Use only when the client's process has already exited (stopping
   * a dead client is meaningless and error-prone). The optional
   * expectedClient guard refuses to forget a session that was replaced in
   * the meantime. A later explicit getSession for the same key builds a
   * fresh client. Returns true only when the exact session was forgotten.
   */
  forgetSession(transport: string, conversationId: string, expectedClient?: TClient): boolean {
    const key = sessionKey(transport, conversationId);
    const existing = this.sessions.get(key);
    if (!existing) return false;
    if (expectedClient !== undefined && existing.client !== expectedClient) return false;
    this.sessions.delete(key);
    return true;
  }

  /**
   * T4: return the exact live session for a key WITHOUT creating one and
   * without touching `lastUsedAt`. Read-only telemetry peek: never spawns a
   * client, never switches an agent, never throws for a missing key.
   */
  peekSession(transport: string, conversationId: string): TransportSession<TClient> | null {
    return this.sessions.get(sessionKey(transport, conversationId)) ?? null;
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
      // Shutdown is also abort authority: mark the incident before stopping
      // so an in-flight fallback stops at its next await boundary.
      session.abortRequested = true;
      await session.client.stop();
    }
  }

  private assertRunnable(agent: string): void {
    if (!this.runnableAgents.includes(agent)) {
      throw new Error(`agent '${agent}' is not in the runnable set`);
    }
  }
}
