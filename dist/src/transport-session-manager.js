import { PiRpcClient } from "./gateway-rpc.js";
function sessionKey(transport, conversationId) {
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
export class TransportSessionManager {
    runnableAgents;
    defaultAgent;
    targetBuilder;
    clientFactory;
    now;
    sessions = new Map();
    constructor(options) {
        this.runnableAgents = [...options.runnableAgents];
        this.defaultAgent = options.defaultAgent ?? this.runnableAgents[0] ?? "";
        this.targetBuilder = options.targetBuilder;
        this.clientFactory = options.clientFactory ?? ((target) => new PiRpcClient(target));
        this.now = options.now ?? (() => Date.now());
        if (this.defaultAgent !== "") {
            this.assertRunnable(this.defaultAgent);
        }
    }
    async getSession(transport, conversationId, agent) {
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
        const session = {
            transport,
            conversationId,
            agent: requestedAgent,
            client,
            lastUsedAt: this.now(),
        };
        this.sessions.set(key, session);
        return session;
    }
    async switchAgent(transport, conversationId, agent) {
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
        const nextSession = {
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
    async abort(transport, conversationId) {
        const session = this.sessions.get(sessionKey(transport, conversationId));
        if (!session)
            return false;
        await session.client.abort();
        session.lastUsedAt = this.now();
        return true;
    }
    getActiveAgent(transport, conversationId) {
        return this.sessions.get(sessionKey(transport, conversationId))?.agent ?? null;
    }
    async closeIdleSessions(maxIdleMs) {
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
    async closeAll() {
        const sessions = [...this.sessions.values()];
        this.sessions.clear();
        for (const session of sessions) {
            await session.client.stop();
        }
    }
    assertRunnable(agent) {
        if (!this.runnableAgents.includes(agent)) {
            throw new Error(`agent '${agent}' is not in the runnable set`);
        }
    }
}
//# sourceMappingURL=transport-session-manager.js.map