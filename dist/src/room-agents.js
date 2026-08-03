/**
 * Build the deterministic roster response. Names come from the supplied
 * vault roster (deduplicated, sorted by name); `online` is true exactly when
 * the name is in the gateway's runnable set. An empty supplied roster
 * returns an empty list; runnable agents absent from the roster are not
 * added (the roster, not the runnable set, drives membership).
 */
export function buildRoomAgentsResponse(vaultAgents, runnableAgents) {
    const runnable = new Set(runnableAgents);
    const names = [...new Set(vaultAgents)].sort((a, b) => a.localeCompare(b));
    return { agents: names.map((name) => ({ name, online: runnable.has(name) })) };
}
//# sourceMappingURL=room-agents.js.map