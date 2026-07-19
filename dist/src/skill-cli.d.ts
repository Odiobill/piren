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
/**
 * Deterministic staged-import directory, relative to the vault root. It lives
 * under the established `skill-candidates/` convention (already inactive) in an
 * `imports/` sub-area that is dedicated to imported-but-unpromoted skills.
 */
export declare const STAGED_SKILL_DIR_REL = "skill-candidates/imports";
/** Filename slug pattern for staged imports (lowercase, no spaces). */
export declare const STAGED_SKILL_NAME_PATTERN: RegExp;
/** A staged (inactive, imported) skill document read back from the vault. */
export interface StagedSkill {
    name: string;
    description: string;
    /** Local source path recorded at import time. */
    source: string;
    /** ISO timestamp recorded at import time. */
    importedAt: string;
    /** SHA-256 hex of the original source content recorded at import time. */
    checksum: string;
    /** Whether the document carries the `staged: true` marker. */
    staged: boolean;
    /** Full Markdown body after the frontmatter. */
    body: string;
    /** Vault-relative path to the staged document. */
    path: string;
}
export interface ImportStagedSkillOptions {
    /** SHA-256 hex digest of the original source content. Injected for tests. */
    checksum: (content: string) => string;
    /** Optional explicit staged name (validated strictly; not slugified). */
    name?: string;
    /** Clock for the recorded `imported_at`; defaults to real time in the CLI. */
    now?: () => Date;
    /** Allow re-importing over an existing staged skill of the same name. */
    force?: boolean;
}
export interface ImportStagedSkillResult {
    name: string;
    /** Vault-relative path of the written staged document. */
    path: string;
    /** Local source path that was imported. */
    source: string;
    /** SHA-256 hex of the original source content. */
    checksum: string;
    /** ISO timestamp recorded as `imported_at`. */
    importedAt: string;
    /** True if a staged skill of the same name was overwritten. */
    overwritten: boolean;
}
/**
 * Derive a lowercase filename slug from arbitrary input (typically a source
 * filename stem). Returns the empty string when the input cannot be slugified
 * into a valid staged name, so callers can require an explicit `--name`.
 */
export declare function slugifyStagedSkillName(input: string): string;
/** Validate a staged skill name: lowercase slug, no traversal, no separators. */
export declare function isValidStagedSkillName(name: string): boolean;
/** Resolve the deterministic inactive path for a staged skill of `name`. */
export declare function resolveStagedSkillPath(vaultRoot: string, name: string): {
    absolutePath: string;
    vaultRelativePath: string;
};
/**
 * Import a local skill Markdown file into the inactive staged review area.
 *
 * The source content is read by the caller (CLI adapter) and passed in, so the
 * core never touches the local filesystem outside the vault. The core:
 *   - requires a `.md` source,
 *   - resolves the staged name from an explicit validated `--name` or a slug
 *     derived from the source filename stem,
 *   - normalizes frontmatter to OKF `type: Skill` while preserving the body,
 *   - records source path, import time, and content checksum as provenance,
 *   - refuses to overwrite an existing staged skill unless `force` is set.
 *
 * The destination is always under `skill-candidates/imports/`, which no active
 * skill-loading path scans.
 */
export declare function importStagedSkill(deps: SkillCliDeps, vaultRoot: string, sourcePath: string, sourceContent: string, opts: ImportStagedSkillOptions): Promise<ImportStagedSkillResult>;
export interface PromoteStagedSkillResult {
    name: string;
    /** Vault-relative path of the staged source that was removed. */
    fromPath: string;
    /** Vault-relative path of the active destination. */
    toPath: string;
    /** Active scope the skill was promoted into. */
    toScope: ParsedScope;
    /** True if an existing active skill was overwritten (`--force`). */
    overwritten: boolean;
    /** Set when the promotion committed but a transaction artifact could not be
     * cleaned up. The promotion succeeded; the named artifact remains as
     * recovery evidence and is protected from later overwrite. */
    cleanupWarning?: string;
}
/**
 * Promote exactly one E1 staged skill (`skill-candidates/imports/<name>.md`)
 * into an existing active shared/group/agent scope.
 *
 * The staged name is validated before any path resolution or filesystem
 * access. The target scope is validated with the established scope-existence
 * rules. Target collisions are refused unless `force` is set. All validation
 * and collision checks happen before any write.
 *
 * The promotion is transactional and rollback-safe: any pre-existing
 * transaction artifact (`.<name>.promote.bak`/`.promote.tmp`, recovery evidence
 * from a previous interrupted promotion) is refused before any mutation and is
 * never overwritten. The original target (when present) is moved aside to a
 * backup, the promoted content is committed via a temp file plus an atomic
 * rename (the target is never torn), and only then is the staged source
 * removed. If staged removal fails, the target is rolled back to its original
 * state (backup restored, or the just-created target removed), so a failed
 * promotion retains both the staged artifact and the original target and
 * leaves no partial activation. If rollback itself cannot complete, an explicit
 * error names the surviving artifacts instead of concealing the partial state.
 * If the backup cannot be discarded after a successful promotion, the result
 * carries a `cleanupWarning` naming the leftover artifact (it is protected from
 * later overwrite by the pre-flight check) instead of silently claiming success.
 *
 * On success the promoted document keeps `type: Skill`, the original body, and
 * the imported provenance (`source`, `imported_at`, `checksum`), drops the
 * lifecycle-only `staged: true` marker, and the staged source is removed. The
 * destination is a normal active skill file, discovered by the regular loader.
 */
export declare function promoteStagedSkill(deps: SkillCliDeps, vaultRoot: string, name: string, scope: ParsedScope, opts?: {
    force?: boolean;
}): Promise<PromoteStagedSkillResult>;
/**
 * List staged skill documents deterministically (sorted by name). Returns an
 * empty list when the staged area does not exist. Tolerant of malformed
 * frontmatter: the name falls back to the filename stem.
 */
export declare function listStagedSkills(deps: SkillCliDeps, vaultRoot: string): Promise<StagedSkill[]>;
/** Show a single staged skill by resolved name; null when not found. */
export declare function showStagedSkill(deps: SkillCliDeps, vaultRoot: string, name: string): Promise<StagedSkill | null>;
/** Format a staged skill list deterministically (sorted, provenance per entry). */
export declare function formatStagedSkillList(skills: StagedSkill[]): string;
/** Format a single staged skill with full provenance and body. */
export declare function formatStagedSkillShow(skill: StagedSkill): string;
/** Real SHA-256 hex digest for staged-import provenance. */
export declare function realSha256(content: string): string;
export declare function createRealSkillCliDeps(): SkillCliDeps;
