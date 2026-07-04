import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function asStringArray(value) {
    return Array.isArray(value)
        ? value.filter((v) => typeof v === "string")
        : [];
}
function asFallbackOrder(value) {
    const result = {};
    if (!isRecord(value))
        return result;
    for (const [key, raw] of Object.entries(value)) {
        result[key] = asStringArray(raw);
    }
    return result;
}
function toGroupConfig(raw) {
    const record = isRecord(raw) ? raw : {};
    return {
        agents: asStringArray(record.agents),
        fallback_order: asFallbackOrder(record.fallback_order),
    };
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
export async function parseGroupConfigs(vaultRoot) {
    const groupsDir = join(vaultRoot, "agent-groups");
    let entries;
    try {
        entries = await readdir(groupsDir, { withFileTypes: true });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith("ENOENT") || msg.includes("ENOENT")) {
            return new Map();
        }
        throw err;
    }
    const groups = new Map();
    for (const entry of entries) {
        if (entry.name.startsWith("."))
            continue;
        if (!entry.isDirectory())
            continue;
        const configPath = join(groupsDir, entry.name, "config.yml");
        try {
            await stat(configPath);
        }
        catch {
            // No config.yml in this group dir: skip it, not an error.
            continue;
        }
        const content = await readFile(configPath, "utf8");
        let parsed;
        try {
            parsed = parseYaml(content);
        }
        catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(`Malformed config.yml for agent group "${entry.name}": ${detail}`);
        }
        groups.set(entry.name, toGroupConfig(parsed));
    }
    return groups;
}
/**
 * Resolve the set of group names an agent belongs to, in the order groups are
 * discovered on disk. Returns an empty array when `agent-groups/` is missing
 * or the agent is not a declared member of any group.
 */
export async function resolveAgentGroups(vaultRoot, agentName) {
    const groups = await parseGroupConfigs(vaultRoot);
    const result = [];
    for (const [name, config] of groups) {
        if (config.agents.includes(agentName)) {
            result.push(name);
        }
    }
    return result;
}
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
export async function resolveFallbackCandidates(vaultRoot, agentName, allowedAgents, excludedAgents) {
    const groups = await parseGroupConfigs(vaultRoot);
    const allowed = new Set(allowedAgents);
    const excluded = new Set(excludedAgents);
    const seen = new Set();
    const result = [];
    for (const config of groups.values()) {
        if (!config.agents.includes(agentName))
            continue;
        const ordered = config.fallback_order[agentName];
        if (!ordered)
            continue;
        for (const candidate of ordered) {
            if (candidate === agentName)
                continue;
            if (excluded.has(candidate))
                continue;
            if (!allowed.has(candidate))
                continue;
            if (seen.has(candidate))
                continue;
            seen.add(candidate);
            result.push(candidate);
        }
    }
    return result;
}
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
export async function recommendFallback(vaultRoot, failedAgent, allowedAgents, excludedAgents) {
    const groups = await parseGroupConfigs(vaultRoot);
    const allowed = new Set(allowedAgents);
    const excluded = new Set(excludedAgents);
    const seen = new Set();
    const result = [];
    for (const [groupName, config] of groups) {
        if (!config.agents.includes(failedAgent))
            continue;
        const ordered = config.fallback_order[failedAgent];
        if (!ordered)
            continue;
        for (const candidate of ordered) {
            if (candidate === failedAgent)
                continue;
            if (excluded.has(candidate))
                continue;
            if (!allowed.has(candidate))
                continue;
            if (seen.has(candidate)) {
                // Candidate already seen: add this group as an additional source.
                const existing = result.find((r) => r.agent === candidate);
                if (existing && !existing.sourceGroups.includes(groupName)) {
                    existing.sourceGroups.push(groupName);
                }
                continue;
            }
            seen.add(candidate);
            result.push({ agent: candidate, sourceGroups: [groupName] });
        }
    }
    return result;
}
//# sourceMappingURL=agent-groups.js.map