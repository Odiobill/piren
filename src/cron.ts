import { access, readFile, readdir, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

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

const INTERVAL_PATTERN = /^(\d+)([smhd])$/;

const UNIT_TO_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Milliseconds for an interval schedule. Returns undefined for cron schedules.
 */
export function intervalMs(schedule: CronSchedule): number | undefined {
  if (schedule.kind !== "interval") return undefined;
  const match = schedule.raw.match(INTERVAL_PATTERN);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === undefined) return undefined;
  const multiplier = UNIT_TO_MS[unit];
  return multiplier !== undefined && Number.isFinite(multiplier) ? amount * multiplier : undefined;
}

/**
 * Whether a five-field cron field matches a given calendar value.
 * Supports "*" (any) and a single integer. Ranges, lists, and steps are
 * out of RC scope (ADR-0019: "simple schedules").
 */
function cronFieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  return Number(field) === value;
}

/**
 * Whether a five-field cron schedule fires at the given instant (UTC).
 */
function cronMatchesAt(schedule: CronSchedule, date: Date): boolean {
  if (schedule.kind !== "cron") return false;
  const fields = schedule.raw.split(/\s+/);
  const minute = fields[0];
  const hour = fields[1];
  const dom = fields[2];
  const month = fields[3];
  const dow = fields[4];
  return (
    cronFieldMatches(minute ?? "", date.getUTCMinutes()) &&
    cronFieldMatches(hour ?? "", date.getUTCHours()) &&
    cronFieldMatches(dom ?? "", date.getUTCDate()) &&
    cronFieldMatches(month ?? "", date.getUTCMonth() + 1) &&
    cronFieldMatches(dow ?? "", date.getUTCDay())
  );
}

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
export function isScheduleDue(options: IsScheduleDueOptions): boolean {
  const { schedule, now, lastRun } = options;

  if (schedule.kind === "interval") {
    const ms = intervalMs(schedule);
    if (ms === undefined) return false;
    if (!lastRun) return true;
    return now.getTime() - lastRun.getTime() >= ms;
  }

  if (!cronMatchesAt(schedule, now)) return false;
  if (!lastRun) return true;
  // Align both to the minute: a job is due at most once per matching minute.
  const lastMinute = Math.floor(lastRun.getTime() / 60_000);
  const nowMinute = Math.floor(now.getTime() / 60_000);
  return nowMinute > lastMinute;
}

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
export function parseSchedule(raw: string): CronSchedule {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error("Cron schedule is required");
  }

  const intervalMatch = trimmed.match(INTERVAL_PATTERN);
  if (intervalMatch) {
    const amount = Number(intervalMatch[1]);
    const unit = intervalMatch[2];
    if (!Number.isInteger(amount) || amount <= 0 || unit === undefined) {
      throw new Error(`Invalid cron interval: ${raw}`);
    }
    return { raw: trimmed, kind: "interval", describe: () => trimmed };
  }

  const fields = trimmed.split(/\s+/);
  if (fields.length === 5 && fields.every((field) => field === "*" || /^\d+$/.test(field))) {
    return { raw: trimmed, kind: "cron", describe: () => trimmed };
  }

  throw new Error(`Invalid cron schedule: ${raw}. Use a five-field cron string or an interval like "30m".`);
}

// ---------------------------------------------------------------------------
// Job files
// ---------------------------------------------------------------------------

export type CronDevicePolicyMode = "highest_priority";

export interface CronDevicePolicy {
  mode: CronDevicePolicyMode;
  allowedDevices: string[];
}

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
  prompt: string;
  devicePolicy: CronDevicePolicy;
  staleAfterSeconds?: number;
  /** Last recorded run ISO timestamp, parsed from frontmatter if present. */
  lastRun?: Date;
  /** Device id that claimed the most recent run, if recorded in frontmatter. */
  lastClaimedBy?: string;
}

const SHARED_JOBS_DIR = "cron/jobs";
const SHARED_RUNS_DIR = "cron/runs";

function sharedJobsPath(vaultRoot: string): string {
  return join(vaultRoot, SHARED_JOBS_DIR);
}

function sharedRunsPath(vaultRoot: string): string {
  return join(vaultRoot, SHARED_RUNS_DIR);
}

function agentJobsPath(vaultRoot: string, agent: string): string {
  return join(vaultRoot, "team", agent, "cron", "jobs");
}

function agentRunsPath(vaultRoot: string, agent: string): string {
  return join(vaultRoot, "team", agent, "cron", "runs");
}

function assertInsideVault(vaultRoot: string, target: string): void {
  const rel = relative(vaultRoot, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path resolves outside vault: ${target}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface ParsedJobFrontmatter {
  id: string;
  agent: string;
  schedule: string;
  enabled: boolean;
  prompt: string;
  devicePolicy: CronDevicePolicy;
  staleAfterSeconds?: number;
  lastRun?: Date;
  lastClaimedBy?: string;
}

function splitFrontmatter(content: string): { fields: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { fields: {}, body: content };
  const rawFields = match[1] ?? "";
  const body = match[2] ?? "";
  const parsed = parseYaml(rawFields) as unknown;
  const fields = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  return { fields, body };
}

function asString(value: unknown, field: string, path: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  throw new Error(`Cron job '${field}' must be a string: ${path}`);
}

function asNumberOrUndefined(value: unknown, field: string, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`Cron job '${field}' must be a non-negative number: ${path}`);
  }
  return num;
}

function parseDevicePolicy(value: unknown, path: string): CronDevicePolicy {
  if (value === undefined || value === null) {
    return { mode: "highest_priority", allowedDevices: [] };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Cron job 'device_policy' must be an object: ${path}`);
  }
  const policy = value as Record<string, unknown>;
  const mode = policy.mode;
  if (mode !== undefined && mode !== "highest_priority") {
    throw new Error(`Cron job device_policy.mode '${String(mode)}' is not supported: ${path}`);
  }
  const rawDevices = policy.allowed_devices;
  let allowedDevices: string[] = [];
  if (Array.isArray(rawDevices)) {
    allowedDevices = rawDevices
      .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
      .map((entry) => entry.trim());
  } else if (rawDevices !== undefined) {
    throw new Error(`Cron job device_policy.allowed_devices must be a list: ${path}`);
  }
  return { mode: "highest_priority", allowedDevices };
}

function promptFromBody(body: string): string {
  // The job body may contain a "# Prompt" heading; return everything after it.
  const headingMatch = body.match(/(^|\n)#\s+Prompt\s*\r?\n([\s\S]*)$/i);
  if (headingMatch) {
    return (headingMatch[2] ?? "").trim();
  }
  return body.trim();
}

function parseJobFrontmatter(content: string, path: string): ParsedJobFrontmatter {
  const { fields, body } = splitFrontmatter(content);
  const id = asString(fields.id, "id", path).trim();
  const agent = asString(fields.agent, "agent", path).trim();
  const scheduleRaw = asString(fields.schedule, "schedule", path).trim();
  if (!id || !agent || !scheduleRaw) {
    throw new Error(`Cron job is missing required frontmatter (id, agent, schedule): ${path}`);
  }
  const schedule = parseSchedule(scheduleRaw);
  const enabledRaw = fields.enabled;
  const enabled = enabledRaw === undefined ? true : Boolean(enabledRaw);
  const devicePolicy = parseDevicePolicy(fields.device_policy, path);
  const staleAfterSeconds = asNumberOrUndefined(fields.stale_after_seconds, "stale_after_seconds", path);
  const lastRunRaw = fields.last_run;
  const lastClaimedByRaw = fields.last_claimed_by;

  const prompt = promptFromBody(body);
  if (!prompt) {
    throw new Error(`Cron job has an empty prompt: ${path}`);
  }

  const result: ParsedJobFrontmatter = { id, agent, schedule: scheduleRaw, enabled, prompt, devicePolicy };
  if (staleAfterSeconds !== undefined) result.staleAfterSeconds = staleAfterSeconds;
  if (typeof lastRunRaw === "string" && lastRunRaw.trim() !== "") {
    const parsed = new Date(lastRunRaw);
    if (!Number.isNaN(parsed.getTime())) result.lastRun = parsed;
  }
  if (typeof lastClaimedByRaw === "string" && lastClaimedByRaw.trim() !== "") {
    result.lastClaimedBy = lastClaimedByRaw.trim();
  }
  return result;
}

/**
 * Detect the scope of a job path. Returns "shared" for cron/jobs/ and the
 * agent name for team/<agent>/cron/jobs/.
 */
function detectScope(vaultRoot: string, absolutePath: string): string {
  const rel = relative(vaultRoot, absolutePath);
  const parts = rel.split(/[\\/]+/);
  if (parts[0] === "team" && parts[2] === "cron" && parts[3] === "jobs") {
    return parts[1] ?? "";
  }
  return "shared";
}

export interface ReadCronJobOptions {
  vaultRoot: string;
  /** Vault-relative path to the job Markdown file. */
  path: string;
  now?: () => Date;
}

export async function readCronJob(options: ReadCronJobOptions): Promise<CronJob> {
  const root = resolve(options.vaultRoot);
  const absolutePath = resolve(root, options.path);
  assertInsideVault(root, absolutePath);
  const content = await readFile(absolutePath, "utf8");
  const parsed = parseJobFrontmatter(content, options.path);
  const schedule = parseSchedule(parsed.schedule);
  const scope = detectScope(root, absolutePath);
  const job: CronJob = {
    path: relative(root, absolutePath),
    absolutePath,
    scope,
    id: parsed.id,
    agent: parsed.agent,
    schedule,
    enabled: parsed.enabled,
    prompt: parsed.prompt,
    devicePolicy: parsed.devicePolicy,
  };
  if (parsed.staleAfterSeconds !== undefined) job.staleAfterSeconds = parsed.staleAfterSeconds;
  if (parsed.lastRun !== undefined) job.lastRun = parsed.lastRun;
  if (parsed.lastClaimedBy !== undefined) job.lastClaimedBy = parsed.lastClaimedBy;
  return job;
}

export interface ListCronJobsOptions {
  vaultRoot: string;
  agentName: string;
  now?: () => Date;
}

export interface ListCronJobsResult {
  agentName: string;
  jobs: CronJob[];
}

function isClaimedJobFile(name: string): boolean {
  return /\.claimed\.[a-z][a-z0-9-]*\.md$/i.test(name);
}

/**
 * Read all unclaimed, enabled job files from the shared (cron/jobs/) and
 * agent-scoped (team/<agent>/cron/jobs/) directories. Missing directories
 * contribute an empty list. Claimed files (in-flight runs) are skipped so two
 * devices do not both pick up the same job.
 */
export async function listCronJobs(options: ListCronJobsOptions): Promise<ListCronJobsResult> {
  const root = resolve(options.vaultRoot);
  const now = options.now ?? (() => new Date());
  const directories = [sharedJobsPath(root), agentJobsPath(root, options.agentName)];
  const jobs: CronJob[] = [];
  for (const directory of directories) {
    if (!(await pathExists(directory))) continue;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (isClaimedJobFile(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      try {
        const job = await readCronJob({ vaultRoot: root, path: relative(root, absolutePath), now });
        if (!job.enabled) continue;
        jobs.push(job);
      } catch {
        // Skip malformed job files rather than failing the whole list. The
        // operator can find them via a future doctor check or vault listing.
      }
    }
  }
  jobs.sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
  return { agentName: options.agentName, jobs };
}
