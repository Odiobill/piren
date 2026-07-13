/**
 * Agent group config writer + validator (Slice A, ADR-0028).
 *
 * This module is the *write and validate* counterpart to the read-only parser
 * in `src/agent-groups.ts`. It owns:
 *   - reading/writing `agent-groups/<group>/config.yml` deterministically,
 *   - creating group directories (with the standard `skills/` subdir),
 *   - mutating group membership and fallback order,
 *   - validating all group configs for common drift.
 *
 * The config shape is identical to hand-written configs so `parseGroupConfigs`,
 * `resolveAgentGroups`, `resolveFallbackCandidates`, and `recommendFallback` in
 * `src/agent-groups.ts` observe these files unchanged. This module NEVER changes
 * how `src/agent-groups.ts` parses or resolves groups; it only produces files
 * that the existing parser already understands.
 *
 * Pure core + injected filesystem deps, mirroring the service-lifecycle and
 * agent-manage pattern. Operations throw on misuse (missing group, invalid name,
 * non-member fallback) so the CLI can surface a single clear message and exit.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { join, dirname } from "node:path";
import { readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The modelled group config shape. Mirrors {@link GroupConfig} in
 * `src/agent-groups.ts` but is exported here so writers and the CLI share one
 * definition. `agents` is an ordered list of member names; `fallback_order`
 * maps a member agent to its ordered fallback candidate list.
 */
export interface GroupConfigData {
  agents: string[];
  fallback_order: Record<string, string[]>;
}

/** One directory entry returned by {@link GroupWriteDeps.readdir}. */
export interface GroupDirEntry {
  name: string;
  isDirectory(): boolean;
}

/**
 * Injected filesystem operations. Structurally compatible with the relevant
 * slice of `node:fs/promises` so {@link createRealGroupWriteDeps} is trivial
 * and tests inject a fake filesystem.
 */
export interface GroupWriteDeps {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  /** Rejects (ENOENT-like) when the path does not exist. */
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  /** Returns directory entries; rejects when the path is not a directory. */
  readdir(path: string): Promise<GroupDirEntry[]>;
}

export type ValidationIssueKind =
  | "missing-config"
  | "dangling-fallback"
  | "missing-agent-dir"
  | "duplicate-across-groups";

export interface ValidationIssue {
  group: string;
  kind: ValidationIssueKind;
  severity: "error" | "info";
  message: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Validate a group name for filesystem safety. Rejects empty names, the `.`
 * and `..` traversal aliases, path separators, and leading-dot names (which
 * `parseGroupConfigs` skips as dotfiles, making the group invisible).
 */
export function isValidGroupName(name: string): boolean {
  if (name === "" || name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.startsWith(".")) return false;
  return true;
}

function assertGroupName(name: string): void {
  if (!isValidGroupName(name)) {
    throw new Error(
      `Invalid group name '${name}'. Use a plain name without '.', '..', or path separators.`,
    );
  }
}

function groupConfigPath(vaultRoot: string, group: string): string {
  return join(vaultRoot, "agent-groups", group, "config.yml");
}

/** True if a path exists (file or directory). */
async function pathExists(deps: GroupWriteDeps, path: string): Promise<boolean> {
  try {
    await deps.stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/**
 * Read a group's config. Returns `null` when the group has no `config.yml`
 * (matching `parseGroupConfigs`, which skips directories without a config).
 * Malformed YAML is surfaced as a thrown error naming the group.
 */
export async function readGroupConfig(
  deps: GroupWriteDeps,
  vaultRoot: string,
  group: string,
): Promise<GroupConfigData | null> {
  // Validate before building the path: node:path.join normalizes `..`, so an
  // unchecked group name (e.g. `../../../etc/passwd`) could make the read
  // target escape agent-groups/ and potentially the vault. This single guard
  // covers every consumer (show, add-agent, remove-agent, fallback set,
  // validate) since they all route reads through this function.
  assertGroupName(group);
  const configPath = groupConfigPath(vaultRoot, group);
  let content: string;
  try {
    content = await deps.readFile(configPath);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Malformed config.yml for agent group "${group}": ${detail}`);
  }
  const record = isRecord(parsed) ? parsed : {};
  return {
    agents: asStringArray(record.agents),
    fallback_order: asFallbackOrder(record.fallback_order),
  };
}

/**
 * Serialize a {@link GroupConfigData} to deterministic YAML. Block-style arrays
 * and maps keep the file readable and diff-friendly; the output round-trips
 * through {@link readGroupConfig} and the existing `parseGroupConfigs`.
 */
function serializeGroupConfig(data: GroupConfigData): string {
  return stringifyYaml(data, { sortMapEntries: false });
}

/**
 * Write a group config deterministically. Ensures the group directory exists
 * (idempotent) before writing. The caller is responsible for read-modify-write
 * when preserving unrelated fields; this function writes the full modelled
 * config (`agents` + `fallback_order`).
 */
export async function writeGroupConfig(
  deps: GroupWriteDeps,
  vaultRoot: string,
  group: string,
  data: GroupConfigData,
): Promise<void> {
  assertGroupName(group);
  const configPath = groupConfigPath(vaultRoot, group);
  await deps.mkdir(dirname(configPath), { recursive: true });
  await deps.writeFile(configPath, serializeGroupConfig(data));
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Create a new group: directory, a standard `skills/` subdir, and an empty
 * `config.yml`. Refuses to overwrite an existing group unless `force` is set.
 */
export async function createGroup(
  deps: GroupWriteDeps,
  vaultRoot: string,
  group: string,
  options?: { force?: boolean },
): Promise<void> {
  assertGroupName(group);
  const groupDir = join(vaultRoot, "agent-groups", group);
  if (!options?.force && (await pathExists(deps, groupDir))) {
    throw new Error(
      `Agent group '${group}' already exists at ${groupDir}. Re-run with --force to overwrite its config.`,
    );
  }
  await deps.mkdir(groupDir, { recursive: true });
  await deps.mkdir(join(groupDir, "skills"), { recursive: true });
  await writeGroupConfig(deps, vaultRoot, group, { agents: [], fallback_order: {} });
}

/**
 * Add an agent to a group if not already present. Refuses (throws) if the group
 * does not exist. Returns `{ added: true }` when the agent was newly added, or
 * `{ added: false }` when it was already a member (order preserved).
 */
export async function addAgentToGroup(
  deps: GroupWriteDeps,
  vaultRoot: string,
  group: string,
  agent: string,
): Promise<{ added: boolean }> {
  const current = await readGroupConfig(deps, vaultRoot, group);
  if (current === null) {
    throw new Error(
      `Agent group '${group}' does not exist. Create it first with: piren group create ${group}`,
    );
  }
  if (current.agents.includes(agent)) {
    return { added: false };
  }
  current.agents.push(agent);
  await writeGroupConfig(deps, vaultRoot, group, current);
  return { added: true };
}

/**
 * Remove an agent from a group and prune any fallback_order entries that
 * reference it (both as a key and as a candidate). Refuses (throws) if the
 * group does not exist. Returns whether the agent was removed and whether it
 * was ever a member.
 */
export async function removeAgentFromGroup(
  deps: GroupWriteDeps,
  vaultRoot: string,
  group: string,
  agent: string,
): Promise<{ removed: boolean; existed: boolean }> {
  const current = await readGroupConfig(deps, vaultRoot, group);
  if (current === null) {
    throw new Error(
      `Agent group '${group}' does not exist. Create it first with: piren group create ${group}`,
    );
  }
  const existed = current.agents.includes(agent);
  if (!existed) {
    return { removed: false, existed: false };
  }
  current.agents = current.agents.filter((a) => a !== agent);
  // Drop the agent's own fallback_order entry, and remove it from any list.
  delete current.fallback_order[agent];
  for (const key of Object.keys(current.fallback_order)) {
    current.fallback_order[key] = (current.fallback_order[key] ?? []).filter((c) => c !== agent);
  }
  await writeGroupConfig(deps, vaultRoot, group, current);
  return { removed: true, existed: true };
}

/**
 * Set (create or replace) the fallback_order entry for a member agent. Refuses
 * (throws) if the group does not exist or the agent is not a member of it.
 * Only the named entry is replaced; other entries are preserved.
 */
export async function setFallbackOrder(
  deps: GroupWriteDeps,
  vaultRoot: string,
  group: string,
  agent: string,
  candidates: string[],
): Promise<void> {
  const current = await readGroupConfig(deps, vaultRoot, group);
  if (current === null) {
    throw new Error(
      `Agent group '${group}' does not exist. Create it first with: piren group create ${group}`,
    );
  }
  if (!current.agents.includes(agent)) {
    throw new Error(
      `Agent '${agent}' is not a member of group '${group}'. Add it first with: piren group add-agent ${group} ${agent}`,
    );
  }
  current.fallback_order[agent] = [...candidates];
  await writeGroupConfig(deps, vaultRoot, group, current);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate all group configs under `<vaultRoot>/agent-groups/`. Reports:
 *   - `missing-config`: a group directory without a `config.yml`.
 *   - `dangling-fallback`: a fallback_order entry referencing a non-member agent.
 *   - `missing-agent-dir`: a declared agent with no `team/<agent>/` directory.
 *   - `duplicate-across-groups`: an agent declared in more than one group
 *     (severity `info`, not an error).
 *
 * Reads the real group directories plus `team/` for agent presence. Returns an
 * empty array when `agent-groups/` is missing or empty.
 */
export async function validateGroups(
  deps: GroupWriteDeps,
  vaultRoot: string,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const groupsDir = join(vaultRoot, "agent-groups");

  let entries: GroupDirEntry[];
  try {
    entries = await deps.readdir(groupsDir);
  } catch {
    return [];
  }

  const memberCounts = new Map<string, string[]>();
  const teamAgents = await readTeamAgents(deps, vaultRoot);

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory()) continue;
    const group = entry.name;

    const config = await readGroupConfig(deps, vaultRoot, group);
    if (config === null) {
      issues.push({
        group,
        kind: "missing-config",
        severity: "error",
        message: `Group directory 'agent-groups/${group}/' has no config.yml. Run: piren group create ${group}`,
      });
      continue;
    }

    for (const agent of config.agents) {
      // Track group membership for the duplicate-across-groups check.
      const groups = memberCounts.get(agent) ?? [];
      groups.push(group);
      memberCounts.set(agent, groups);

      if (!teamAgents.includes(agent)) {
        issues.push({
          group,
          kind: "missing-agent-dir",
          severity: "error",
          message: `Agent '${agent}' in group '${group}' has no team/${agent}/ directory.`,
        });
      }
    }

    for (const [agent, candidates] of Object.entries(config.fallback_order)) {
      for (const candidate of candidates) {
        if (!config.agents.includes(candidate)) {
          issues.push({
            group,
            kind: "dangling-fallback",
            severity: "error",
            message: `fallback_order for '${agent}' references '${candidate}' which is not a member of group '${group}'.`,
          });
        }
      }
    }
  }

  for (const [agent, groups] of memberCounts) {
    const unique = [...new Set(groups)];
    if (unique.length > 1) {
      for (const group of unique) {
        issues.push({
          group,
          kind: "duplicate-across-groups",
          severity: "info",
          message: `Agent '${agent}' is declared in ${unique.length} groups: ${unique.join(", ")}.`,
        });
      }
    }
  }

  return issues;
}

/** Return the set of agent names that have a `team/<name>/` directory. */
async function readTeamAgents(deps: GroupWriteDeps, vaultRoot: string): Promise<string[]> {
  try {
    const entries = await deps.readdir(join(vaultRoot, "team"));
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** Entry used by {@link formatGroupList}: a group name plus its parsed config. */
export interface GroupListEntry {
  name: string;
  config: GroupConfigData;
}

/**
 * Render the group list for `piren group list`. One line per group with the
 * member agents (or `<none>`), so the operator can see membership at a glance.
 */
export function formatGroupList(groups: GroupListEntry[]): string {
  const lines: string[] = [];
  if (groups.length === 0) {
    lines.push("Agent groups: <none>");
    lines.push("");
    lines.push("Create one with: piren group create <group>");
    return lines.join("\n");
  }
  lines.push(`Agent groups (${groups.length}):`);
  const nameWidth = Math.max(...groups.map((g) => g.name.length));
  for (const g of groups) {
    const members = g.config.agents.length > 0 ? g.config.agents.join(", ") : "<no agents>";
    lines.push(`  ${g.name.padEnd(nameWidth)}  agents: ${members}`);
  }
  return lines.join("\n");
}

/**
 * Render a single group config as readable YAML for `piren group show <group>`.
 */
export function formatGroupConfig(group: string, config: GroupConfigData): string {
  const lines: string[] = [];
  lines.push(`Group '${group}':`);
  lines.push(serializeGroupConfig(config).trimEnd());
  return lines.join("\n");
}

/**
 * Render a validation report for `piren group validate`. Errors and info notes
 * are grouped by severity, followed by a summary line.
 */
export function formatValidationReport(issues: ValidationIssue[]): string {
  if (issues.length === 0) {
    return "Agent group validation: OK (no issues).";
  }
  const lines: string[] = [];
  lines.push("Agent group validation:");
  const errors = issues.filter((i) => i.severity === "error");
  const infos = issues.filter((i) => i.severity === "info");
  if (errors.length > 0) {
    lines.push("");
    lines.push(`Errors (${errors.length}):`);
    for (const issue of errors) {
      lines.push(`  [${issue.group}] ${issue.message}`);
    }
  }
  if (infos.length > 0) {
    lines.push("");
    lines.push(`Notes (${infos.length}):`);
    for (const issue of infos) {
      lines.push(`  [${issue.group}] ${issue.message}`);
    }
  }
  lines.push("");
  lines.push(`Summary: ${errors.length} error(s), ${infos.length} note(s).`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Real filesystem adapter
// ---------------------------------------------------------------------------

/**
 * Build {@link GroupWriteDeps} backed by the real `node:fs/promises`. The real
 * `readdir` is invoked with `withFileTypes: true` so entries carry
 * `isDirectory()`; real `Dirent` is structurally compatible with
 * {@link GroupDirEntry}.
 */
export function createRealGroupWriteDeps(): GroupWriteDeps {
  return {
    readFile: (p: string) => readFile(p, "utf8"),
    writeFile: (p: string, c: string) => writeFile(p, c, "utf8"),
    mkdir: (p: string, opts?: { recursive?: boolean }) => mkdir(p, opts).then(() => undefined),
    stat: (p: string) => stat(p),
    readdir: (p: string) =>
      readdir(p, { withFileTypes: true }) as unknown as Promise<GroupDirEntry[]>,
  };
}
