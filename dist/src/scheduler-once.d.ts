import { type ClaimInboxTaskOptions, type ClaimInboxTaskResult } from "./inbox.js";
import { type ClaimCronJobOptions, type ClaimCronJobResult, type ExecuteScriptCronJobResult } from "./cron.js";
import type { ExecuteClaimedInboxTaskResult, ClaimedInboxTaskRunner } from "./scheduler-executor.js";
import { type ExecuteClaimedAgentCronJobResult } from "./scheduler-cron-executor.js";
import { type SchedulerReleaseTransition } from "./scheduler-release.js";
import { type SchedulerFailureTransition } from "./scheduler-retry.js";
export interface SchedulerOnceOptions {
    configPath?: string;
    deviceId?: string;
    hostname?: string;
    staleAfterMs?: number;
    now?: () => Date;
    /** Bounded execution seams (inbox / agent-cron / script-cron). Required. */
    executors: SchedulerOnceExecutors;
    /** Atomic claim seams. Defaults to the real claimInboxTask/claimCronJob. */
    claims?: SchedulerOnceClaims;
    /**
     * Completion-release seam (ADR-0038 revision 2). Defaults to the real
     * {@link defaultRelease}. Cron jobs are never released through this seam:
     * they restore themselves via `cron_record_run`.
     */
    release?: SchedulerOnceRelease;
    /**
     * Retry failure-transition seam (ADR-0038 R3). Invoked ONLY when a claimed
     * inbox execution returns non-ok with a typed `launch_failure` (revision 3
     * classification); ambiguous and legacy/untyped failures never reach it.
     * Defaults to the real {@link defaultRetryTransition}.
     */
    retryTransition?: SchedulerOnceRetryTransition;
}
export interface InboxExecuteInput {
    agentName: string;
    vaultRoot: string;
    claimedTaskPath: string;
}
export interface CronAgentExecuteInput {
    agentName: string;
    vaultRoot: string;
    claimedJobPath: string;
}
export interface CronScriptExecuteInput {
    agentName: string;
    vaultRoot: string;
    /** Unclaimed job path: executeScriptCronJob claims internally. */
    jobPath: string;
    deviceId: string;
}
export interface SchedulerOnceExecutors {
    executeInboxTask(input: InboxExecuteInput): Promise<ExecuteClaimedInboxTaskResult>;
    executeAgentCronJob(input: CronAgentExecuteInput): Promise<ExecuteClaimedAgentCronJobResult>;
    executeScriptCronJob(input: CronScriptExecuteInput): Promise<ExecuteScriptCronJobResult>;
}
export interface SchedulerOnceClaims {
    claimInboxTask(options: ClaimInboxTaskOptions): Promise<ClaimInboxTaskResult>;
    claimCronJob(options: ClaimCronJobOptions): Promise<ClaimCronJobResult>;
}
/** Real claim functions, used when no fake claims are injected. */
export declare const defaultClaims: SchedulerOnceClaims;
/** Input for the completion-release seam (ADR-0038 revision 2). */
export interface SchedulerOnceReleaseInput {
    agentName: string;
    vaultRoot: string;
    claimedTaskPath: string;
    /** The scheduler's own device id; the release refuses other devices' claims. */
    expectedDeviceId: string;
}
/**
 * Injected completion-release seam. After a successfully executed inbox task,
 * the tick calls this exactly once to release the claimed task back to its
 * ordinary filename so completed prerequisites can satisfy `depends_on`. The
 * production default is {@link defaultRelease}; tests inject a fake so a
 * claimed path need not exist on a real filesystem.
 */
export type SchedulerOnceRelease = (input: SchedulerOnceReleaseInput) => Promise<SchedulerReleaseTransition>;
/** Production release: validated, byte-for-byte, no-clobber (ADR-0038 revision 2). */
export declare const defaultRelease: SchedulerOnceRelease;
/** Input for the retry failure-transition seam (ADR-0038 R3). */
export interface SchedulerOnceRetryTransitionInput {
    agentName: string;
    vaultRoot: string;
    claimedTaskPath: string;
    /**
     * The only failure kind the tick may pass: a typed pre-handoff
     * `launch_failure` (revision 3). Ambiguous outcomes never reach the seam.
     */
    failureKind: "launch_failure";
    /** Tick clock, threaded for deterministic backoff computation. */
    now: () => Date;
}
/**
 * Injected retry failure-transition seam. After a claimed inbox execution
 * fails with a typed `launch_failure`, the tick calls this exactly once to
 * apply the accepted R2 transition (record retry_state + requeue, exhaust, or
 * hold). Tests inject a fake so no real claimed file is required.
 */
export type SchedulerOnceRetryTransition = (input: SchedulerOnceRetryTransitionInput) => Promise<SchedulerFailureTransition>;
/** Production retry transition: the accepted R2 core (ADR-0038). */
export declare const defaultRetryTransition: SchedulerOnceRetryTransition;
export type SchedulerItemType = "inbox_task" | "cron_job";
export type ClaimOutcome = "executed" | "claim_failed" | "execution_failed";
export interface SchedulerOnceClaimAttempt {
    itemType: SchedulerItemType;
    itemPath: string;
    agentName: string;
    outcome: ClaimOutcome;
    reason?: string;
}
export interface SchedulerOnceResult {
    deviceId: string;
    enabledAgents: string[];
    plannedCount: number;
    claimAttempts: SchedulerOnceClaimAttempt[];
    executed: boolean;
    executedItemType?: SchedulerItemType;
    executedItemPath?: string;
    executedAgentName?: string;
    executionStatus?: string;
    executionSummary?: string;
    /** Completion-release outcome for a successfully executed inbox task. */
    releaseStatus?: "released" | "held";
    /** Exact reason when the release was held (task remains claimed for triage). */
    releaseReason?: string;
    /** Retry-transition outcome for a typed launch_failure (ADR-0038 R3). */
    retryStatus?: "requeued" | "exhausted" | "held";
    /** Exact reason when the retry transition was exhausted or held. */
    retryReason?: string;
    noWork: boolean;
    summary: string;
}
/**
 * Normalize a raw hostname (e.g. os.hostname()) into a safe Piren device id.
 *
 * Lowercase, replace runs of non-alphanumeric characters with a single
 * hyphen, trim leading/trailing hyphens, prefix `device-` if the result
 * starts with a digit, and fall back to `local-device` if empty. The result
 * always matches the device-id validator `/^[a-z][a-z0-9-]*$/` used by
 * registerDevice / claimInboxTask / claimCronJob.
 *
 * Deterministic and pure so the default scheduler device id is stable across
 * runs on the same host. Applied only when no explicit deviceId is provided.
 */
export declare function sanitizeDeviceId(raw: string): string;
/**
 * Run one scheduler tick and execute at most one successfully claimed work
 * item. See module docstring for the full flow.
 */
export declare function schedulerOnce(options: SchedulerOnceOptions): Promise<SchedulerOnceResult>;
export interface CreateSchedulerExecutorsOptions {
    /** Shared bounded-agent runner (production: createAskRunner()). */
    runner: ClaimedInboxTaskRunner;
    now?: () => Date;
    scriptTimeoutMs?: number;
}
/**
 * Build the production {@link SchedulerOnceExecutors} from a shared bounded
 * agent runner. Inbox and agent-mode cron runs go through the S2/S3 executors
 * with that runner; script-mode cron delegates to the existing direct
 * `executeScriptCronJob` (claim-first, LLM-free). The vault root and device id
 * are threaded from each tick call via the executor inputs, so the validated
 * vault boundary is preserved end to end.
 */
export declare function createSchedulerExecutors(options: CreateSchedulerExecutorsOptions): SchedulerOnceExecutors;
