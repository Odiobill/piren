/**
 * Vault-backed cron (ADR-0019).
 *
 * Core scheduling logic, separated from Pi adaptation. This module is
 * callable directly from tests with a fake filesystem. Schedules are
 * deliberately boring: five-field cron strings (minute granularity) or
 * simple interval syntax. No exactly-once guarantees, no central DB.
 */
export type CronScheduleKind = "cron" | "interval";
export interface CronSchedule {
    raw: string;
    kind: CronScheduleKind;
    /** Human-readable, stable rendering used for both describe() and logs. */
    describe(): string;
}
/**
 * Milliseconds for an interval schedule. Returns undefined for cron schedules.
 */
export declare function intervalMs(schedule: CronSchedule): number | undefined;
export interface IsScheduleDueOptions {
    schedule: CronSchedule;
    now: Date;
    /** Previous successful/recorded run. When absent, the job is due immediately. */
    lastRun?: Date;
}
/**
 * Whether a job is due at `now`, given its schedule and last run time.
 *
 * Interval schedules are due when (now - lastRun) >= interval, or immediately
 * when there is no last run. Cron schedules are due when the cron expression
 * matches `now` AND either there is no last run or the last run was strictly
 * before the current minute (so a job that already ran in the current minute
 * is not re-triggered within the same minute).
 */
export declare function isScheduleDue(options: IsScheduleDueOptions): boolean;
/**
 * Parse a schedule expression into a CronSchedule.
 *
 * Accepted forms:
 *   - Five-field cron string: "m h dom mon dow", each field a number or "*".
 *     Example: "0 7 * * *" (daily at 07:00).
 *   - Interval: "<n><unit>" where unit is s/m/h/d.
 *     Example: "30m" (every 30 minutes), "6h" (every 6 hours), "1d" (daily).
 *
 * The parser is intentionally minimal and strict: it rejects shapes it does
 * not understand rather than guessing. This is the RC scope decision from
 * ADR-0019 ("simple schedules, either cron strings or interval syntax").
 */
export declare function parseSchedule(raw: string): CronSchedule;
export type CronDevicePolicyMode = "highest_priority";
export interface CronDevicePolicy {
    mode: CronDevicePolicyMode;
    allowedDevices: string[];
}
export type CronJobMode = "agent" | "script";
export interface CronJob {
    /** Vault-relative path, e.g. "cron/jobs/nightly-digest.md". */
    path: string;
    absolutePath: string;
    /** "shared" for cron/jobs/ or the agent name for team/<agent>/cron/jobs/. */
    scope: string;
    id: string;
    agent: string;
    schedule: CronSchedule;
    enabled: boolean;
    mode: CronJobMode;
    /** Prompt for agent mode, documentation/purpose text for script mode. */
    prompt: string;
    /** Vault-relative executable script path when mode is "script". */
    script?: string;
    devicePolicy: CronDevicePolicy;
    staleAfterSeconds?: number;
    /** Last recorded run ISO timestamp, parsed from frontmatter if present. */
    lastRun?: Date;
    /** Device id that claimed the most recent run, if recorded in frontmatter. */
    lastClaimedBy?: string;
}
export interface ReadCronJobOptions {
    vaultRoot: string;
    /** Vault-relative path to the job Markdown file. */
    path: string;
    now?: () => Date;
}
export declare function readCronJob(options: ReadCronJobOptions): Promise<CronJob>;
export interface ListCronJobsOptions {
    vaultRoot: string;
    agentName: string;
    now?: () => Date;
}
export interface ListCronJobsResult {
    agentName: string;
    jobs: CronJob[];
}
/**
 * An active, heartbeat-fresh device eligible to run cron jobs. Priority is
 * numeric and lower means higher priority, mirroring devices.ts (default 10).
 */
export interface ActiveDevice {
    deviceId: string;
    priority: number;
}
export interface SelectOwningDeviceOptions {
    devicePolicy: CronDevicePolicy;
    activeDevices: ActiveDevice[];
    deviceId: string;
}
export interface SelectOwningDeviceResult {
    owns: boolean;
    /** The device that owns the job among eligible active devices. */
    owner: string;
    /** Devices considered eligible after applying allowed_devices. */
    eligible: ActiveDevice[];
}
/**
 * Decide whether the current device owns a job under active-device-priority
 * selection (ADR-0019). Eligibility is restricted to active devices whose id
 * appears in device_policy.allowed_devices when that list is non-empty. Among
 * eligible devices, the highest-priority (lowest number) one owns the job.
 *
 * Pure: takes the already-filtered active device list, so callers read device
 * heartbeats once and pass the fresh set in.
 */
export declare function selectOwningDevice(options: SelectOwningDeviceOptions): SelectOwningDeviceResult;
export interface ListActiveDevicesOptions {
    vaultRoot: string;
    agentName: string;
    /** A device whose heartbeat is older than now - staleAfterMs is stale. */
    staleAfterMs: number;
    now?: () => Date;
}
export interface ListActiveDevicesResult {
    agentName: string;
    devices: ActiveDevice[];
}
/**
 * Read device heartbeat records from team/<agent>/devices/*.json and return
 * the active, non-stale devices. Reuses the same JSON format and staleness
 * principle as inbox task claiming: a device whose last_seen is older than
 * now - staleAfterMs is considered stale and excluded. Malformed or partial
 * records are skipped, not fatal.
 */
export declare function listActiveDevices(options: ListActiveDevicesOptions): Promise<ListActiveDevicesResult>;
export interface ClaimCronJobOptions {
    vaultRoot: string;
    /** Vault-relative path to the job file (claimed or unclaimed). */
    jobPath: string;
    deviceId: string;
    /** Agent whose device heartbeats are consulted for stale-claim recovery. */
    agentName: string;
    /** When set and the job is already claimed, allow reclaim if the claiming device heartbeat is stale. */
    staleAfterMs?: number;
    now?: () => Date;
}
export interface ClaimCronJobResult {
    originalPath: string;
    path: string;
    absolutePath: string;
    deviceId: string;
}
/**
 * Atomically claim a cron job by renaming it to a .claimed.<device>.md path.
 * If the job is already claimed and staleAfterMs is provided, the claim is
 * recoverable when the previous claiming device's heartbeat is older than
 * now - staleAfterMs. The claimed file gets a last_claimed_by frontmatter
 * line so the claim is inspectable from the vault.
 *
 * This mirrors claimInboxTask's design: atomic rename as the coordination
 * primitive, device heartbeats as the liveness signal, no leases or DB.
 */
export declare function claimCronJob(options: ClaimCronJobOptions): Promise<ClaimCronJobResult>;
export type CronRunStatus = "completed" | "failed";
export interface RecordCronRunOptions {
    vaultRoot: string;
    /** Vault-relative path to the CLAIMED job file (e.g. cron/jobs/x.claimed.dev.md). */
    jobPath: string;
    agentName: string;
    deviceId: string;
    status: CronRunStatus;
    result: string;
    startedAt: Date;
    finishedAt: Date;
}
export interface RecordCronRunResult {
    runPath: string;
    runAbsolutePath: string;
    /** The restored unclaimed job path. */
    restoredJobPath: string;
    restoredJobAbsolutePath: string;
}
/**
 * Record a cron run and restore the unclaimed job. Writes an inspectable run
 * record Markdown file under cron/runs/ (shared) or team/<agent>/cron/runs/
 * (scoped), with frontmatter (job_id, agent, device, status, started_at,
 * finished_at) and the run result as the body. Then restores the job to its
 * unclaimed path with last_run set to finishedAt and the stale last_claimed_by
 * line removed, so the job is eligible again on the next due cycle.
 *
 * The run record is the durable, inspectable evidence; the job restoration is
 * the coordination state. Failures are recorded too so the operator can see
 * them in the vault, and the job is still restored so it can be retried.
 */
export declare function recordCronRun(options: RecordCronRunOptions): Promise<RecordCronRunResult>;
export interface ResolveCronScriptPathOptions {
    vaultRoot: string;
    script: string;
}
export interface ResolvedCronScriptPath {
    path: string;
    absolutePath: string;
}
export declare function resolveCronScriptPath(options: ResolveCronScriptPathOptions): ResolvedCronScriptPath;
export interface ExecuteScriptCronJobOptions {
    vaultRoot: string;
    jobPath: string;
    agentName: string;
    deviceId: string;
    staleAfterMs?: number;
    timeoutMs?: number;
    outputLimitBytes?: number;
    now?: () => Date;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}
export interface ExecuteScriptCronJobResult {
    status: CronRunStatus;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    runPath: string;
    restoredJobPath: string;
}
export declare function executeScriptCronJob(options: ExecuteScriptCronJobOptions): Promise<ExecuteScriptCronJobResult>;
/**
 * Read all unclaimed, enabled job files from the shared (cron/jobs/) and
 * agent-scoped (team/<agent>/cron/jobs/) directories. Missing directories
 * contribute an empty list. Claimed files (in-flight runs) are skipped so two
 * devices do not both pick up the same job.
 */
export declare function listCronJobs(options: ListCronJobsOptions): Promise<ListCronJobsResult>;
export interface CronRunSummary {
    jobId: string;
    path: string;
    absolutePath: string;
    agent: string;
    device: string;
    status: string;
    startedAt: string;
    finishedAt: string;
}
export interface ListCronRunsOptions {
    vaultRoot: string;
    agentName: string;
    /** When set, only return runs whose job_id matches. */
    jobId?: string;
}
export interface ListCronRunsResult {
    agentName: string;
    runs: CronRunSummary[];
}
/**
 * Read run records from cron/runs/ (shared) and team/<agent>/cron/runs/
 * (scoped), newest-first. Missing directories contribute an empty list.
 * Malformed run records are skipped, not fatal. Optionally filter by job_id.
 */
export declare function listCronRuns(options: ListCronRunsOptions): Promise<ListCronRunsResult>;
