/**
 * S3 §12 fresh-init inbox lifecycle baseline — package-owned `baseline`
 * starter profile wiring for `piren init`.
 *
 * This module is the small injectable/testable seam for the two new-vault
 * baseline artifacts: the mandatory "Inbox task lifecycle" rule in the
 * generated `steward-directives.md` and the shared
 * `piren-inbox-task-lifecycle` skill. Every filesystem access goes through the
 * injected `StarterSkillsDeps` seam, so the recognition probe, asset loading,
 * and skill creation are directly unit-testable without Pi auth or a real
 * filesystem. It is pure: no configuration, no hidden state, no network.
 *
 * Recognition boundary (S3 §12.5): a target is a recognized existing Piren
 * vault when ANY of `.piren-vault`, root `steward-directives.md`, or
 * `team/<agent>/SOUL.md` exists. The probe is fail-closed: an unreadable or
 * unexpected error counts as recognized (baseline is not created), while a
 * normal absent path (ENOENT) still permits a genuinely fresh target.
 */
import type { ProfileValidation, StarterProfileManifest, StarterSkillsDeps } from "./starter-skills.js";
/** Package-owned baseline profile id (S3 §12.4). */
export declare const BASELINE_PROFILE = "baseline";
/** Stable per-template id and loader name of the single baseline entry. */
export declare const BASELINE_SKILL_ID = "piren-inbox-task-lifecycle";
export declare const BASELINE_SKILL_NAME = "piren-inbox-task-lifecycle";
/**
 * The concise, non-negotiable mandatory rule added to the generated
 * `steward-directives.md` for genuinely new vaults (S3 §12.2). The directive
 * is default visible startup policy, NOT a technical enforcement claim; the
 * atomic task claim remains the concurrency boundary. The detailed procedure
 * lives in the `piren-inbox-task-lifecycle` skill, which a lazy-loaded skill
 * alone never enforces.
 */
export declare const BASELINE_DIRECTIVE_SECTION = "## Inbox task lifecycle (mandatory)\n\n- Never poll an inbox automatically in a direct session.\n- When the steward explicitly assigns an inbox task: claim it atomically\n  before work, mark it in progress, execute only that claimed task, record\n  the Result, and reach its terminal status under the delivery/review\n  procedure.\n- Directly completed work stays claimed; scheduler R3 completion release is\n  scheduler-only. Accepted work is never left pending or in_progress.\n- Procedure: skills/piren-inbox-task-lifecycle/SKILL.md\n";
/**
 * Recognition boundary captured BEFORE init mutates the filesystem (S3
 * §12.5). `deps.exists` is deliberately NOT used because it swallows every
 * error: existence is checked by readFile/readdir so that non-ENOENT failures
 * (unreadable paths, unexpected errors) fail closed as recognized.
 */
export declare function probeRecognizedVault(deps: StarterSkillsDeps, vaultRoot: string): Promise<boolean>;
/** Result of loading the package-owned `baseline` profile. */
export type BaselineAssets = {
    ok: true;
    manifest: StarterProfileManifest;
    validation: ProfileValidation;
} | {
    ok: false;
    reason: string;
};
/**
 * Load and validate the package-owned `baseline` profile (S3 §12.4). Returns
 * a deterministic non-secret reason on failure; a failure skips BOTH baseline
 * artifacts at the init call site (never a partial baseline write).
 */
export declare function loadBaselineAssets(deps: StarterSkillsDeps, templatesDir: string): Promise<BaselineAssets>;
/** Outcome of creating the baseline skill file. */
export interface BaselineSkillResult {
    created: boolean;
    /** Deterministic non-secret warning when the skill could not be created. */
    warning: string | null;
}
/**
 * Create `skills/<name>/SKILL.md` with the full manifest-derived
 * `template: { id, profile, version, content_sha256 }` provenance block (S3
 * §12.4). Dedicated no-clobber (`wx`) independent of `--force`: an existing
 * file is never overwritten or deleted; a collision yields a deterministic
 * warning. Every expected failure returns `{created: false}` with a
 * deterministic non-secret reason — it never throws.
 */
export declare function createBaselineSkill(deps: StarterSkillsDeps, vaultRoot: string, assets: Extract<BaselineAssets, {
    ok: true;
}>): Promise<BaselineSkillResult>;
