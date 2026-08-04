/**
 * Bundled starter-skill seed/doctor core (S3a, accepted S3 contract).
 *
 * Implements the package/vault lifecycle contract from
 * `Projects/Piren/bundled-starter-skills-lifecycle-design.md`: deterministic
 * canonical digests over parsed skill fields (no filename fallback), manifest
 * identity validation bound to the package, a total identity-bound fail-closed
 * doctor classification, a deterministic plan where only `absent` is seedable,
 * and an apply step that creates only absent shared-scope files with the full
 * `template` provenance block. Doctor and dry-run never write.
 *
 * Pure core with injected filesystem deps so every behavior is directly
 * unit-testable without a live install or vault.
 */
export type StarterScope = "shared" | "group" | "agent";
export interface StarterTemplateEntry {
    /** Stable per-template identity (never changes across versions). */
    id: string;
    /** Display/loader name; equals the containing directory and frontmatter name. */
    name: string;
    scope: StarterScope;
    /** Profile-relative template path, e.g. shared/<name>/SKILL.md. */
    source: string;
    /** Canonical content digest of the template file. */
    content_sha256: string;
}
export interface StarterProfileManifest {
    profile: string;
    version: string;
    entries: StarterTemplateEntry[];
}
/** Injected filesystem operations (structurally compatible with node:fs/promises). */
export interface StarterSkillsDeps {
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    mkdir(path: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
    /** True when the path exists (file or directory). */
    exists(path: string): Promise<boolean>;
    /** Returns directory entry names with a directory flag; rejects when absent. */
    readdir(path: string): Promise<{
        name: string;
        isDirectory(): boolean;
    }[]>;
}
export declare function createRealStarterSkillsDeps(): StarterSkillsDeps;
/**
 * Resolve the package-owned starter templates directory from a module
 * location. Source runtime (`src/` via tsx) resolves to `<repo>/templates`;
 * compiled runtime (`dist/src/`) resolves to `<repo>/dist/templates` — both
 * via the same `join(moduleDir, "..", "templates")`, so no discriminator or
 * filesystem probe is needed.
 */
export declare function resolveStarterTemplatesDir(moduleDir: string): string;
/** List available starter-skill profile names under the templates dir. */
export declare function listStarterProfiles(deps: StarterSkillsDeps, templatesDir: string): Promise<string[]>;
export interface ParsedSkillDocument {
    name: string | null;
    description: string | null;
    body: string;
}
/**
 * Parse YAML frontmatter (between leading `---` fences) with exactly the same
 * semantics as `src/skills.ts`: name/description from frontmatter, body after
 * the closing fence with leading blank lines trimmed. Tolerant: no frontmatter
 * or malformed YAML yields null metadata, never a throw.
 */
export declare function parseSkillDocument(content: string): ParsedSkillDocument;
/**
 * Canonical skill content digest: SHA-256 of the fixed-order JSON
 * serialization `{"name","description","body"}`. Independent of frontmatter
 * field order; the provenance block is excluded by construction (only the
 * parsed name/description/body are hashed). There is NO filename fallback.
 */
export declare function canonicalSkillDigest(name: string, description: string, body: string): string;
/**
 * Parse and structurally validate a starter profile manifest. Throws with a
 * clear message on any invalid field (missing profile/version, invalid
 * version/digest, missing/invalid entry fields, source traversal, duplicate
 * ids/names).
 */
export declare function parseStarterManifest(yaml: string): StarterProfileManifest;
/**
 * Validate a parsed manifest against the accepted S3 contract. The initial
 * profile is shared-scope only: any non-shared entry is rejected fail-closed.
 */
export declare function validateStarterManifest(manifest: StarterProfileManifest): void;
export interface ValidatedTemplate {
    entry: StarterTemplateEntry;
    /** Profile-relative template path. */
    path: string;
    name: string;
    description: string;
    body: string;
    digest: string;
}
export interface ProfileValidation {
    profile: string;
    version: string;
    templates: ValidatedTemplate[];
}
/**
 * Load and validate every template of a profile: required non-empty
 * name/description, `type: Skill`, directory name == frontmatter name ==
 * manifest name, digest matches the committed manifest digest. Any failure
 * throws with the exact offending field (a package build error per S3 §2).
 */
export declare function validateProfileTemplates(deps: StarterSkillsDeps, templatesDir: string, manifest: StarterProfileManifest): Promise<ProfileValidation>;
/**
 * Validate the target vault root: it must exist and carry the `.piren-vault`
 * marker. Never creates a missing root (a missing root is a hard rejection,
 * never authoritative state).
 */
export declare function assertVaultRoot(deps: StarterSkillsDeps, vaultRoot: string): Promise<void>;
export interface SkillOccurrence {
    path: string;
    scope: string;
}
/**
 * Find every vault occurrence of a skill name across shared, group, and agent
 * scopes (the loader's precedence layers) without needing a runnable agent.
 */
export declare function findSkillOccurrences(deps: StarterSkillsDeps, vaultRoot: string, name: string): Promise<SkillOccurrence[]>;
export type DoctorState = {
    kind: "absent";
} | {
    kind: "seeded-current";
    path: string;
} | {
    kind: "seeded-outdated-unmodified";
    path: string;
    recordedVersion: string;
} | {
    kind: "user-modified";
    path: string;
} | {
    kind: "provenance-invalid";
    path: string;
    reason: string;
} | {
    kind: "duplicate";
    paths: string[];
    reason: string;
};
export interface DoctorEntry {
    entry: StarterTemplateEntry;
    targetPath: string;
    state: DoctorState;
    /** True when the entry is under a blocking duplicate overlay. */
    duplicateOverlay: boolean;
}
export interface ParsedProvenance {
    id: string;
    profile: string;
    version: string;
    content_sha256: string;
}
/**
 * Classify one expected template entry at its vault path per the total S3 §5
 * precedence: absent / duplicate overlay / provenance gate (identity-bound) /
 * integrity-first current-vs-stale-vs-modified split.
 */
export declare function classifyStarterEntry(deps: StarterSkillsDeps, vaultRoot: string, manifest: StarterProfileManifest, entry: StarterTemplateEntry): Promise<DoctorEntry>;
/** Read-only doctor report: every entry, its state, and duplicate overlays. */
export declare function runStarterDoctor(deps: StarterSkillsDeps, vaultRoot: string, manifest: StarterProfileManifest): Promise<DoctorEntry[]>;
export type SeedPlanAction = "create" | "unchanged" | "conflict";
export interface SeedPlanItem {
    entry: StarterTemplateEntry;
    targetPath: string;
    action: SeedPlanAction;
    state: DoctorState;
}
export interface SeedPlan {
    items: SeedPlanItem[];
    /** True when any duplicate overlay blocks seeding entirely. */
    blockedByDuplicate: boolean;
    /** True when at least one entry is `absent` and no duplicate blocks. */
    canApply: boolean;
}
export declare function planStarterSeed(deps: StarterSkillsDeps, vaultRoot: string, manifest: StarterProfileManifest): Promise<SeedPlan>;
/** Build the seeded copy: template content plus the required template block. */
export declare function buildSeededContent(templateContent: string, provenance: {
    id: string;
    profile: string;
    version: string;
    content_sha256: string;
}): string;
export interface ApplySeedResult {
    created: {
        path: string;
        name: string;
        id: string;
    }[];
    skippedConflicts: {
        path: string;
        name: string;
        state: DoctorState;
    }[];
}
/**
 * Apply the seed plan: create ONLY absent shared-scope target files. Refuses
 * entirely when a duplicate overlay blocks. Never touches conflict files.
 * Re-plans inside apply so the write set is freshly observed.
 */
export declare function applyStarterSeed(deps: StarterSkillsDeps, templatesDir: string, vaultRoot: string, manifest: StarterProfileManifest): Promise<ApplySeedResult>;
