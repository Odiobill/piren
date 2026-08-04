import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

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
  readdir(
    path: string,
    options: { withFileTypes: true },
  ): Promise<import("node:fs").Dirent[]>;
}

const realGroupConfigDeps: GroupConfigDeps = {
  readdir: (path, options) => readdir(path, options),
};

/** A read-only fallback candidate with its recommending group names. */
export interface FallbackRecommendation {
  agent: string;
  sourceGroups: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function asFallbackOrder(value: unknown): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!isRecord(value)) return result;
  for (const [key, raw] of Object.entries(value)) {
    result[key] = asStringArray(raw);
  }
  return result;
}

function toGroupConfig(raw: unknown): GroupConfig {
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
 * Groups are processed in a deterministic ascending UTF-16 code-unit
 * (lexical) name order regardless of directory enumeration order (the
 * optional injected `deps` seam lets tests control enumeration). The
 * comparator is locale-independent: `localeCompare` depends on the host
 * locale, and because ADR-0028 group-skill precedence treats later groups as
 * overriding earlier groups for same-name skills, a locale-dependent order
 * could change skill resolution between hosts. This stable fixed order is
 * what makes multi-group skill resolution deterministic everywhere.
 *
 * Dotfiles and non-directory entries under `agent-groups/` are ignored.
 *
 * This function touches the real filesystem; it is intentionally pure with
 * respect to side effects beyond reads (no writes, no state mutation).
 */
export async function parseGroupConfigs(
  vaultRoot: string,
  deps: GroupConfigDeps = realGroupConfigDeps,
): Promise<GroupConfigs> {
  const groupsDir = join(vaultRoot, "agent-groups");

  let entries: import("node:fs").Dirent[];
  try {
    entries = await deps.readdir(groupsDir, { withFileTypes: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("ENOENT") || msg.includes("ENOENT")) {
      return new Map();
    }
    throw err;
  }

  const groups: GroupConfigs = new Map();
  // Deterministic processing order: ascending UTF-16 code-unit (lexical)
  // group-name order. The skill loader (ADR-0028) resolves group precedence
  // from this order (later groups override earlier same-name skills), so it
  // must be stable across filesystems AND host locales instead of depending
  // on directory enumeration order or `localeCompare` collation.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory()) continue;

    const configPath = join(groupsDir, entry.name, "config.yml");
    try {
      await stat(configPath);
    } catch {
      // No config.yml in this group dir: skip it, not an error.
      continue;
    }

    const content = await readFile(configPath, "utf8");
    let parsed: unknown;
    try {
      parsed = parseYaml(content);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Malformed config.yml for agent group "${entry.name}": ${detail}`);
    }
    groups.set(entry.name, toGroupConfig(parsed));
  }

  return groups;
}

/**
 * Resolve the set of group names an agent belongs to, in deterministic
 * ascending UTF-16 code-unit (lexical) order (the order produced by
 * {@link parseGroupConfigs}). Returns an empty array when `agent-groups/` is
 * missing or the agent is not a declared member of any group.
 */
export async function resolveAgentGroups(
  vaultRoot: string,
  agentName: string,
): Promise<string[]> {
  const groups = await parseGroupConfigs(vaultRoot);
  const result: string[] = [];
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
export async function resolveFallbackCandidates(
  vaultRoot: string,
  agentName: string,
  allowedAgents: string[],
  excludedAgents: string[],
): Promise<string[]> {
  const groups = await parseGroupConfigs(vaultRoot);
  const allowed = new Set(allowedAgents);
  const excluded = new Set(excludedAgents);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const config of groups.values()) {
    if (!config.agents.includes(agentName)) continue;
    const ordered = config.fallback_order[agentName];
    if (!ordered) continue;
    for (const candidate of ordered) {
      if (candidate === agentName) continue;
      if (excluded.has(candidate)) continue;
      if (!allowed.has(candidate)) continue;
      if (seen.has(candidate)) continue;
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
export async function recommendFallback(
  vaultRoot: string,
  failedAgent: string,
  allowedAgents: string[],
  excludedAgents: string[],
): Promise<FallbackRecommendation[]> {
  const groups = await parseGroupConfigs(vaultRoot);
  const allowed = new Set(allowedAgents);
  const excluded = new Set(excludedAgents);
  const seen = new Set<string>();
  const result: FallbackRecommendation[] = [];

  for (const [groupName, config] of groups) {
    if (!config.agents.includes(failedAgent)) continue;
    const ordered = config.fallback_order[failedAgent];
    if (!ordered) continue;
    for (const candidate of ordered) {
      if (candidate === failedAgent) continue;
      if (!config.agents.includes(candidate)) continue;
      if (excluded.has(candidate)) continue;
      if (!allowed.has(candidate)) continue;
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
