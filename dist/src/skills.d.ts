/** Where a skill was discovered: shared (vault/skills/), group (agent-groups/<group>/skills/), or agent (team/<agent>/skills/). */
export type SkillSource = "shared" | "group" | "agent";
/**
 * A single loaded skill. Skills are procedures (Markdown context the agent can
 * follow), not executable tools. They are injected into the agent's context
 * prompt so the agent knows they exist and can apply them when relevant.
 */
export interface VaultSkill {
    /** Skill name, from frontmatter `name` or derived from the filename. */
    name: string;
    /** One-line description from frontmatter `description`. May be empty. */
    description: string;
    /** Full Markdown body (everything after the frontmatter). */
    body: string;
    /** Where the skill was loaded from. */
    source: SkillSource;
    /** Vault-relative path to the skill file. */
    path: string;
}
export interface LoadVaultSkillsResult {
    skills: VaultSkill[];
}
/**
 * Load skills from the vault for a given agent.
 *
 * Shared skills come from `vault/skills/` (available to all agents).
 * Optional group-scoped skills (ADR-0028) come from
 * `agent-groups/<group>/skills/` for each group the agent belongs to, in the
 * order the groups are passed. Later groups override earlier groups for
 * same-name skills.
 * Agent-specific skills come from `team/<agent>/skills/` (available only to
 * that agent). Agent-specific skills override shared and group skills with
 * the same name.
 *
 * When `groups` is omitted or empty, behavior is unchanged: only shared and
 * agent-local skills are loaded (backward compatible).
 *
 * Skills are Markdown files with optional YAML frontmatter (`name`,
 * `description`) and a body. A directory containing `SKILL.md` is also a
 * skill. The loader is tolerant: a missing skills directory returns an empty
 * list, and malformed frontmatter does not crash loading (the skill is
 * included with a derived name and empty description).
 *
 * See ADR-0014 and ADR-0028 for the full design.
 */
export declare function loadVaultSkills(vaultRoot: string, agentName: string, groups?: string[]): Promise<LoadVaultSkillsResult>;
/**
 * Format the loaded skills as a compact context-prompt catalog. This is the
 * ADR-0017 lazy-loading startup shape: names and metadata only, never full
 * skill bodies.
 */
export declare function formatSkillCatalogForContext(skills: VaultSkill[]): string;
