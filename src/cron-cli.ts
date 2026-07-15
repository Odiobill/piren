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

import { parseSchedule, resolveCronScriptPath, type CronJobMode, type CronRunSummary } from "./cron.js";
import { isAbsolute, join, resolve, relative } from "node:path";
import { readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injected filesystem operations, structurally compatible with node:fs/promises. */
export interface CronWriteDeps {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  readdir(path: string): Promise<{ name: string; isDirectory(): boolean; isFile(): boolean }[]>;
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

export type CronValidationIssueKind =
  | "invalid-schedule"
  | "missing-agent"
  | "missing-script"
  | "script-outside-vault"
  | "duplicate-id"
  | "disabled-job"
  | "parse-error";

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate a cron job id: no empty, no ., .., path separators. */
export function isValidCronId(id: string): boolean {
  if (id === "" || id === "." || id === "..") return false;
  if (id.includes("/") || id.includes("\\")) return false;
  return true;
}

/** Validate an agent name: no empty, no ., .., path separators. */
export function isValidAgentName(name: string): boolean {
  if (name === "" || name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  return true;
}

function isLikelyPath(idOrPath: string): boolean {
  return idOrPath.includes("/") || idOrPath.includes("\\") || idOrPath.endsWith(".md");
}

function sharedJobsDir(vaultRoot: string): string {
  return join(vaultRoot, "cron", "jobs");
}

function agentJobsDir(vaultRoot: string, agent: string): string {
  return join(vaultRoot, "team", agent, "cron", "jobs");
}

async function pathExists(deps: CronWriteDeps, p: string): Promise<boolean> {
  try {
    await deps.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Quote a YAML string value with single quotes when it contains spaces or
 * special characters, otherwise leave it bare.
 */
function yamlString(value: string): string {
  if (/[\s:#{}[\]&*!|>'\"%@`,\\]/.test(value) || value === "") {
    return "'" + value + "'";
  }
  return value;
}

/**
 * Minimal YAML frontmatter parser. Splits a Markdown file into its frontmatter
 * (as raw text) and body. Returns null when there is no frontmatter block.
 */
function splitFrontmatterYaml(content: string): { rawYaml: string; body: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  return { rawYaml: match[1] ?? "", body: match[2] ?? "" };
}

/**
 * Parse the raw YAML frontmatter into a record of key-value pairs. Returns an
 * empty object when the raw YAML is empty or cannot be parsed. Uses the yaml
 * library for proper YAML parsing (same as src/cron.ts).
 */
async function parseFrontmatterFields(rawYaml: string): Promise<Record<string, unknown>> {
  if (rawYaml.trim() === "") return {};
  const { parse: parseYaml } = await import("yaml");
  const parsed = parseYaml(rawYaml) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const DEFAULT_BODY = "# Prompt\n\n<!-- TODO: add instructions for this cron job -->\n";

/**
 * Render a cron job file with deterministic YAML frontmatter and a prompt body.
 */
export function renderCronJobFrontmatter(spec: CronJobWriteSpec): string {
  parseSchedule(spec.schedule);

  const lines: string[] = [];
  lines.push("---");
  lines.push("type: Cron Job");
  lines.push("id: " + spec.id);
  lines.push("agent: " + spec.agent);
  lines.push("schedule: " + yamlString(spec.schedule));
  lines.push("enabled: true");
  lines.push("mode: " + spec.mode);
  lines.push("stale_after_seconds: 300");
  lines.push("last_run: null");
  lines.push("last_claimed_by: null");
  if (spec.mode === "script" && spec.script !== undefined) {
    lines.push("script: " + yamlString(spec.script));
  }
  lines.push("---");
  lines.push("");
  const body = spec.body ?? DEFAULT_BODY;
  lines.push(body.trimEnd());
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateCronJobOptions {
  force?: boolean;
  bodyPath?: string;
}

/**
 * Write a new cron job file. Validates the id and schedule, refuses to
 * overwrite an existing job without --force.
 */
export async function createCronJob(
  deps: CronWriteDeps,
  vaultRoot: string,
  id: string,
  agent: string,
  schedule: string,
  bodyPath?: string,
  options?: CreateCronJobOptions,
): Promise<void> {
  if (!isValidCronId(id)) {
    throw new Error(
      "Invalid cron job id '" + id + "'. Cron job ids must not contain '.', '..', or path separators.",
    );
  }
  if (!isValidAgentName(agent)) {
    throw new Error(
      "Invalid agent name '" + agent + "'. Agent names must not contain '.', '..', or path separators.",
    );
  }
  parseSchedule(schedule);

  const targetDir = agentJobsDir(vaultRoot, agent);
  const targetPath = join(targetDir, id + ".md");

  const exists = await pathExists(deps, targetPath);
  if (exists && !options?.force) {
    throw new Error(
      "Cron job '" + id + "' already exists at " + targetPath + ". Re-run with --force to overwrite it.",
    );
  }

  let body: string | undefined;
  if (bodyPath !== undefined) {
    const root = resolve(vaultRoot);
    const absBody = resolve(root, bodyPath);
    const relBody = relative(root, absBody);
    if (relBody.startsWith("..") || isAbsolute(relBody)) {
      throw new Error("Body file path resolves outside vault: " + bodyPath);
    }
    try {
      body = await deps.readFile(absBody);
    } catch {
      throw new Error("Cannot read body file: " + bodyPath);
    }
  }

  const spec: CronJobWriteSpec = { id, agent, schedule, mode: "agent" };
  if (body !== undefined) spec.body = body;
  const content = renderCronJobFrontmatter(spec);
  await deps.mkdir(targetDir, { recursive: true });
  await deps.writeFile(targetPath, content);
}

/**
 * Write a new script-mode cron job file.
 */
export async function createScriptCronJob(
  deps: CronWriteDeps,
  vaultRoot: string,
  id: string,
  agent: string,
  schedule: string,
  scriptPath: string,
  options?: CreateCronJobOptions,
): Promise<void> {
  if (!isValidCronId(id)) {
    throw new Error(
      "Invalid cron job id '" + id + "'. Cron job ids must not contain '.', '..', or path separators.",
    );
  }
  if (!isValidAgentName(agent)) {
    throw new Error(
      "Invalid agent name '" + agent + "'. Agent names must not contain '.', '..', or path separators.",
    );
  }
  parseSchedule(schedule);

  resolveCronScriptPath({ vaultRoot, script: scriptPath });

  const targetDir = agentJobsDir(vaultRoot, agent);
  const targetPath = join(targetDir, id + ".md");

  const exists = await pathExists(deps, targetPath);
  if (exists && !options?.force) {
    throw new Error(
      "Cron job '" + id + "' already exists at " + targetPath + ". Re-run with --force to overwrite it.",
    );
  }

  const content = renderCronJobFrontmatter({
    id,
    agent,
    schedule,
    mode: "script",
    script: scriptPath,
  });
  await deps.mkdir(targetDir, { recursive: true });
  await deps.writeFile(targetPath, content);
}

// ---------------------------------------------------------------------------
// Enable / disable
// ---------------------------------------------------------------------------

async function setEnabled(
  deps: CronWriteDeps,
  vaultRoot: string,
  idOrPath: string,
  target: boolean,
): Promise<void> {
  const resolvedPath = await resolveCronJobPath(deps, vaultRoot, idOrPath);
  const content = await deps.readFile(resolvedPath);
  const fromValue = target ? "false" : "true";
  const toValue = target ? "true" : "false";
  const updated = content.replace("enabled: " + fromValue, "enabled: " + toValue);
  if (updated === content) {
    return;
  }
  await deps.writeFile(resolvedPath, updated);
}

/** Set a cron job's enabled frontmatter field to true. */
export async function enableCronJob(
  deps: CronWriteDeps,
  vaultRoot: string,
  idOrPath: string,
): Promise<void> {
  await setEnabled(deps, vaultRoot, idOrPath, true);
}

/** Set a cron job's enabled frontmatter field to false. */
export async function disableCronJob(
  deps: CronWriteDeps,
  vaultRoot: string,
  idOrPath: string,
): Promise<void> {
  await setEnabled(deps, vaultRoot, idOrPath, false);
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an id or relative path to the absolute path of a cron job file.
 */
export async function resolveCronJobPath(
  deps: CronWriteDeps,
  vaultRoot: string,
  idOrPath: string,
): Promise<string> {
  const root = resolve(vaultRoot);

  if (isLikelyPath(idOrPath)) {
    const absPath = resolve(root, idOrPath);
    const rel = relative(root, absPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("Path resolves outside vault: " + idOrPath);
    }
    const fileExists = await pathExists(deps, absPath);
    if (!fileExists) {
      throw new Error("Cron job not found: " + idOrPath);
    }
    return absPath;
  }

  const sharedPath = join(sharedJobsDir(root), idOrPath + ".md");
  if (await pathExists(deps, sharedPath)) {
    return sharedPath;
  }

  let teamEntries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    teamEntries = await deps.readdir(join(root, "team"));
  } catch {
    throw new Error("Cron job '" + idOrPath + "' not found.");
  }

  for (const entry of teamEntries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const agentPath = join(agentJobsDir(root, entry.name), idOrPath + ".md");
    if (await pathExists(deps, agentPath)) {
      return agentPath;
    }
  }

  throw new Error("Cron job '" + idOrPath + "' not found.");
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read a cron job file and return a simplified CronJobFile.
 */
export async function readCronJobFile(
  deps: CronWriteDeps,
  vaultRoot: string,
  idOrPath: string,
): Promise<CronJobFile> {
  const absPath = await resolveCronJobPath(deps, vaultRoot, idOrPath);
  const content = await deps.readFile(absPath);
  const root = resolve(vaultRoot);
  const vaultPath = relative(root, absPath);

  const split = splitFrontmatterYaml(content);
  if (!split) {
    throw new Error("Cron job is missing frontmatter: " + vaultPath);
  }

  const fields = await parseFrontmatterFields(split.rawYaml);

  const id = typeof fields.id === "string" ? fields.id.trim() : "";
  const agent = typeof fields.agent === "string" ? fields.agent.trim() : "";
  const scheduleRaw = typeof fields.schedule === "string" ? fields.schedule.trim() : "";
  const enabled =
    fields.enabled === undefined ? true : Boolean(fields.enabled);
  const mode: CronJobMode =
    fields.mode === "script" ? "script" : "agent";
  const script =
    typeof fields.script === "string" && fields.script.trim() !== ""
      ? fields.script.trim()
      : undefined;

  const body = split.body.trim();
  const headingMatch = body.match(/(?:^|\n)#\s+Prompt\s*(?:\r?\n)([\s\S]*)$/i);
  const prompt = headingMatch ? (headingMatch[1] ?? "").trim() : body;

  const scope = vaultPath.startsWith("team/") ? (vaultPath.split("/")[1] ?? "") : "shared";

  const result: CronJobFile = {
    id,
    agent,
    schedule: scheduleRaw,
    enabled,
    mode,
    prompt,
    path: vaultPath,
    scope,
  };
  if (script !== undefined) result.script = script;
  return result;
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

/**
 * Validate all cron jobs under vaultRoot/cron/jobs/ and team/<agent>/cron/jobs/.
 */
export async function validateCronJobs(
  deps: CronWriteDeps,
  vaultRoot: string,
): Promise<CronValidationIssue[]> {
  const root = resolve(vaultRoot);
  const issues: CronValidationIssue[] = [];
  const idLocations = new Map<string, string[]>();

  const sharedDir = sharedJobsDir(root);
  await collectJobsFromDir(deps, root, sharedDir, "shared", issues, idLocations);

  let teamEntries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    teamEntries = await deps.readdir(join(root, "team"));
  } catch {
    teamEntries = [];
  }

  for (const entry of teamEntries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const agentDir = agentJobsDir(root, entry.name);
    await collectJobsFromDir(deps, root, agentDir, entry.name, issues, idLocations);
  }

  for (const [, locations] of idLocations) {
    if (locations.length > 1) {
      for (const loc of locations) {
        issues.push({
          kind: "duplicate-id",
          severity: "info",
          message: "Job id appears in multiple locations: " + locations.join(", ") + ".",
          jobPath: loc,
        });
      }
    }
  }

  return issues;
}

async function collectJobsFromDir(
  deps: CronWriteDeps,
  root: string,
  dir: string,
  _scope: string,
  issues: CronValidationIssue[],
  idLocations: Map<string, string[]>,
): Promise<void> {
  let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    entries = await deps.readdir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (/\.claimed\.[a-z][a-z0-9-]*\.md$/i.test(entry.name)) continue;

    const absolutePath = join(dir, entry.name);
    const vaultPath = relative(root, absolutePath);

    let content: string;
    try {
      content = await deps.readFile(absolutePath);
    } catch {
      issues.push({
        kind: "parse-error",
        severity: "error",
        message: "Cannot read cron job: " + vaultPath,
        jobPath: vaultPath,
      });
      continue;
    }

    const split = splitFrontmatterYaml(content);
    let fields: Record<string, unknown> = {};
    if (split) {
      try {
        fields = await parseFrontmatterFields(split.rawYaml);
      } catch {
        issues.push({
          kind: "parse-error",
          severity: "error",
          message: "Cannot parse frontmatter: " + vaultPath,
          jobPath: vaultPath,
        });
        continue;
      }
    }

    const id = typeof fields.id === "string" ? fields.id.trim() : "";
    const agent = typeof fields.agent === "string" ? fields.agent.trim() : "";
    const scheduleRaw =
      typeof fields.schedule === "string" ? fields.schedule.trim() : "";
    const enabled =
      fields.enabled === undefined ? true : Boolean(fields.enabled);
    const mode: CronJobMode =
      fields.mode === "script" ? "script" : "agent";

    if (id) {
      const locs = idLocations.get(id) ?? [];
      locs.push(vaultPath);
      idLocations.set(id, locs);
    }

    if (scheduleRaw) {
      try {
        parseSchedule(scheduleRaw);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        issues.push({
          kind: "invalid-schedule",
          severity: "error",
          message: "Invalid schedule '" + scheduleRaw + "': " + detail + ". " + vaultPath,
          jobPath: vaultPath,
        });
      }
    } else {
      issues.push({
        kind: "invalid-schedule",
        severity: "error",
        message: "Missing schedule: " + vaultPath,
        jobPath: vaultPath,
      });
    }

    if (mode === "agent" && !agent) {
      issues.push({
        kind: "missing-agent",
        severity: "error",
        message: "Agent-mode cron job is missing agent field: " + vaultPath,
        jobPath: vaultPath,
      });
    }

    if (mode === "script") {
      const script =
        typeof fields.script === "string" ? fields.script.trim() : "";
      if (!script) {
        issues.push({
          kind: "missing-script",
          severity: "error",
          message: "Script-mode cron job is missing script field: " + vaultPath,
          jobPath: vaultPath,
        });
      } else {
        try {
          resolveCronScriptPath({ vaultRoot: root, script });
        } catch {
          issues.push({
            kind: "script-outside-vault",
            severity: "error",
            message: "Script path resolves outside vault: " + script + ". " + vaultPath,
            jobPath: vaultPath,
          });
        }
      }
    }

    if (!enabled) {
      issues.push({
        kind: "disabled-job",
        severity: "info",
        message: "Cron job is disabled: " + vaultPath,
        jobPath: vaultPath,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function padRight(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

export function formatCronList(
  jobs: Array<{
    id: string;
    path: string;
    schedule: { raw: string; kind: string; describe?: () => string };
    enabled: boolean;
    mode: string;
    lastRun?: Date;
    lastClaimedBy?: string;
  }>,
): string {
  if (jobs.length === 0) {
    return "No cron jobs found.";
  }
  const lines: string[] = [];
  const idWidth = Math.max(8, ...jobs.map((j) => j.id.length));
  const schedWidth = Math.max(8, ...jobs.map((j) => j.schedule.raw.length));
  const statusLabel = "STATUS";
  const modeLabel = "MODE";
  const lastRunLabel = "LAST RUN";
  lines.push(
    padRight("ID", idWidth) + "  " + padRight("SCHEDULE", schedWidth) + "  " + statusLabel + "      " + modeLabel + "     " + lastRunLabel,
  );
  lines.push(
    "-".repeat(idWidth) + "  " + "-".repeat(schedWidth) + "  " + "-".repeat(statusLabel.length) + "  " + "-".repeat(modeLabel.length) + "  " + "-".repeat(lastRunLabel.length),
  );
  for (const job of jobs) {
    const status = job.enabled ? "enabled " : "disabled";
    const lastRun = job.lastRun
      ? job.lastRun.toISOString().slice(0, 19).replace("T", " ")
      : "never";
    lines.push(
      padRight(job.id, idWidth) + "  " + padRight(job.schedule.raw, schedWidth) + "  " + status + "  " + padRight(job.mode, modeLabel.length) + "  " + lastRun,
    );
  }
  return lines.join("\n");
}

export function formatCronShow(job: CronJobFile): string {
  const lines: string[] = [];
  lines.push("id: " + job.id);
  lines.push("path: " + job.path);
  lines.push("scope: " + job.scope);
  lines.push("agent: " + job.agent);
  lines.push("schedule: " + job.schedule);
  lines.push("enabled: " + String(job.enabled));
  lines.push("mode: " + job.mode);
  if (job.script !== undefined) lines.push("script: " + job.script);
  lines.push("");
  lines.push("# Prompt");
  lines.push("");
  lines.push(job.prompt);
  return lines.join("\n");
}

export function formatCronRuns(runs: CronRunSummary[]): string {
  if (runs.length === 0) {
    return "No run records found.";
  }
  const lines: string[] = [];
  const idWidth = Math.max(6, ...runs.map((r) => r.jobId.length));
  const statusWidth = 10;
  const deviceWidth = Math.max(6, ...runs.map((r) => r.device.length));
  lines.push(
    padRight("JOB ID", idWidth) + "  " + padRight("STATUS", statusWidth) + "  " + padRight("DEVICE", deviceWidth) + "  " + "STARTED",
  );
  lines.push(
    "-".repeat(idWidth) + "  " + "-".repeat(statusWidth) + "  " + "-".repeat(deviceWidth) + "  " + "-".repeat(19),
  );
  for (const run of runs) {
    const started = run.startedAt
      ? run.startedAt.slice(0, 19).replace("T", " ")
      : "";
    lines.push(
      padRight(run.jobId, idWidth) + "  " + padRight(run.status, statusWidth) + "  " + padRight(run.device, deviceWidth) + "  " + started,
    );
  }
  return lines.join("\n");
}

export function formatCronValidationReport(issues: CronValidationIssue[]): string {
  if (issues.length === 0) {
    return "Cron job validation: OK (no issues).";
  }
  const lines: string[] = [];
  lines.push("Cron job validation:");
  const errors = issues.filter((i) => i.severity === "error");
  const infos = issues.filter((i) => i.severity === "info");
  if (errors.length > 0) {
    lines.push("");
    lines.push("Errors (" + errors.length + "):");
    for (const issue of errors) {
      lines.push("  - " + issue.message);
    }
  }
  if (infos.length > 0) {
    lines.push("");
    lines.push("Notes (" + infos.length + "):");
    for (const issue of infos) {
      lines.push("  - " + issue.message);
    }
  }
  lines.push("");
  lines.push("Summary: " + errors.length + " error(s), " + infos.length + " note(s).");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Real filesystem adapter
// ---------------------------------------------------------------------------

/** Build CronWriteDeps backed by real node:fs/promises. */
export function createRealCronWriteDeps(): CronWriteDeps {
  return {
    readFile: (p: string) => readFile(p, "utf8"),
    writeFile: (p: string, c: string) => writeFile(p, c, "utf8"),
    mkdir: (p: string, opts?: { recursive?: boolean }) =>
      mkdir(p, opts).then(() => undefined),
    stat: (p: string) => stat(p),
    readdir: (p: string) =>
      readdir(p, { withFileTypes: true }) as unknown as Promise<
        { name: string; isDirectory(): boolean; isFile(): boolean }[]
      >,
  };
}
