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
    mkdir(path: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
    /** Rejects (ENOENT-like) when the path does not exist. */
    stat(path: string): Promise<{
        isDirectory(): boolean;
    }>;
    /** Returns directory entries; rejects when the path is not a directory. */
    readdir(path: string): Promise<GroupDirEntry[]>;
}
export type ValidationIssueKind = "missing-config" | "dangling-fallback" | "missing-agent-dir" | "duplicate-across-groups";
export interface ValidationIssue {
    group: string;
    kind: ValidationIssueKind;
    severity: "error" | "info";
    message: string;
}
/**
 * Validate a group name for filesystem safety. Rejects empty names, the `.`
 * and `..` traversal aliases, path separators, and leading-dot names (which
 * `parseGroupConfigs` skips as dotfiles, making the group invisible).
 */
export declare function isValidGroupName(name: string): boolean;
/**
 * Read a group's config. Returns `null` when the group has no `config.yml`
 * (matching `parseGroupConfigs`, which skips directories without a config).
 * Malformed YAML is surfaced as a thrown error naming the group.
 */
export declare function readGroupConfig(deps: GroupWriteDeps, vaultRoot: string, group: string): Promise<GroupConfigData | null>;
/**
 * Write a group config deterministically. Ensures the group directory exists
 * (idempotent) before writing. The caller is responsible for read-modify-write
 * when preserving unrelated fields; this function writes the full modelled
 * config (`agents` + `fallback_order`).
 */
export declare function writeGroupConfig(deps: GroupWriteDeps, vaultRoot: string, group: string, data: GroupConfigData): Promise<void>;
/**
 * Create a new group: directory, a standard `skills/` subdir, and an empty
 * `config.yml`. Refuses to overwrite an existing group unless `force` is set.
 */
export declare function createGroup(deps: GroupWriteDeps, vaultRoot: string, group: string, options?: {
    force?: boolean;
}): Promise<void>;
/**
 * Add an agent to a group if not already present. Refuses (throws) if the group
 * does not exist. Returns `{ added: true }` when the agent was newly added, or
 * `{ added: false }` when it was already a member (order preserved).
 */
export declare function addAgentToGroup(deps: GroupWriteDeps, vaultRoot: string, group: string, agent: string): Promise<{
    added: boolean;
}>;
/**
 * Remove an agent from a group and prune any fallback_order entries that
 * reference it (both as a key and as a candidate). Refuses (throws) if the
 * group does not exist. Returns whether the agent was removed and whether it
 * was ever a member.
 */
export declare function removeAgentFromGroup(deps: GroupWriteDeps, vaultRoot: string, group: string, agent: string): Promise<{
    removed: boolean;
    existed: boolean;
}>;
/**
 * Set (create or replace) the fallback_order entry for a member agent. Refuses
 * (throws) if the group does not exist or the agent is not a member of it.
 * Only the named entry is replaced; other entries are preserved.
 */
export declare function setFallbackOrder(deps: GroupWriteDeps, vaultRoot: string, group: string, agent: string, candidates: string[]): Promise<void>;
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
export declare function validateGroups(deps: GroupWriteDeps, vaultRoot: string): Promise<ValidationIssue[]>;
/** Entry used by {@link formatGroupList}: a group name plus its parsed config. */
export interface GroupListEntry {
    name: string;
    config: GroupConfigData;
}
/**
 * Render the group list for `piren group list`. One line per group with the
 * member agents (or `<none>`), so the operator can see membership at a glance.
 */
export declare function formatGroupList(groups: GroupListEntry[]): string;
/**
 * Render a single group config as readable YAML for `piren group show <group>`.
 */
export declare function formatGroupConfig(group: string, config: GroupConfigData): string;
/**
 * Render a validation report for `piren group validate`. Errors and info notes
 * are grouped by severity, followed by a summary line.
 */
export declare function formatValidationReport(issues: ValidationIssue[]): string;
/**
 * Build {@link GroupWriteDeps} backed by the real `node:fs/promises`. The real
 * `readdir` is invoked with `withFileTypes: true` so entries carry
 * `isDirectory()`; real `Dirent` is structurally compatible with
 * {@link GroupDirEntry}.
 */
export declare function createRealGroupWriteDeps(): GroupWriteDeps;
