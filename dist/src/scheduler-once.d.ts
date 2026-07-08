import { type ClaimInboxTaskOptions, type ClaimInboxTaskResult } from "./inbox.js";
import { type ClaimCronJobOptions, type ClaimCronJobResult, type ExecuteScriptCronJobResult } from "./cron.js";
import type { ExecuteClaimedInboxTaskResult, ClaimedInboxTaskRunner } from "./scheduler-executor.js";
import { type ExecuteClaimedAgentCronJobResult } from "./scheduler-cron-executor.js";
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
