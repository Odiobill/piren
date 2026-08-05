import { type StarterSkillsDeps } from "./starter-skills.js";
export interface InitBaselineOutcome {
    /** True when the mandatory Inbox task lifecycle rule was included in steward-directives.md. */
    directiveIncluded: boolean;
    /** True when skills/piren-inbox-task-lifecycle/SKILL.md was created. */
    skillCreated: boolean;
    /** Deterministic non-secret warning; null when the baseline completed cleanly or was skipped as an existing vault. */
    warning: string | null;
}
export interface InitVaultOptions {
    vaultRoot: string;
    agentName?: string;
    force?: boolean;
    agentConfigContent?: string;
    /** Injected fs seam for the S3 §12 baseline probe/assets/skill (defaults to real fs). */
    baselineDeps?: StarterSkillsDeps;
    /** Package templates dir (defaults to the bundled templates tree via module location). */
    baselineTemplatesDir?: string;
}
export interface InitVaultResult {
    vaultRoot: string;
    agentName: string;
    agentDir: string;
    created: string[];
    /** S3 §12 fresh-vault inbox lifecycle baseline outcome. */
    baseline: InitBaselineOutcome;
}
export declare function initVault(options: InitVaultOptions): Promise<InitVaultResult>;
/**
 * Scaffold a single agent directory (team/<agent>/) inside an EXISTING vault,
 * without re-initializing the vault itself. Used by `piren agent add` so adding
 * a second agent does not trip initVault's "vault file already exists" guard.
 *
 * Creates the same subdirectories and identity files initVault writes for a
 * fresh agent: inbox/outbox/devices/logs/sessions/skills plus cron/jobs and
 * cron/runs (agent-scoped vault-backed cron coordination directories, kept
 * empty on a fresh scaffold), as well as SOUL.md, MEMORY.md, and config.yml.
 * Respects `force` to overwrite identity files.
 */
export declare function scaffoldAgentDirectory(options: InitVaultOptions): Promise<InitVaultResult>;
