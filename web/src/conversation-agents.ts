/**
 * Decommission (ADR-0043 2026-08-14) — Conversation-neutral local-policy
 * roster types + parser for the Workbench. The web client reads the roster
 * ONLY from `GET /api/conversation-agents` (the retired `/api/room-agents`
 * route is gone, never aliased). `online` is local installation policy only
 * (membership in the gateway's resolved runnable set) — never Pi-process
 * presence, provider reachability, transport state, or identity.
 */
export interface ConversationAgentEntry {
  name: string;
  online: boolean;
}

export interface ConversationAgentsResponse {
  agents: ConversationAgentEntry[];
}

/** Fail-closed validation of GET /api/conversation-agents. */
export function parseConversationAgents(json: unknown): ConversationAgentsResponse {
  if (typeof json !== "object" || json === null || !("agents" in json)) {
    throw new Error("unexpected /api/conversation-agents response");
  }
  const agents = (json as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) throw new Error("unexpected /api/conversation-agents response");
  for (const entry of agents) {
    if (typeof entry !== "object" || entry === null) throw new Error("unexpected roster entry");
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name === "" || typeof record.online !== "boolean") {
      throw new Error("unexpected roster entry");
    }
  }
  return { agents: agents as ConversationAgentEntry[] };
}
