import { type CronRunStatus } from "./cron.js";
export interface BuildClaimedCronJobPromptOptions {
    agentName: string;
    jobId: string;
    /** Vault-relative claimed cron job path. */
    claimedJobPath: string;
    /** Cron prompt/body parsed from the job file. */
    cronPrompt: string;
}
/**
 * Build the bounded prompt for executing one already-claimed agent-mode cron
 * job.
 *
 * Includes the exact claimed cron job path, the job id, and the cron prompt to
 * execute. Instructs the agent to execute only this cron job and stop, and
 * forbids polling (`cron_list`/`inbox_list`), claiming (`cron_claim`/
 * `task_claim`), calling `cron_record_run` (the scheduler records the run),
 * cross-agent fallback/rerouting, and long-running loops.
 */
export declare function buildClaimedCronJobPrompt(options: BuildClaimedCronJobPromptOptions): string;
export interface ClaimedCronJobPathInfo {
    /** "shared" for cron/jobs/ or the agent name for team/<agent>/cron/jobs/. */
    scope: string;
    /** The selected agent name (validated against the input). */
    agentName: string;
    /** Device id parsed from the .claimed.<device-id>.md suffix. */
    deviceId: string;
    /** Job id (filename stem without the claimed suffix). */
    jobId: string;
    /** Restored (unclaimed) file name, e.g. "nightly-digest.md". */
    fileName: string;
    /** The validated vault-relative claimed cron job path. */
    claimedJobPath: string;
}
export interface ParseClaimedCronJobPathOptions {
    vaultRoot: string;
    agentName: string;
    claimedJobPath: string;
}
/**
 * Parse and validate a claimed agent-mode cron job path.
 *
 * Accepts exactly:
 *   - `cron/jobs/<job>.claimed.<device-id>.md` (shared), or
 *   - `team/<agentName>/cron/jobs/<job>.claimed.<device-id>.md` (scoped).
 *
 * Throws on absolute paths (including absolute paths inside the vault),
 * traversal/outside-vault paths, unclaimed paths, non-cron paths, and
 * team-scoped paths belonging to a different agent.
 */
export declare function parseClaimedCronJobPath(options: ParseClaimedCronJobPathOptions): ClaimedCronJobPathInfo;
export interface ClaimedCronJobRunInput {
    agentName: string;
    vaultRoot: string;
    prompt: string;
}
export interface ClaimedCronJobRunnerResult {
    assistantText: string;
    /** 0 = success, non-zero = failure. Drives the recorded run status. */
    exitCode: number;
}
export interface ClaimedCronJobRunner {
    run(input: ClaimedCronJobRunInput): Promise<ClaimedCronJobRunnerResult>;
}
export interface ExecuteClaimedAgentCronJobOptions {
    vaultRoot: string;
    agentName: string;
    claimedJobPath: string;
    runner: ClaimedCronJobRunner;
    now?: () => Date;
}
export interface ExecuteClaimedAgentCronJobResult {
    agentName: string;
    deviceId: string;
    jobId: string;
    claimedJobPath: string;
    restoredJobPath: string;
    runRecordPath: string;
    status: CronRunStatus;
    exitCode: number;
    assistantText: string;
    ok: boolean;
    /** Error summary when the runner threw; absent on success. */
    error?: string;
}
/**
 * Execute exactly one already-claimed agent-mode cron job.
 *
 * The claimed job path is validated first; if it is rejected the runner is
 * never called and no run is recorded. The job is then read with the existing
 * cron parser and must be in `agent` mode with a frontmatter `agent` matching
 * `agentName`; script-mode jobs and agent mismatches are refused before any
 * runner call (script-mode belongs to `executeScriptCronJob`).
 *
 * The spawned agent is instructed NOT to call `cron_record_run`; this function
 * records exactly one visible run through `recordCronRun` after the runner
 * returns or throws. `recordCronRun` also restores the job from claimed to
 * unclaimed on both success and failure. Runner failures (thrown errors or
 * non-zero exit codes) are recorded as `failed` runs, not rethrown.
 */
export declare function executeClaimedAgentCronJob(options: ExecuteClaimedAgentCronJobOptions): Promise<ExecuteClaimedAgentCronJobResult>;
