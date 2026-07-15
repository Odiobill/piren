/**
 * Cron job CLI authoring + inspection core (Slice B, ADR-0019).
 *
 * Wraps the existing pure cron core in src/cron.ts with CLI-friendly writer,
 * resolver, and validator helpers. This module is callable directly from tests
 * with an injected filesystem; the real adapter is a thin wrapper around
 * node:fs/promises.
 *
 * The module imports parseSchedule and resolveCronScriptPath from the
 * existing core, but it NEVER changes src/cron.ts behavior - it only wraps it.
 */
import { type CronJobMode, type CronRunSummary } from "./cron.js";
/** Injected filesystem operations, structurally compatible with node:fs/promises. */
export interface CronWriteDeps {
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
}
/** Shape of a job to render with renderCronJobFrontmatter. */
export interface CronJobWriteSpec {
    id: string;
    agent: string;
    schedule: string;
    mode: CronJobMode;
    body?: string;
    script?: string;
}
export type CronValidationIssueKind = "invalid-schedule" | "missing-agent" | "missing-script" | "script-outside-vault" | "duplicate-id" | "disabled-job" | "parse-error";
export interface CronValidationIssue {
    kind: CronValidationIssueKind;
    severity: "error" | "info";
    message: string;
    jobPath: string;
}
/** A simplified read result, used by the show command and formatters. */
export interface CronJobFile {
    id: string;
    agent: string;
    schedule: string;
    enabled: boolean;
    mode: CronJobMode;
    prompt: string;
    script?: string;
    path: string;
    scope: string;
}
/** Validate a cron job id: no empty, no ., .., path separators. */
export declare function isValidCronId(id: string): boolean;
/** Validate an agent name: no empty, no ., .., path separators. */
export declare function isValidAgentName(name: string): boolean;
/**
 * Render a cron job file with deterministic YAML frontmatter and a prompt body.
 */
export declare function renderCronJobFrontmatter(spec: CronJobWriteSpec): string;
export interface CreateCronJobOptions {
    force?: boolean;
    bodyPath?: string;
}
/**
 * Write a new cron job file. Validates the id and schedule, refuses to
 * overwrite an existing job without --force.
 */
export declare function createCronJob(deps: CronWriteDeps, vaultRoot: string, id: string, agent: string, schedule: string, bodyPath?: string, options?: CreateCronJobOptions): Promise<void>;
/**
 * Write a new script-mode cron job file.
 */
export declare function createScriptCronJob(deps: CronWriteDeps, vaultRoot: string, id: string, agent: string, schedule: string, scriptPath: string, options?: CreateCronJobOptions): Promise<void>;
/** Set a cron job's enabled frontmatter field to true. */
export declare function enableCronJob(deps: CronWriteDeps, vaultRoot: string, idOrPath: string): Promise<void>;
/** Set a cron job's enabled frontmatter field to false. */
export declare function disableCronJob(deps: CronWriteDeps, vaultRoot: string, idOrPath: string): Promise<void>;
/**
 * Resolve an id or relative path to the absolute path of a cron job file.
 */
export declare function resolveCronJobPath(deps: CronWriteDeps, vaultRoot: string, idOrPath: string): Promise<string>;
/**
 * Read a cron job file and return a simplified CronJobFile.
 */
export declare function readCronJobFile(deps: CronWriteDeps, vaultRoot: string, idOrPath: string): Promise<CronJobFile>;
/**
 * Validate all cron jobs under vaultRoot/cron/jobs/ and team/<agent>/cron/jobs/.
 */
export declare function validateCronJobs(deps: CronWriteDeps, vaultRoot: string): Promise<CronValidationIssue[]>;
export declare function formatCronList(jobs: Array<{
    id: string;
    path: string;
    schedule: {
        raw: string;
        kind: string;
        describe?: () => string;
    };
    enabled: boolean;
    mode: string;
    lastRun?: Date;
    lastClaimedBy?: string;
}>): string;
export declare function formatCronShow(job: CronJobFile): string;
export declare function formatCronRuns(runs: CronRunSummary[]): string;
export declare function formatCronValidationReport(issues: CronValidationIssue[]): string;
/** Build CronWriteDeps backed by real node:fs/promises. */
export declare function createRealCronWriteDeps(): CronWriteDeps;
