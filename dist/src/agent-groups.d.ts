/**
 * Resolved group configuration parsed from
 * `agent-groups/<group>/config.yml`.
 *
 * See ADR-0028 for the full design.
 */
interface GroupConfig {
    /** Agent names declared as members of this group, in declaration order. */
    agents: string[];
    /**
     * Per-agent ordered fallback candidates within this group. Keys are agent
     * names that belong to {@link GroupConfig.agents}; values are ordered lists
     * of candidate fallback agents.
     */
    fallback_order: Record<string, string[]>;
}
/** A parsed group keyed by group name. */
type GroupConfigs = Map<string, GroupConfig>;
/** A read-only fallback candidate with its recommending group names. */
export interface FallbackRecommendation {
    agent: string;
    sourceGroups: string[];
}
/**
 * Parse all group declarations under `<vaultRoot>/agent-groups/`.
 *
 * Each subdirectory that contains a `config.yml` contributes a
 * {@link GroupConfig} entry keyed by directory name. A missing
 * `agent-groups/` directory returns an empty map. A group directory without
 * `config.yml` is skipped silently. Malformed YAML is surfaced as a thrown
 * error that names the offending group so it is easy to locate.
 *
 * Dotfiles and non-directory entries under `agent-groups/` are ignored.
 *
 * This function touches the real filesystem; it is intentionally pure with
 * respect to side effects beyond reads (no writes, no state mutation).
 */
export declare function parseGroupConfigs(vaultRoot: string): Promise<GroupConfigs>;
/**
 * Resolve the set of group names an agent belongs to, in the order groups are
 * discovered on disk. Returns an empty array when `agent-groups/` is missing
 * or the agent is not a declared member of any group.
 */
export declare function resolveAgentGroups(vaultRoot: string, agentName: string): Promise<string[]>;
/**
 * Resolve eligible fallback candidates for an agent across all groups it
 * belongs to, filtered by local runnable-agent policy.
 *
 * Candidates are drawn from each group's `fallback_order` for the given
 * agent, then filtered so only agents present in `allowedAgents` and absent
 * from `excludedAgents` are returned. Candidates are deduplicated by first
 * occurrence, preserving the order across groups and within each
 * `fallback_order` list.
 *
 * The local `allowedAgents`/`excludedAgents` policy always wins: this helper
 * never suggests an agent the installation cannot run or has explicitly
 * excluded. Returns an empty array when the agent belongs to no group, has
 * no declared fallback order, or no candidates survive filtering.
 */
export declare function resolveFallbackCandidates(vaultRoot: string, agentName: string, allowedAgents: string[], excludedAgents: string[]): Promise<string[]>;
/**
 * Return read-only fallback recommendations for a failed agent, each enriched
 * with its source groups. Candidates are drawn from each group's
 * `fallback_order`, filtered by local runnable-agent policy (allowed/excluded),
 * deduplicated by agent while merging sourceGroups across groups, and returned
 * in first-encounter order.
 *
 * This is a diagnostic helper, not a rerouting action. Returns an empty array
 * when the agent belongs to no groups, has no declared fallback order, or no
 * candidate survives the local-policy filter.
 */
export declare function recommendFallback(vaultRoot: string, failedAgent: string, allowedAgents: string[], excludedAgents: string[]): Promise<FallbackRecommendation[]>;
export {};
