/**
 * Decommission (ADR-0043 2026-08-14) — Conversation-neutral local-policy
 * roster core (replaces the retired room-agent roster; served only at
 * `GET /api/conversation-agents`, never aliased).
 *
 * `online` is local installation policy only: membership in this gateway
 * machine's already-resolved `runnableAgents` set. It is NOT Pi-process
 * presence, provider reachability, transport state, remote availability, or
 * identity. The roster is explicitly supplied by the caller (the CLI passes
 * the vault-defined `team/<agent>/` names it has already resolved with local
 * policy); there is no config reread, no directory creation, no probing, and
 * no polling here.
 */
export interface ConversationAgentEntry {
    name: string;
    online: boolean;
}
export interface ConversationAgentsResponse {
    agents: ConversationAgentEntry[];
}
/**
 * Build the deterministic roster response. Names come from the supplied
 * vault roster (deduplicated, sorted by name); `online` is true exactly when
 * the name is in the gateway's runnable set. An empty supplied roster
 * returns an empty list; runnable agents absent from the roster are not
 * added (the roster, not the runnable set, drives membership).
 */
export declare function buildConversationAgentsResponse(vaultAgents: readonly string[], runnableAgents: readonly string[]): ConversationAgentsResponse;
