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

import { join } from "node:path";
import type { ProfileValidation, StarterProfileManifest, StarterSkillsDeps } from "./starter-skills.js";
import {
  buildSeededContent,
  parseStarterManifest,
  validateProfileTemplates,
} from "./starter-skills.js";

/** Package-owned baseline profile id (S3 §12.4). */
export const BASELINE_PROFILE = "baseline";
/** Stable per-template id and loader name of the single baseline entry. */
export const BASELINE_SKILL_ID = "piren-inbox-task-lifecycle";
export const BASELINE_SKILL_NAME = "piren-inbox-task-lifecycle";

/**
 * The concise, non-negotiable mandatory rule added to the generated
 * `steward-directives.md` for genuinely new vaults (S3 §12.2). The directive
 * is default visible startup policy, NOT a technical enforcement claim; the
 * atomic task claim remains the concurrency boundary. The detailed procedure
 * lives in the `piren-inbox-task-lifecycle` skill, which a lazy-loaded skill
 * alone never enforces.
 */
export const BASELINE_DIRECTIVE_SECTION = `## Inbox task lifecycle (mandatory)

- Never poll an inbox automatically in a direct session.
- When the steward explicitly assigns an inbox task: claim it atomically
  before work, mark it in progress, execute only that claimed task, record
  the Result, and reach its terminal status under the delivery/review
  procedure.
- Directly completed work stays claimed; scheduler R3 completion release is
  scheduler-only. Accepted work is never left pending or in_progress.
- Procedure: skills/piren-inbox-task-lifecycle/SKILL.md
`;

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function isEnoent(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isEeexist(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

/**
 * Preflight outcome for the baseline skill target on a genuinely fresh
 * target (S3 §12.4/§12.6 rework). The baseline is TWO artifacts: a collision
 * on the skill path must create NEITHER (no directive section, no generated
 * skill), so the directive inclusion is decided from the SAME observation
 * that guards the skill write — before either artifact is written.
 */
export type BaselineSkillPreflight = "absent" | "collision" | "unreadable";

/**
 * Deterministic collision preflight: ENOENT -> absent (proceed); file present
 * -> collision (skip both baseline artifacts); any other read error ->
 * unreadable (fail closed, skip both). No raw filesystem error is leaked.
 */
export async function preflightBaselineSkill(
  deps: StarterSkillsDeps,
  vaultRoot: string,
): Promise<BaselineSkillPreflight> {
  try {
    await deps.readFile(join(vaultRoot, "skills", BASELINE_SKILL_NAME, "SKILL.md"));
    return "collision";
  } catch (error) {
    if (isEnoent(error)) return "absent";
    return "unreadable";
  }
}

/**
 * Recognition boundary captured BEFORE init mutates the filesystem (S3
 * §12.5). `deps.exists` is deliberately NOT used because it swallows every
 * error: existence is checked by readFile/readdir so that non-ENOENT failures
 * (unreadable paths, unexpected errors) fail closed as recognized.
 */
export async function probeRecognizedVault(deps: StarterSkillsDeps, vaultRoot: string): Promise<boolean> {
  try {
    try {
      await deps.readFile(join(vaultRoot, ".piren-vault"));
      return true;
    } catch (error) {
      if (!isEnoent(error)) return true;
    }
    try {
      await deps.readFile(join(vaultRoot, "steward-directives.md"));
      return true;
    } catch (error) {
      if (!isEnoent(error)) return true;
    }
    try {
      const teamEntries = await deps.readdir(join(vaultRoot, "team"));
      for (const entry of teamEntries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        try {
          await deps.readFile(join(vaultRoot, "team", entry.name, "SOUL.md"));
          return true;
        } catch (error) {
          if (!isEnoent(error)) return true;
        }
      }
    } catch (error) {
      if (!isEnoent(error)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/** Result of loading the package-owned `baseline` profile. */
export type BaselineAssets =
  | { ok: true; manifest: StarterProfileManifest; validation: ProfileValidation }
  | { ok: false; reason: string };

/**
 * Load and validate the package-owned `baseline` profile (S3 §12.4). Returns
 * a deterministic non-secret reason on failure; a failure skips BOTH baseline
 * artifacts at the init call site (never a partial baseline write).
 */
export async function loadBaselineAssets(
  deps: StarterSkillsDeps,
  templatesDir: string,
): Promise<BaselineAssets> {
  const manifestPath = join(templatesDir, BASELINE_PROFILE, "manifest.yml");
  let manifestYaml: string;
  try {
    manifestYaml = await deps.readFile(manifestPath);
  } catch (error) {
    return {
      ok: false,
      reason: isEnoent(error)
        ? "baseline profile unavailable (missing manifest.yml)"
        : "baseline profile unavailable (manifest.yml unreadable)",
    };
  }

  let manifest: StarterProfileManifest;
  try {
    manifest = parseStarterManifest(manifestYaml);
  } catch (error) {
    return {
      ok: false,
      reason: `baseline manifest invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (manifest.profile !== BASELINE_PROFILE) {
    return {
      ok: false,
      reason: `baseline manifest profile mismatch: expected '${BASELINE_PROFILE}', found '${manifest.profile}'`,
    };
  }

  let validation: ProfileValidation;
  try {
    validation = await validateProfileTemplates(deps, templatesDir, manifest);
  } catch (error) {
    return {
      ok: false,
      reason: `baseline template invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { ok: true, manifest, validation };
}

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
export async function createBaselineSkill(
  deps: StarterSkillsDeps,
  vaultRoot: string,
  assets: Extract<BaselineAssets, { ok: true }>,
): Promise<BaselineSkillResult> {
  const entry = assets.manifest.entries[0];
  if (entry === undefined) {
    return { created: false, warning: "baseline profile has no entries; skill not created" };
  }
  if (entry.id !== BASELINE_SKILL_ID || entry.name !== BASELINE_SKILL_NAME) {
    return { created: false, warning: "baseline profile entry does not match piren-inbox-task-lifecycle; skill not created" };
  }
  const template = assets.validation.templates.find((candidate) => candidate.entry.id === entry.id);
  if (template === undefined) {
    return { created: false, warning: "baseline template body unavailable; skill not created" };
  }

  const targetDir = join(vaultRoot, "skills", entry.name);
  const targetPath = join(targetDir, "SKILL.md");
  try {
    await deps.mkdir(targetDir, { recursive: true });
    const raw = await deps.readFile(template.path);
    const seeded = buildSeededContent(raw, {
      id: entry.id,
      profile: assets.manifest.profile,
      version: assets.manifest.version,
      content_sha256: entry.content_sha256,
    });
    await deps.writeFile(targetPath, seeded, { flag: "wx" });
    return { created: true, warning: null };
  } catch (error) {
    if (isEeexist(error)) {
      return {
        created: false,
        warning: `baseline skill already exists at skills/${entry.name}/SKILL.md; left untouched (no-clobber)`,
      };
    }
    return { created: false, warning: "baseline skill could not be created; left untouched" };
  }
}
