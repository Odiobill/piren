import { access, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
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

// ---------------------------------------------------------------------------
// Device ownership (ADR-0019: active-device-priority selection)
// ---------------------------------------------------------------------------

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

function devicePriorityRank(a: ActiveDevice, b: ActiveDevice): number {
  // Lower priority number = higher priority. Tie-break on device id for
  // deterministic ownership across devices.
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.deviceId.localeCompare(b.deviceId);
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
export function selectOwningDevice(options: SelectOwningDeviceOptions): SelectOwningDeviceResult {
  const { devicePolicy, activeDevices, deviceId } = options;
  const allowList = devicePolicy.allowedDevices;
  const eligible = allowList.length > 0
    ? activeDevices.filter((device) => allowList.includes(device.deviceId))
    : [...activeDevices];
  eligible.sort(devicePriorityRank);
  const owner = eligible[0]?.deviceId ?? "";
  return { owns: owner === deviceId, owner, eligible };
}

// ---------------------------------------------------------------------------
// Active device discovery (reads team/<agent>/devices/*.json heartbeats)
// ---------------------------------------------------------------------------

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

interface DeviceHeartbeat {
  device_id?: unknown;
  priority?: unknown;
  status?: unknown;
  last_seen?: unknown;
}

/**
 * Read device heartbeat records from team/<agent>/devices/*.json and return
 * the active, non-stale devices. Reuses the same JSON format and staleness
 * principle as inbox task claiming: a device whose last_seen is older than
 * now - staleAfterMs is considered stale and excluded. Malformed or partial
 * records are skipped, not fatal.
 */
export async function listActiveDevices(options: ListActiveDevicesOptions): Promise<ListActiveDevicesResult> {
  const root = resolve(options.vaultRoot);
  const now = options.now ?? (() => new Date());
  const nowMs = now().getTime();
  const devicesDir = join(root, "team", options.agentName, "devices");
  const devices: ActiveDevice[] = [];
  if (!(await pathExists(devicesDir))) {
    return { agentName: options.agentName, devices };
  }
  const entries = await readdir(devicesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(join(devicesDir, entry.name), "utf8")) as DeviceHeartbeat;
      if (typeof parsed.device_id !== "string") continue;
      const lastSeen = typeof parsed.last_seen === "string" ? Date.parse(parsed.last_seen) : Number.NaN;
      if (!Number.isFinite(lastSeen)) continue;
      if (nowMs - lastSeen > options.staleAfterMs) continue;
      const status = typeof parsed.status === "string" ? parsed.status : "active";
      if (status !== "active" && status !== "idle") continue;
      const priority = typeof parsed.priority === "number" && Number.isFinite(parsed.priority) ? parsed.priority : 10;
      devices.push({ deviceId: parsed.device_id, priority });
    } catch {
      // Skip unreadable device records.
    }
  }
  return { agentName: options.agentName, devices };
}

// ---------------------------------------------------------------------------
// Atomic job claiming (reuses the inbox rename + stale-recovery pattern)
// ---------------------------------------------------------------------------

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

const DEVICE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

function assertValidDeviceName(deviceId: string): void {
  if (!DEVICE_NAME_PATTERN.test(deviceId)) {
    throw new Error(`Invalid device id. Use lowercase kebab-case, for example 'heimdall'.`);
  }
}

function claimedDeviceIdFromName(fileName: string): string | undefined {
  const match = fileName.match(/\.claimed\.([a-z][a-z0-9-]*)\.md$/i);
  return match?.[1];
}

function runsDirectoryForJob(vaultRoot: string, jobPath: string): string {
  const parts = jobPath.split(/[\\/]+/);
  if (parts[0] === "team" && parts[2] === "cron" && parts[3] === "jobs") {
    return agentRunsPath(vaultRoot, parts[1] ?? "");
  }
  return sharedRunsPath(vaultRoot);
}

/**
 * Read a single device heartbeat's last_seen timestamp. Returns undefined if
 * the record is missing or malformed (treated as stale-able for recovery).
 */
async function deviceLastSeenMs(vaultRoot: string, agentName: string, deviceId: string): Promise<number | undefined> {
  const devicePath = join(vaultRoot, "team", agentName, "devices", `${deviceId}.json`);
  if (!(await pathExists(devicePath))) return undefined;
  try {
    const parsed = JSON.parse(await readFile(devicePath, "utf8")) as DeviceHeartbeat;
    if (typeof parsed.last_seen === "string") {
      const ms = Date.parse(parsed.last_seen);
      if (Number.isFinite(ms)) return ms;
    }
  } catch {
    // fall through to undefined
  }
  return undefined;
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
export async function claimCronJob(options: ClaimCronJobOptions): Promise<ClaimCronJobResult> {
  assertValidDeviceName(options.deviceId);
  const root = resolve(options.vaultRoot);
  const sourceAbsolutePath = resolve(root, options.jobPath);
  assertInsideVault(root, sourceAbsolutePath);
  const fileName = sourceAbsolutePath.split(/[\\/]+/).pop() ?? "";
  if (!fileName.endsWith(".md")) {
    throw new Error("Cron job path must point to a Markdown file under cron/jobs/ or team/<agent>/cron/jobs/.");
  }

  const previousDevice = claimedDeviceIdFromName(fileName);
  if (previousDevice !== undefined) {
    // The job is already claimed. Allow recovery only with explicit staleness.
    if (options.staleAfterMs === undefined) {
      throw new Error(`Cron job is already claimed by '${previousDevice}'. Pass stale_after_ms to recover a stale claim.`);
    }
    const lastSeenMs = await deviceLastSeenMs(root, options.agentName, previousDevice);
    const now = options.now ?? (() => new Date());
    const nowMs = now().getTime();
    if (lastSeenMs !== undefined && nowMs - lastSeenMs <= options.staleAfterMs) {
      throw new Error(`Cron job is already claimed by active device '${previousDevice}'.`);
    }
    // Stale: fall through to reclaim under the new device id.
  }

  const baseName = fileName.replace(/\.claimed\.[a-z][a-z0-9-]*\.md$/i, ".md");
  const claimedName = baseName.replace(/\.md$/, `.claimed.${options.deviceId}.md`);
  const claimedPath = relative(root, sourceAbsolutePath).replace(fileName, claimedName);
  const claimedAbsolutePath = resolve(root, claimedPath);
  assertInsideVault(root, claimedAbsolutePath);

  // Inject/refresh last_claimed_by in frontmatter as part of the claim.
  const content = await readFile(sourceAbsolutePath, "utf8");
  const updated = content.replace(/^(---\r?\n)/, `$1last_claimed_by: ${options.deviceId}\n`);

  const directory = dirname(claimedAbsolutePath);
  await mkdir(directory, { recursive: true });
  const tempPath = resolve(directory, `.${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(updated, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, claimedAbsolutePath);
  await rm(sourceAbsolutePath, { force: true });

  return {
    originalPath: relative(root, sourceAbsolutePath),
    path: claimedPath,
    absolutePath: claimedAbsolutePath,
    deviceId: options.deviceId,
  };
}

// ---------------------------------------------------------------------------
// Run records and last_run restoration
// ---------------------------------------------------------------------------

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

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

function atomicWriteFile(target: string, content: string): Promise<number> {
  const directory = dirname(target);
  return (async () => {
    await mkdir(directory, { recursive: true });
    const tempPath = resolve(directory, `.${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
    const bytes = Buffer.byteLength(content);
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, target);
    return bytes;
  })();
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
export async function recordCronRun(options: RecordCronRunOptions): Promise<RecordCronRunResult> {
  const root = resolve(options.vaultRoot);
  const claimedAbsolutePath = resolve(root, options.jobPath);
  assertInsideVault(root, claimedAbsolutePath);
  const claimedFileName = claimedAbsolutePath.split(/[\\/]+/).pop() ?? "";
  const jobIdMatch = claimedFileName.match(/^(.+?)\.claimed\.[a-z][a-z0-9-]*\.md$/i);
  if (!jobIdMatch) {
    throw new Error(`Cron run can only be recorded for a claimed job path: ${options.jobPath}`);
  }
  const jobId = jobIdMatch[1] ?? "";
  const unclaimedName = `${jobId}.md`;

  const claimedContent = await readFile(claimedAbsolutePath, "utf8");
  const runsDir = runsDirectoryForJob(root, options.jobPath);
  const runFileName = `${compactTimestamp(options.startedAt)}-${jobId}.md`;
  const runPath = relative(root, join(runsDir, runFileName));
  const runAbsolutePath = join(runsDir, runFileName);
  assertInsideVault(root, runAbsolutePath);

  const runRecord = [
    "---",
    `job_id: ${jobId}`,
    `agent: ${options.agentName}`,
    `device: ${options.deviceId}`,
    `status: ${options.status}`,
    `started_at: ${options.startedAt.toISOString()}`,
    `finished_at: ${options.finishedAt.toISOString()}`,
    "---",
    "",
    `# Run ${jobId} @ ${options.startedAt.toISOString()}`,
    "",
    options.result,
    "",
  ].join("\n");
  await atomicWriteFile(runAbsolutePath, runRecord);

  // Restore the unclaimed job with last_run set and the stale claim line removed.
  const restoredPath = relative(root, claimedAbsolutePath).replace(claimedFileName, unclaimedName);
  const restoredAbsolutePath = resolve(root, restoredPath);
  assertInsideVault(root, restoredAbsolutePath);
  const withoutClaim = claimedContent.replace(/^last_claimed_by:.*\r?\n/im, "");
  let restoredContent: string;
  if (/^last_run:.*$/m.test(withoutClaim)) {
    restoredContent = withoutClaim.replace(/^(last_run:).*$/m, `$1 ${options.finishedAt.toISOString()}`);
  } else {
    // Insert last_run right after the opening frontmatter delimiter.
    restoredContent = withoutClaim.replace(/^(---\r?\n)/, `$1last_run: ${options.finishedAt.toISOString()}\n`);
  }
  await atomicWriteFile(restoredAbsolutePath, restoredContent);
  await rm(claimedAbsolutePath, { force: true });

  return {
    runPath,
    runAbsolutePath,
    restoredJobPath: restoredPath,
    restoredJobAbsolutePath: restoredAbsolutePath,
  };
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
