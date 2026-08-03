/**
 * ADR-0041 R3b-2 room-agent roster (pure core).
 *
 * `online` is local installation policy only: membership in this gateway
 * machine's already-resolved `runnableAgents` set. It is NOT Pi-process
 * presence, provider reachability, transport state, remote availability, or
 * identity. The roster is explicitly supplied by the caller (the CLI passes
 * the vault-defined `team/<agent>/` names it has already resolved with local
 * policy); there is no config reread, no directory creation, no probing, and
 * no polling here.
 */
export interface RoomAgentEntry {
  name: string;
  online: boolean;
}

export interface RoomAgentsResponse {
  agents: RoomAgentEntry[];
}

/**
 * Build the deterministic roster response. Names come from the supplied
 * vault roster (deduplicated, sorted by name); `online` is true exactly when
 * the name is in the gateway's runnable set. An empty supplied roster
 * returns an empty list; runnable agents absent from the roster are not
 * added (the roster, not the runnable set, drives membership).
 */
export function buildRoomAgentsResponse(vaultAgents: readonly string[], runnableAgents: readonly string[]): RoomAgentsResponse {
  const runnable = new Set(runnableAgents);
  const names = [...new Set(vaultAgents)].sort((a, b) => a.localeCompare(b));
  return { agents: names.map((name) => ({ name, online: runnable.has(name) })) };
}
