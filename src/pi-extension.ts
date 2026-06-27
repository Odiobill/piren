import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { parse as parseYaml } from "yaml";
import { loadPirenContext, type BootstrapOptions, type PirenContext } from "./bootstrap.js";
import { createVaultTools } from "./vault-tools.js";
import { writeSessionSummary } from "./session.js";
import { buildPirenStatusReport, formatPirenStatusReport } from "./status.js";
import { registerDevice } from "./devices.js";
import { createInboxTask, claimInboxTask, listInboxTasks, updateInboxTaskStatus } from "./inbox.js";
import { createStewardAlert } from "./alerts.js";
import { loadVaultSkills, formatSkillCatalogForContext, type VaultSkill } from "./skills.js";
import {
  projectStatus,
  projectAppendLog,
  decisionRecord,
  projectUpdateHandoff,
  runbookWrite,
  skillCandidateWrite,
} from "./knowledge.js";
import {
  listCronJobs,
  listCronRuns,
  claimCronJob,
  recordCronRun,
  executeScriptCronJob,
  selectOwningDevice,
  listActiveDevices,
  isScheduleDue,
  type CronSchedule,
  type IsScheduleDueOptions,
} from "./cron.js";

interface ExtensionAPI {
  registerFlag?: (name: string, options: { description?: string; type?: string }) => void;
  getFlag?: (name: string) => unknown;
  registerTool: (tool: {
    name: string;
    label?: string;
    description?: string;
    parameters?: unknown;
    execute: (toolCallId: string, params: any) => Promise<unknown> | unknown;
  }) => void;
  registerCommand: (
    name: string,
    command: {
      description?: string;
      handler?: (args: any, ctx: { ui: { notify: (message: string, level?: string) => void } }) => Promise<unknown> | unknown;
      execute?: () => Promise<string> | string;
    },
  ) => void;
  on: (event: string, handler: (...args: any[]) => Promise<unknown> | unknown) => void;
}

const PIREN_TOOL_NAMES = [
  "vault_read",
  "vault_read_cached",
  "vault_write",
  "vault_list",
  "vault_patch",
  "vault_append_log",
  "session_write_summary",
  "flag_steward",
  "send_to_agent",
  "task_update_status",
  "task_claim",
  "inbox_list",
  "skill_list",
  "skill_read",
  "project_status",
  "project_append_log",
  "decision_record",
  "project_update_handoff",
  "runbook_write",
  "skill_candidate_write",
  "cron_list",
  "cron_claim",
  "cron_record_run",
  "cron_runs",
];

function textResult(text: string, details: unknown = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: message }],
    details: { error: message },
    isError: true,
  };
}

function formatList(entries: { path: string; type: string; bytes?: number }[]): string {
  if (entries.length === 0) return "No entries.";
  return entries.map((entry) => `${entry.type === "directory" ? "dir" : entry.type}\t${entry.path}${entry.bytes === undefined ? "" : `\t${entry.bytes} bytes`}`).join("\n");
}

function formatInboxTasks(tasks: { status: string; title: string; path: string; updated: string }[]): string {
  if (tasks.length === 0) return "No inbox tasks.";
  return tasks.map((task) => `${task.status}\t${task.title}\t${task.path}\tupdated=${task.updated}`).join("\n");
}

function formatCronJobs(jobs: { id: string; scope: string; schedule: string; agent: string; enabled: boolean; mode?: string; path: string }[], dueIds: Set<string>): string {
  if (jobs.length === 0) return "No cron jobs.";
  return jobs.map((job) => `${dueIds.has(job.id) ? "due" : "idle"}\t${job.id}\t${job.mode ?? "agent"}\t${job.scope}\t${job.schedule}\t${job.agent}\t${job.path}`).join("\n");
}

function formatCronRuns(runs: { status: string; jobId: string; device: string; startedAt: string; path: string }[]): string {
  if (runs.length === 0) return "No cron runs.";
  return runs.map((run) => `${run.status}\t${run.jobId}\t${run.device}\t${run.startedAt}\t${run.path}`).join("\n");
}

function defaultDeviceId(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string {
  return (env.PIREN_DEVICE_ID || hostname())
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "local-device";
}

function deviceHostname(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string {
  return env.PIREN_HOSTNAME || hostname();
}

function isWorkerMode(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  return env.PIREN_WORKER === "1" || env.PIREN_WORKER === "true";
}

function canPollInbox(context: PirenContext): boolean {
  return context.allowedAgents.includes(context.agentName) && !context.excludedAgents.includes(context.agentName);
}

async function pollIntervalMs(context: PirenContext, env: NodeJS.ProcessEnv | Record<string, string | undefined>): Promise<number> {
  const envValue = env.PIREN_WORKER_POLL_INTERVAL_MS;
  if (envValue !== undefined && envValue.trim() !== "") {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  try {
    const parsed = parseYaml(await readFile(context.paths.config, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && "poll_interval_active_seconds" in parsed) {
      const seconds = Number((parsed as { poll_interval_active_seconds?: unknown }).poll_interval_active_seconds);
      if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    }
  } catch {
    // Fall back to the default interval when agent-local config is unavailable or malformed.
  }
  return 60_000;
}

function localOutboxDir(context: PirenContext, env: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
  return env.PIREN_LOCAL_OUTBOX_DIR || join(homedir(), ".local", "state", "piren", "outbox", context.agentName);
}

function localCacheDir(context: PirenContext, env: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
  return env.PIREN_LOCAL_CACHE_DIR || join(homedir(), ".local", "state", "piren", "cache", context.agentName);
}

// Default staleness for cron device heartbeats. A device whose last_seen is
// older than this is treated as offline and its claims are recoverable. Mirrors
// the inbox stale-claim principle; overridable per-job via stale_after_seconds.
const DEFAULT_CRON_STALE_MS = 5 * 60 * 1000;

function cronStaleAfterMs(env: NodeJS.ProcessEnv | Record<string, string | undefined>): number {
  const envValue = env.PIREN_CRON_STALE_MS;
  if (envValue !== undefined && envValue.trim() !== "") {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_CRON_STALE_MS;
}

function scriptCronTimeoutMs(env: NodeJS.ProcessEnv | Record<string, string | undefined>): number {
  const envValue = env.PIREN_SCRIPT_CRON_TIMEOUT_MS;
  if (envValue !== undefined && envValue.trim() !== "") {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 60_000;
}

// Build isScheduleDue options respecting exactOptionalPropertyTypes: lastRun
// is omitted (never passed as explicit undefined) when the job has no last run.
function jobIsDue(job: { schedule: CronSchedule; lastRun?: Date }, now: Date): boolean {
  const options: IsScheduleDueOptions = { schedule: job.schedule, now };
  if (job.lastRun !== undefined) options.lastRun = job.lastRun;
  return isScheduleDue(options);
}

function contextPrompt(context: PirenContext, skills: VaultSkill[] = []): string {
  const lines = [
    "# Piren Context",
    `agent_name: ${context.agentName}`,
    `agent_dir: ${context.agentDir}`,
    `vault_root: ${context.vaultRoot}`,
    "",
    "## Steward Directives",
    context.stewardDirectives,
    "",
    "## SOUL.md",
    context.soul,
    "",
    "Use explicit Piren vault tools for vault access:",
    "- vault_read(path)",
    "- vault_read_cached(path)",
    "- vault_write(path, content)",
    "- vault_list(path)",
    "- vault_patch(path, old_text, new_text)",
    "- vault_append_log(path, entry)",
    "- session_write_summary(summary, title?)",
    "- flag_steward(title, body, severity?, notify?)",
    "- send_to_agent(to, title, body)",
    "- task_update_status(task_path, status, result?)",
    "- task_claim(task_path, device_id?, stale_after_ms?)",
    "- inbox_list()",
    "- project_status(project)",
    "- project_append_log(project, entry)",
    "- decision_record(project, id, title, context, decision, consequences?, alternatives?)",
    "- project_update_handoff(project, content)",
    "- runbook_write(project, title, content)",
    "- skill_candidate_write(name, description, body, scope?)",
    "- cron_list()",
    "- cron_claim(job_path, stale_after_ms?)",
    "- cron_record_run(job_path, status, result, started_at, finished_at)",
    "- cron_runs(job_id?)",
    "All vault paths resolve relative to vault_root and traversal outside the vault is rejected.",
    "",
    "## Knowledge Lifecycle",
    "After non-trivial work, leave a durable artifact so future sessions do not rediscover it.",
    "Use project_status to read a project's current state, project_append_log for chronological",
    "project log entries, decision_record for architecture decisions, project_update_handoff",
    "for fresh-session continuity, runbook_write for repeated operations, and",
    "skill_candidate_write for reviewable reusable procedures. Update the minimum",
    "useful artifact, not everything. Raw traces are evidence; project docs and ADRs are",
    "synthesized truth. Skill candidates are drafts, not active skills until promoted.",
    "",
    "## Inbox Behavior",
    "Do not check the inbox automatically at the start of a direct conversation.",
    "Use inbox_list() only when the steward explicitly asks you to check the inbox,",
    "or when running in worker mode (PIREN_WORKER=1). In a direct conversation,",
    "wait for the steward to direct the work.",
    "",
    "## Vault-Backed Cron (ADR-0019 + ADR-0023)",
    "Scheduled work is file-backed and inspectable. cron_list() shows due jobs,",
    "cron_claim() atomically claims one for this device, cron_record_run() writes",
    "an inspectable run record and restores the job, and cron_runs(job_id?) shows",
    "history. Agent-mode jobs are surfaced in worker mode for explicit claim/run/record.",
    "Script-mode jobs (mode: script, script: <vault path>) are executed directly by",
    "worker mode with no agent prompt and recorded as run records. Do not run cron jobs",
    "automatically in a direct conversation. Secrets never belong in cron job files or scripts.",
  ];

  const skillsSection = formatSkillCatalogForContext(skills);
  if (skillsSection) {
    lines.push("", skillsSection);
  }

  return lines.join("\n");
}

export default async function pirenExtension(pi: ExtensionAPI, testOptions: BootstrapOptions = {}) {
  pi.registerFlag?.("agent-dir", {
    description: "Piren agent directory, e.g. /mnt/nas/Documents/vault/team/piren",
    type: "string",
  });
  pi.registerFlag?.("agent", {
    description: "Piren agent name, e.g. piren",
    type: "string",
  });
  pi.registerFlag?.("vault-root", {
    description: "Piren vault root, e.g. /mnt/nas/Documents/vault",
    type: "string",
  });

  const cliAgentDir = testOptions.cliAgentDir ?? (typeof pi.getFlag === "function" ? String(pi.getFlag("agent-dir") || "") || undefined : undefined);
  const cliAgent = testOptions.cliAgent ?? (typeof pi.getFlag === "function" ? String(pi.getFlag("agent") || "") || undefined : undefined);
  const cliVaultRoot = testOptions.cliVaultRoot ?? (typeof pi.getFlag === "function" ? String(pi.getFlag("vault-root") || "") || undefined : undefined);
  const context = await loadPirenContext({
    ...testOptions,
    cliAgentDir,
    cliAgent,
    cliVaultRoot,
    env: testOptions.env ?? process.env,
  });
  const env = testOptions.env ?? process.env;
  const outboxDir = localOutboxDir(context, env);
  const cacheDir = localCacheDir(context, env);
  const device = await registerDevice({
    vaultRoot: context.vaultRoot,
    agentName: context.agentName,
    deviceId: defaultDeviceId(env),
    hostname: deviceHostname(env),
  });
  const tools = createVaultTools({ vaultRoot: context.vaultRoot, localOutboxDir: outboxDir, localCacheDir: cacheDir });

  // Load vault skills (ADR-0014) at extension startup. Shared skills come from
  // vault/skills/; agent-specific skills come from team/<agent>/skills/ and
  // override shared skills with the same name. Skills are injected into the
  // agent context prompt as available procedures.
  const { skills } = await loadVaultSkills(context.vaultRoot, context.agentName);

  pi.registerTool({
    name: "vault_read",
    label: "Vault Read",
    description: "Read a UTF-8 text file from the Piren vault. Path is relative to the vault root. Traversal outside the vault is rejected.",
    parameters: Type.Object({
      path: Type.String({ description: "Path relative to the Piren vault root" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await tools.vaultRead(params.path);
        return textResult(result.content, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "vault_read_cached",
    label: "Vault Read Cached",
    description: "Explicitly read a UTF-8 text file from Piren's non-authoritative local cache. Path mirrors the vault path. Traversal outside the cache is rejected. This does not sync or repair authoritative vault state.",
    parameters: Type.Object({
      path: Type.String({ description: "Path relative to the Piren vault root, mirrored inside the local cache" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await tools.vaultReadCached(params.path);
        return textResult(result.content, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "vault_write",
    label: "Vault Write",
    description: "Atomically write a UTF-8 text file inside the Piren vault. Path is relative to the vault root. Traversal outside the vault is rejected.",
    parameters: Type.Object({
      path: Type.String({ description: "Path relative to the Piren vault root" }),
      content: Type.String({ description: "Full file content to write" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await tools.vaultWrite(params.path, params.content);
        if ("path" in result) {
          return textResult(`Wrote ${result.path} (${result.bytes} bytes, atomic rename)`, result);
        }
        return textResult(`Queued blocked vault write to local outbox: ${result.outboxPath}`, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "vault_list",
    label: "Vault List",
    description: "List files and directories inside a Piren vault directory. Path is relative to the vault root. Traversal outside the vault is rejected.",
    parameters: Type.Object({
      path: Type.String({ description: "Directory path relative to the Piren vault root" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await tools.vaultList(params.path);
        return textResult(formatList(result.entries), result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "vault_patch",
    label: "Vault Patch",
    description: "Atomically replace one exact text occurrence in a UTF-8 file inside the Piren vault. Path is relative to the vault root. Traversal outside the vault is rejected.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to the Piren vault root" }),
      old_text: Type.String({ description: "Exact text to replace. It must appear exactly once." }),
      new_text: Type.String({ description: "Replacement text" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await tools.vaultPatch(params.path, params.old_text, params.new_text);
        return textResult(`Patched ${result.path} (${result.replacements} replacement, ${result.bytes} bytes, atomic rename)`, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "vault_append_log",
    label: "Vault Append Log",
    description: "Append a timestamped Markdown log entry to a file inside the Piren vault. Path is relative to the vault root. Traversal outside the vault is rejected.",
    parameters: Type.Object({
      path: Type.String({ description: "Log file path relative to the Piren vault root" }),
      entry: Type.String({ description: "Markdown log entry body" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await tools.vaultAppendLog(params.path, params.entry);
        return textResult(`Appended log entry to ${result.path} at ${result.timestamp} (${result.bytesAppended} bytes appended)`, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "session_write_summary",
    label: "Session Write Summary",
    description: "Write a Markdown session summary under team/<agent>/sessions in the Piren vault.",
    parameters: Type.Object({
      summary: Type.String({ description: "Session summary body" }),
      title: Type.Optional(Type.String({ description: "Optional summary title" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await writeSessionSummary({
          vaultRoot: context.vaultRoot,
          agentName: context.agentName,
          agentDir: context.agentDir,
          summary: params.summary,
          title: params.title,
        });
        return textResult(`Wrote session summary to ${result.path}`, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "flag_steward",
    label: "Flag Steward",
    description: "Create one authoritative Markdown alert file under steward-inbox/alerts/ for steward attention. Optional gateway notification is represented by alert metadata only.",
    parameters: Type.Object({
      title: Type.String({ description: "Alert title" }),
      body: Type.String({ description: "Alert body/details" }),
      severity: Type.Optional(Type.String({ description: "Alert severity: low, normal, high, or urgent" })),
      notify: Type.Optional(Type.Boolean({ description: "Whether gateways should notify the steward when available" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const alertOptions = {
          vaultRoot: context.vaultRoot,
          from: context.agentName,
          title: params.title,
          body: params.body,
        } as {
          vaultRoot: string;
          from: string;
          title: string;
          body: string;
          severity?: "low" | "normal" | "high" | "urgent";
          notify?: boolean;
        };
        if (params.severity !== undefined) alertOptions.severity = params.severity as "low" | "normal" | "high" | "urgent";
        if (params.notify !== undefined) alertOptions.notify = params.notify;
        const result = await createStewardAlert(alertOptions);
        return textResult(`Created steward alert ${result.path}`, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "send_to_agent",
    label: "Send To Agent",
    description: "Create one pending Markdown task file in another Piren agent's inbox under team/<agent>/inbox/.",
    parameters: Type.Object({
      to: Type.String({ description: "Target agent name, lowercase kebab-case" }),
      title: Type.String({ description: "Task title" }),
      body: Type.String({ description: "Task body/instructions" }),
      priority: Type.Optional(Type.String({ description: "Task priority: low, normal, high, or urgent" })),
      requires_approval: Type.Optional(Type.Boolean({ description: "Whether the task requires steward approval" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const taskOptions = {
          vaultRoot: context.vaultRoot,
          from: context.agentName,
          to: params.to,
          title: params.title,
          body: params.body,
        } as {
          vaultRoot: string;
          from: string;
          to: string;
          title: string;
          body: string;
          priority?: "low" | "normal" | "high" | "urgent";
          requiresApproval?: boolean;
        };
        if (params.priority !== undefined) taskOptions.priority = params.priority as "low" | "normal" | "high" | "urgent";
        if (params.requires_approval !== undefined) taskOptions.requiresApproval = params.requires_approval;
        const result = await createInboxTask(taskOptions);
        return textResult(`Created task ${result.path} for ${result.to}`, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "task_update_status",
    label: "Task Update Status",
    description: "Update status and optional result text for one Piren inbox task file.",
    parameters: Type.Object({
      task_path: Type.String({ description: "Task file path relative to vault root, under team/<agent>/inbox/" }),
      status: Type.String({ description: "New task status: pending, in_progress, completed, or cancelled" }),
      result: Type.Optional(Type.String({ description: "Optional replacement text for the task Result section" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const updateOptions = {
          vaultRoot: context.vaultRoot,
          taskPath: params.task_path,
          status: params.status as "pending" | "in_progress" | "completed" | "cancelled",
        } as {
          vaultRoot: string;
          taskPath: string;
          status: "pending" | "in_progress" | "completed" | "cancelled";
          result?: string;
        };
        if (params.result !== undefined) updateOptions.result = params.result;
        const result = await updateInboxTaskStatus(updateOptions);
        return textResult(`Updated task ${result.path} to ${result.status}`, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "task_claim",
    label: "Task Claim",
    description: "Claim one selected-agent inbox task by atomically renaming it to a .claimed.<device>.md path. This does not poll automatically.",
    parameters: Type.Object({
      task_path: Type.String({ description: "Task file path relative to vault root, under the selected agent's inbox" }),
      device_id: Type.Optional(Type.String({ description: "Claiming device id, lowercase kebab-case. Defaults to sanitized hostname." })),
      stale_after_ms: Type.Optional(Type.Number({ description: "If task_path is already claimed, reclaim it only when the previous device last_seen is older than this many milliseconds." })),
      now: Type.Optional(Type.String({ description: "Optional ISO timestamp for stale-claim checks, mainly for tests." })),
    }),
    async execute(_toolCallId, params) {
      try {
        const claimOptions = {
          vaultRoot: context.vaultRoot,
          agentName: context.agentName,
          taskPath: params.task_path,
          deviceId: params.device_id || defaultDeviceId(),
        } as {
          vaultRoot: string;
          agentName: string;
          taskPath: string;
          deviceId: string;
          staleAfterMs?: number;
          now?: () => Date;
        };
        if (params.stale_after_ms !== undefined) claimOptions.staleAfterMs = params.stale_after_ms;
        if (params.now !== undefined) {
          const now = params.now;
          claimOptions.now = () => new Date(now);
        }
        const result = await claimInboxTask(claimOptions);
        return textResult(`Claimed task ${result.originalPath} as ${result.path}`, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "inbox_list",
    label: "Inbox List",
    description: "List the selected local Piren agent's inbox tasks without claiming or mutating them.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const result = await listInboxTasks({ vaultRoot: context.vaultRoot, agentName: context.agentName });
        return textResult(formatInboxTasks(result.tasks), result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "skill_list",
    label: "Skill List",
    description: "List available Piren vault skills as a compact catalog. Full skill bodies are loaded with skill_read(name).",
    parameters: Type.Object({}),
    async execute() {
      const catalog = skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        source: skill.source,
        path: skill.path,
      }));
      return textResult(formatSkillCatalogForContext(skills) || "No skills available.", { skills: catalog });
    },
  });

  pi.registerTool({
    name: "skill_read",
    label: "Skill Read",
    description: "Read the full body of one available Piren vault skill by name. Use this when a task matches a listed skill.",
    parameters: Type.Object({
      name: Type.String({ description: "Skill name from skill_list" }),
    }),
    async execute(_toolCallId, params) {
      const skill = skills.find((entry) => entry.name === params.name);
      if (!skill) {
        return errorResult(new Error(`Unknown skill: ${params.name}`));
      }
      const text = [`# ${skill.name}`, `Source: ${skill.source}`, `Path: ${skill.path}`];
      if (skill.description) text.push(`Description: ${skill.description}`);
      text.push("", skill.body);
      return textResult(text.join("\n"), skill);
    },
  });

  pi.registerTool({
    name: "project_status",
    label: "Project Status",
    description: "Read a project's current title, status, and updated date from its index.md frontmatter under Projects/<project>/ in the Piren vault. Read-only.",
    parameters: Type.Object({
      project: Type.String({ description: "Project name, matching the directory under Projects/" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await projectStatus({ vaultRoot: context.vaultRoot, project: params.project });
        if (!result.available) {
          return textResult(`Project '${params.project}' has no index.md.`, result);
        }
        return textResult(`Project ${result.project}: status=${result.status}, updated=${result.updated}, title=${result.title}`, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "project_append_log",
    label: "Project Append Log",
    description: "Append a timestamped Markdown entry to Projects/<project>/log.md in the Piren vault. The project log is the chronological change history.",
    parameters: Type.Object({
      project: Type.String({ description: "Project name, matching the directory under Projects/" }),
      entry: Type.String({ description: "Markdown log entry body" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await projectAppendLog({
          vaultRoot: context.vaultRoot,
          project: params.project,
          entry: params.entry,
          agentName: context.agentName,
        });
        return textResult(`Appended project log entry to ${result.path} at ${result.timestamp} (${result.bytesAppended} bytes appended)`, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "decision_record",
    label: "Decision Record",
    description: "Write one Architecture Decision Record under Projects/<project>/decisions/ADR-<id>-<slug>.md in the Piren vault. The id is a 4-digit number.",
    parameters: Type.Object({
      project: Type.String({ description: "Project name, matching the directory under Projects/" }),
      id: Type.String({ description: "4-digit ADR id, for example '0015'" }),
      title: Type.String({ description: "ADR title" }),
      context: Type.String({ description: "Why this decision is needed" }),
      decision: Type.String({ description: "The decision itself" }),
      consequences: Type.Optional(Type.String({ description: "Optional consequences of the decision" })),
      alternatives: Type.Optional(Type.String({ description: "Optional alternatives considered" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const adrOptions = {
          vaultRoot: context.vaultRoot,
          project: params.project,
          id: params.id,
          title: params.title,
          context: params.context,
          decision: params.decision,
        } as {
          vaultRoot: string;
          project: string;
          id: string;
          title: string;
          context: string;
          decision: string;
          consequences?: string;
          alternatives?: string;
        };
        if (params.consequences !== undefined) adrOptions.consequences = params.consequences;
        if (params.alternatives !== undefined) adrOptions.alternatives = params.alternatives;
        const result = await decisionRecord(adrOptions);
        return textResult(`Wrote ADR ${result.path} (${result.bytes} bytes, atomic)`, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "project_update_handoff",
    label: "Project Update Handoff",
    description: "Update Projects/<project>/handoff-prompt.md with the next-session handoff. This is explicit and inspectable, not hidden memory mutation.",
    parameters: Type.Object({
      project: Type.String({ description: "Project name, matching the directory under Projects/" }),
      content: Type.String({ description: "Full Markdown content for the handoff prompt" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await projectUpdateHandoff({
          vaultRoot: context.vaultRoot,
          project: params.project,
          content: params.content,
        });
        return textResult(`Updated project handoff ${result.path} (${result.bytes} bytes, atomic)`, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "runbook_write",
    label: "Runbook Write",
    description: "Write a reviewed operational runbook under Projects/<project>/runbooks/<slug>.md.",
    parameters: Type.Object({
      project: Type.String({ description: "Project name, matching the directory under Projects/" }),
      title: Type.String({ description: "Runbook title" }),
      content: Type.String({ description: "Runbook Markdown body" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await runbookWrite({
          vaultRoot: context.vaultRoot,
          project: params.project,
          title: params.title,
          content: params.content,
        });
        return textResult(`Wrote runbook ${result.path} (${result.bytes} bytes, atomic)`, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "skill_candidate_write",
    label: "Skill Candidate Write",
    description: "Draft a reusable procedure as a reviewable skill candidate. Candidates are not active skills until promoted.",
    parameters: Type.Object({
      name: Type.String({ description: "Candidate skill name, lowercase with dashes or underscores" }),
      description: Type.String({ description: "One-line candidate description" }),
      body: Type.String({ description: "Candidate skill Markdown body" }),
      scope: Type.Optional(Type.String({ description: "Optional project name for a project-scoped candidate. Omit for shared skill-candidates/." })),
    }),
    async execute(_toolCallId, params) {
      try {
        const candidateOptions = {
          vaultRoot: context.vaultRoot,
          name: params.name,
          description: params.description,
          body: params.body,
        } as {
          vaultRoot: string;
          name: string;
          description: string;
          body: string;
          scope?: string;
        };
        if (params.scope !== undefined) candidateOptions.scope = params.scope;
        const result = await skillCandidateWrite(candidateOptions);
        return textResult(`Wrote skill candidate ${result.path} (${result.bytes} bytes, atomic)`, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  // --- Vault-backed cron (ADR-0019) -------------------------------------
  // These tools are inspectable and available in any session, but the worker
  // surfacing (session_start below) is the only path that runs jobs
  // automatically. In a direct conversation the agent should only use them when
  // the steward asks.

  pi.registerTool({
    name: "cron_list",
    label: "Cron List",
    description: "List unclaimed, enabled cron jobs from cron/jobs/ and team/<agent>/cron/jobs/, marking each as due or idle based on its schedule and last run.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const now = new Date();
        const result = await listCronJobs({ vaultRoot: context.vaultRoot, agentName: context.agentName, now: () => now });
        const dueIds = new Set<string>();
        for (const job of result.jobs) {
          if (jobIsDue(job, now)) {
            dueIds.add(job.id);
          }
        }
        const compact = result.jobs.map((job) => ({
          id: job.id,
          scope: job.scope,
          schedule: job.schedule.describe(),
          agent: job.agent,
          enabled: job.enabled,
          mode: job.mode,
          path: job.path,
          due: dueIds.has(job.id),
        }));
        return textResult(formatCronJobs(compact, dueIds), { jobs: compact });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "cron_claim",
    label: "Cron Claim",
    description: "Atomically claim one cron job for this device by renaming it to a .claimed.<device>.md path. Worker-mode coordination primitive; do not call automatically in direct conversations.",
    parameters: Type.Object({
      job_path: Type.String({ description: "Job file path relative to vault root, under cron/jobs/ or team/<agent>/cron/jobs/" }),
      device_id: Type.Optional(Type.String({ description: "Claiming device id, lowercase kebab-case. Defaults to sanitized hostname." })),
      stale_after_ms: Type.Optional(Type.Number({ description: "If the job is already claimed, reclaim it only when the previous device heartbeat is older than this many milliseconds." })),
    }),
    async execute(_toolCallId, params) {
      try {
        const claimOptions = {
          vaultRoot: context.vaultRoot,
          jobPath: params.job_path,
          deviceId: params.device_id || defaultDeviceId(),
          agentName: context.agentName,
        } as {
          vaultRoot: string;
          jobPath: string;
          deviceId: string;
          agentName: string;
          staleAfterMs?: number;
        };
        if (params.stale_after_ms !== undefined) claimOptions.staleAfterMs = params.stale_after_ms;
        const result = await claimCronJob(claimOptions);
        return textResult(`Claimed cron job ${result.originalPath} as ${result.path}`, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "cron_record_run",
    label: "Cron Record Run",
    description: "Write an inspectable cron run record under cron/runs/ or team/<agent>/cron/runs/ and restore the unclaimed job with last_run updated. Use status 'completed' or 'failed'.",
    parameters: Type.Object({
      job_path: Type.String({ description: "The CLAIMED job path returned by cron_claim, e.g. cron/jobs/x.claimed.<device>.md" }),
      status: Type.String({ description: "Run status: completed or failed" }),
      result: Type.String({ description: "Run result summary / output text" }),
      started_at: Type.String({ description: "ISO timestamp when the run started" }),
      finished_at: Type.String({ description: "ISO timestamp when the run finished" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const status = params.status as "completed" | "failed";
        if (status !== "completed" && status !== "failed") {
          throw new Error("status must be 'completed' or 'failed'");
        }
        // The claiming device is encoded in the claimed path
        // (jobs/<id>.claimed.<device>.md); trust it rather than the runtime
        // hostname so the run record reflects who actually claimed the job.
        const deviceMatch = params.job_path.match(/\.claimed\.([a-z][a-z0-9-]*)\.md$/i);
        const deviceId = deviceMatch?.[1] ?? defaultDeviceId();
        const result = await recordCronRun({
          vaultRoot: context.vaultRoot,
          jobPath: params.job_path,
          agentName: context.agentName,
          deviceId,
          status,
          result: params.result,
          startedAt: new Date(params.started_at),
          finishedAt: new Date(params.finished_at),
        });
        return textResult(`Recorded cron run ${result.runPath} and restored job ${result.restoredJobPath}`, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "cron_runs",
    label: "Cron Runs",
    description: "List cron run records newest-first across cron/runs/ and team/<agent>/cron/runs/. Optionally filter by job_id. Read-only.",
    parameters: Type.Object({
      job_id: Type.Optional(Type.String({ description: "Optional job id to filter run records" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const listOptions = { vaultRoot: context.vaultRoot, agentName: context.agentName } as {
          vaultRoot: string;
          agentName: string;
          jobId?: string;
        };
        if (params.job_id !== undefined) listOptions.jobId = params.job_id;
        const result = await listCronRuns(listOptions);
        return textResult(formatCronRuns(result.runs), { runs: result.runs });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerCommand("piren_status", {
    description: "Show Piren agent, vault, runnable-agent policy, packages, tools, and degraded write mode",
    handler: async (_args, ctx) => {
      const report = await buildPirenStatusReport({
        context,
        toolNames: PIREN_TOOL_NAMES,
        localOutboxDir: outboxDir,
        localCacheDir: cacheDir,
        skillCount: skills.length,
      });
      ctx.ui.notify(formatPirenStatusReport(report), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(`Piren loaded: ${context.agentName} at ${context.agentDir}; vault_root=${context.vaultRoot}; device=${device.deviceId}`, "info");
    if (!isWorkerMode(env)) return;
    if (!canPollInbox(context)) {
      ctx.ui.notify(`Piren worker polling disabled: '${context.agentName}' is not explicitly allowed by local allowed_agents policy.`, "warning");
      return;
    }
    const poll = async () => {
      try {
        const result = await listInboxTasks({ vaultRoot: context.vaultRoot, agentName: context.agentName });
        ctx.ui.notify(`Worker inbox poll: ${result.tasks.length} task(s) available${result.tasks.length === 0 ? "" : `\n${formatInboxTasks(result.tasks)}`}`, "info");
      } catch (error) {
        ctx.ui.notify(`Worker inbox poll failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    };
    await poll();
    const interval = setInterval(() => {
      void poll();
    }, await pollIntervalMs(context, env));
    interval.unref?.();

    // ADR-0019: surface due cron jobs this device should own. Worker mode reads
    // job files, checks due-ness and active-device-priority ownership, and
    // notifies the agent. It does not auto-run jobs; the agent claims and runs
    // them via cron_claim + cron_record_run so every run is inspectable.
    const surfaceCron = async () => {
      try {
        const now = new Date();
        const staleMs = cronStaleAfterMs(env);
        const jobsResult = await listCronJobs({ vaultRoot: context.vaultRoot, agentName: context.agentName, now: () => now });
        const devices = await listActiveDevices({ vaultRoot: context.vaultRoot, agentName: context.agentName, staleAfterMs: staleMs, now: () => now });
        const owned: string[] = [];
        for (const job of jobsResult.jobs) {
          if (!jobIsDue(job, now)) continue;
          const ownedResult = selectOwningDevice({ devicePolicy: job.devicePolicy, activeDevices: devices.devices, deviceId: device.deviceId });
          if (!ownedResult.owns) continue;
          if (job.mode === "script") {
            const run = await executeScriptCronJob({
              vaultRoot: context.vaultRoot,
              jobPath: job.path,
              agentName: context.agentName,
              deviceId: device.deviceId,
              staleAfterMs: staleMs,
              timeoutMs: scriptCronTimeoutMs(env),
              env,
            });
            ctx.ui.notify(`Worker cron script: ${run.status} ${job.id} exit=${run.exitCode === null ? "" : run.exitCode} run=${run.runPath}`, run.status === "completed" ? "info" : "error");
          } else {
            owned.push(`${job.id}\t${job.scope}\t${job.schedule.describe()}\t${job.path}`);
          }
        }
        if (owned.length > 0) {
          ctx.ui.notify(`Worker cron: ${owned.length} due job(s) owned by this device\n${owned.join("\n")}\nUse cron_claim then cron_record_run to execute.`, "info");
        } else {
          ctx.ui.notify("Worker cron: no due jobs owned by this device.", "info");
        }
      } catch (error) {
        ctx.ui.notify(`Worker cron surface failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    };
    await surfaceCron();
    const cronInterval = setInterval(() => {
      void surfaceCron();
    }, await pollIntervalMs(context, env));
    cronInterval.unref?.();
  });

  (pi.on as any)("before_agent_start", async () => ({
    message: {
      customType: "piren-context",
      content: contextPrompt(context, skills),
      display: `Piren context loaded for ${context.agentName}`,
      details: {
        agentName: context.agentName,
        agentDir: context.agentDir,
        vaultRoot: context.vaultRoot,
      },
    },
  }));
}
