/**
 * Skill CLI foundation core (Slice D).
 *
 * Pure core with injected filesystem deps for skill discovery, creation,
 * movement, promotion, demotion, conflict detection, and validation.
 * Reuses parsing helpers from src/skills.ts where possible (frontmatter
 * parsing), but never changes the loader's precedence or behavior.
 */
/** Injected filesystem operations, structurally compatible with node:fs/promises. */
export interface SkillCliDeps {
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    mkdir(path: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
    stat(path: string): Promise<{
        isDirectory(): boolean;
    }>;
    readdir(path: string): Promise<{
        name: string;
        isDirectory(): boolean;
        isFile(): boolean;
    }[]>;
    rename(oldPath: string, newPath: string): Promise<void>;
    unlink(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    access(path: string): Promise<void>;
}
export type SkillSource = "shared" | "group" | "agent";
export interface ScannedSkill {
    name: string;
    description: string;
    body: string;
    source: SkillSource;
    /** Scope identifier: "shared", group name, or agent name. */
    scope: string;
    /** Vault-relative path. */
    path: string;
    /** Whether this is a directory-based skill (SKILL.md inside a dir). */
    isDirectory: boolean;
}
export interface SkillListOptions {
    agent?: string;
    group?: string;
    scope?: SkillSource;
}
export interface SkillExplainResult {
    effective: ScannedSkill;
    shadowed: ScannedSkill[];
}
export interface SkillConflict {
    name: string;
    entries: {
        source: SkillSource;
        scope: string;
        path: string;
    }[];
}
export interface SkillValidationIssue {
    kind: "missing-type" | "unparseable-frontmatter" | "missing-frontmatter";
    path: string;
    message: string;
}
export interface CreateSkillOptions {
    force?: boolean;
}
export interface MoveSkillOptions {
    force?: boolean;
}
/**
 * Parsed scope from `--scope shared|group:<name>|agent:<name>`.
 */
export interface ParsedScope {
    kind: SkillSource;
    group?: string;
    agent?: string;
}
/**
 * Validate a skill name for use in file paths and YAML frontmatter.
 * Rejects: empty, ".", "..", path separators, and YAML-unsafe characters
 * (colons, tabs, newlines, and other control characters).
 *
 * The name must match: start with alphanumeric, then alphanumeric,
 * space, underscore, or dash only. This is strict enough to prevent
 * path traversal and YAML breakage while allowing readable names.
 */
export declare function isValidSkillName(name: string): boolean;
/** Parse a scope string like "shared", "group:devs", "agent:dipu". */
export declare function parseScope(raw: string): ParsedScope | null;
/** Format a parsed scope back to its string representation. */
export declare function formatScope(scope: ParsedScope): string;
/**
 * Resolve the vault-relative path for a skill with a given name and scope.
 * For directory-based skills (detected by existence), the path resolves to
 * `<dir>/SKILL.md`. By default we target a loose `.md` file.
 */
export declare function resolveSkillPath(vaultRoot: string, name: string, scope: ParsedScope): {
    absolutePath: string;
    vaultRelativePath: string;
};
/**
 * Assert that an absolute path stays within the vault root. Normalizes both
 * paths and checks that the target is a descendant of (or equal to) the root.
 * Throws on any escape attempt (traversal, absolute path outside root).
 */
export declare function assertPathWithinVault(vaultRoot: string, absolutePath: string): void;
/**
 * Verify that a parsed scope target exists in the vault:
 * - shared: always valid.
 * - group: requires agent-groups/<group>/config.yml.
 * - agent: requires team/<agent>/SOUL.md.
 */
export declare function assertScopeExists(deps: SkillCliDeps, vaultRoot: string, scope: ParsedScope): Promise<void>;
/**
 * Scan ALL skills in the vault: shared, all groups, and all agents.
 * Returns a flat list with full scope annotation.
 */
export declare function scanAllSkills(deps: SkillCliDeps, vaultRoot: string): Promise<ScannedSkill[]>;
/**
 * Get the effective skill set for an agent, respecting precedence:
 * shared < group < agent. Returns skills sorted by name.
 */
export declare function resolveEffectiveSkills(deps: SkillCliDeps, vaultRoot: string, agent: string): Promise<ScannedSkill[]>;
/**
 * Filter a scanned skill list by options.
 * - `agent`: show effective skills for that agent (using precedence).
 * - `group`: show skills scoped to that specific group.
 * - `scope`: show skills only from that source type.
 */
export declare function filterSkills(deps: SkillCliDeps, vaultRoot: string, all: ScannedSkill[], opts: SkillListOptions): Promise<ScannedSkill[]>;
export interface SkillShowResult {
    skill: ScannedSkill;
}
/**
 * Show the full body of one skill, resolved with agent precedence.
 * Returns null if the skill is not found.
 */
export declare function showSkill(deps: SkillCliDeps, vaultRoot: string, name: string, agent?: string): Promise<SkillShowResult | null>;
/**
 * Explain provenance: which scope provides the effective copy, and which
 * lower-precedence copies are shadowed.
 */
export declare function explainSkill(deps: SkillCliDeps, vaultRoot: string, name: string, agent: string): Promise<SkillExplainResult | null>;
/**
 * Create a new skill file with frontmatter at the correct vault path.
 * Refuses to overwrite an existing skill without --force.
 */
export declare function createSkill(deps: SkillCliDeps, vaultRoot: string, name: string, scope: ParsedScope, opts?: CreateSkillOptions): Promise<{
    path: string;
}>;
/**
 * Move a skill file from one scope to another. Preserves frontmatter and body.
 * Refuses to overwrite the target without --force.
 */
export declare function moveSkill(deps: SkillCliDeps, vaultRoot: string, name: string, from: ParsedScope, to: ParsedScope, opts?: MoveSkillOptions): Promise<{
    fromPath: string;
    toPath: string;
}>;
export declare function promoteSkill(deps: SkillCliDeps, vaultRoot: string, name: string, fromAgent: string, to: "shared" | {
    kind: "group";
    group: string;
}, opts?: MoveSkillOptions): Promise<{
    fromPath: string;
    toPath: string;
}>;
export declare function demoteSkill(deps: SkillCliDeps, vaultRoot: string, name: string, from: "shared" | {
    kind: "group";
    group: string;
}, toAgent: string, opts?: MoveSkillOptions): Promise<{
    fromPath: string;
    toPath: string;
}>;
/**
 * Report same-name skills that exist in multiple scopes, creating
 * shadowing. When agent is provided, only reports conflicts for scopes
 * visible to that agent.
 */
export declare function listConflicts(deps: SkillCliDeps, vaultRoot: string, agent?: string): Promise<SkillConflict[]>;
/**
 * Validate all skill files for OKF frontmatter conformance.
 * Reports missing/empty type fields, unparseable frontmatter, and files
 * without frontmatter.
 */
export declare function validateSkills(deps: SkillCliDeps, vaultRoot: string): Promise<SkillValidationIssue[]>;
/** Format a scanned skill list as a compact table. */
export declare function formatSkillList(skills: ScannedSkill[]): string;
/** Format a single skill's full body. */
export declare function formatSkillShow(result: SkillShowResult): string;
/** Format the explain result: effective + shadowed. */
export declare function formatSkillExplain(result: SkillExplainResult): string;
/** Format conflicts report. */
export declare function formatSkillConflicts(conflicts: SkillConflict[]): string;
/** Format validation issues. */
export declare function formatSkillValidation(issues: SkillValidationIssue[]): string;
export declare function createRealSkillCliDeps(): SkillCliDeps;
