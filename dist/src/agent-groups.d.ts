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
/**
 * Injected filesystem operations for {@link parseGroupConfigs}. Tests inject a
 * fake `readdir` so enumeration order is controllable; production uses the
 * real `node:fs/promises` adapter.
 */
export interface GroupConfigDeps {
    readdir(path: string, options: {
        withFileTypes: true;
    }): Promise<import("node:fs").Dirent[]>;
}
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
 * Groups are processed in deterministic ascending name order regardless of
 * directory enumeration order (the optional injected `deps` seam lets tests
 * control enumeration). Because ADR-0028 group-skill precedence treats later
 * groups as overriding earlier groups for same-name skills, this stable order
 * is what makes multi-group skill resolution deterministic.
 *
 * Dotfiles and non-directory entries under `agent-groups/` are ignored.
 *
 * This function touches the real filesystem; it is intentionally pure with
 * respect to side effects beyond reads (no writes, no state mutation).
 */
export declare function parseGroupConfigs(vaultRoot: string, deps?: GroupConfigDeps): Promise<GroupConfigs>;
/**
 * Resolve the set of group names an agent belongs to, in deterministic
 * ascending group-name order (the order produced by
 * {@link parseGroupConfigs}). Returns an empty array when `agent-groups/` is
 * missing or the agent is not a declared member of any group.
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
