import { hostname } from "node:os";
import { resolve } from "node:path";
import {
  DEFAULT_CONFIG_PATH,
  readYamlConfig,
  resolveEnabledAgents,
} from "./scheduler-cli.js";
import {
  claimInboxTask,
  listInboxTasks,
  type ClaimInboxTaskOptions,
  type ClaimInboxTaskResult,
} from "./inbox.js";
import {
  claimCronJob,
  isScheduleDue,
  listActiveDevices,
  listCronJobs,
  type ClaimCronJobOptions,
  type ClaimCronJobResult,
  type CronJob,
  type ExecuteScriptCronJobResult,
  type IsScheduleDueOptions,
} from "./cron.js";
import { planSchedulerTick, type PlannerCronJob, type PlannerTask } from "./scheduler.js";
import { registerDevice } from "./devices.js";
import type { ExecuteClaimedInboxTaskResult, ClaimedInboxTaskRunner } from "./scheduler-executor.js";
import {
  executeClaimedAgentCronJob,
  type ClaimedCronJobRunner,
  type ExecuteClaimedAgentCronJobOptions,
  type ExecuteClaimedAgentCronJobResult,
} from "./scheduler-cron-executor.js";
import { executeScriptCronJob, type ExecuteScriptCronJobOptions } from "./cron.js";
import { executeClaimedInboxTask } from "./scheduler-executor.js";

// ---------------------------------------------------------------------------
// Scheduler one-shot tick (ADR-0029 / O7 S4)
// ---------------------------------------------------------------------------
//
// One live scheduler tick: refresh local device heartbeats, plan eligible work
// from local allowed-agent policy (minus excluded_agents), attempt atomic
// claims in priority order, execute AT MOST ONE successfully claimed work
// item, then stop. This is the safe execution primitive S5 will later wrap in
// an explicit loop.
//
// Claim and execute are kept as injected seams so unit tests can fake them;
// production wiring uses the real claim functions and createAskRunner()-backed
// executors (see createSchedulerExecutors).

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
export const defaultClaims: SchedulerOnceClaims = {
  claimInboxTask,
  claimCronJob,
};

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function noWorkResult(deviceId: string, enabledAgents: string[], summary: string): SchedulerOnceResult {
  return {
    deviceId,
    enabledAgents,
    plannedCount: 0,
    claimAttempts: [],
    executed: false,
    noWork: true,
    summary,
  };
}

function formatSummary(result: SchedulerOnceResult): string {
  const lines: string[] = [`SCHEDULER ONCE (device: ${result.deviceId})`];
  lines.push(`enabled agents: ${result.enabledAgents.join(", ") || "(none)"}`);
  lines.push(`planned claims: ${result.plannedCount}`);
  if (result.claimAttempts.length > 0) {
    lines.push("claim attempts:");
    for (const attempt of result.claimAttempts) {
      const tag = attempt.outcome === "executed" ? "[EXEC]" : attempt.outcome === "claim_failed" ? "[SKIP]" : "[FAIL]";
      const reason = attempt.reason !== undefined ? ` - ${attempt.reason}` : "";
      lines.push(`  ${tag} ${attempt.itemType} ${attempt.itemPath} (agent ${attempt.agentName})${reason}`);
    }
  }
  if (result.executed) {
    lines.push(`executed: yes (${result.executedItemType}, ${result.executedItemPath})`);
    if (result.executionStatus !== undefined) lines.push(`execution status: ${result.executionStatus}`);
  } else {
    lines.push("executed: no");
  }
  if (result.noWork) lines.push("no work to execute this tick.");
  return lines.join("\n") + "\n";
}

/**
 * Run one scheduler tick and execute at most one successfully claimed work
 * item. See module docstring for the full flow.
 */
export async function schedulerOnce(options: SchedulerOnceOptions): Promise<SchedulerOnceResult> {
  const deviceId = options.deviceId ?? hostname();
  const staleAfterMs = options.staleAfterMs ?? 300_000;
  const now = options.now ?? (() => new Date());
  const claims = options.claims ?? defaultClaims;
  const executors = options.executors;
  const host = options.hostname ?? deviceId;

  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const config = await readYamlConfig(configPath);
  const vaultRoot = config.vault_root;

  if (!vaultRoot) {
    return noWorkResult(
      deviceId,
      [],
      `SCHEDULER ONCE (device: ${deviceId})\n\nNo vault root configured. Set vault_root in ~/.config/piren/config.yml.\n`,
    );
  }

  const enabledAgents = resolveEnabledAgents(config);
  if (enabledAgents.length === 0) {
    return noWorkResult(
      deviceId,
      enabledAgents,
      `SCHEDULER ONCE (device: ${deviceId})\n\nNo enabled agents. Configure allowed_agents in local config.\nno work to execute this tick.\n`,
    );
  }

  const root = resolve(vaultRoot);

  // 1. Refresh this device heartbeat for each enabled agent. registerDevice
  //    preserves a manually edited priority unless an explicit override is
  //    passed (ADR-0029). Agent dirs missing from the vault are skipped.
  for (const agentName of enabledAgents) {
    try {
      await registerDevice({ vaultRoot: root, agentName, deviceId, hostname: host, now });
    } catch {
      // Skip agents whose vault dir is missing; they have no work to plan.
    }
  }

  // 2. Load pending inbox tasks, due cron jobs, and active devices.
  const pendingTasks: PlannerTask[] = [];
  const dueCronJobs: PlannerCronJob[] = [];
  const cronJobsByPath = new Map<string, CronJob>();

  for (const agentName of enabledAgents) {
    try {
      const inboxResult = await listInboxTasks({ vaultRoot: root, agentName });
      for (const task of inboxResult.tasks) {
        if (task.status === "pending") {
          pendingTasks.push({ path: task.path, agentName, status: "pending" });
        }
      }
    } catch {
      // Agent inbox may not exist yet; skip.
    }
    try {
      const cronResult = await listCronJobs({ vaultRoot: root, agentName, now });
      for (const job of cronResult.jobs) {
        // Only schedule jobs that are actually due at this instant, so a
        // repeated --once tick (and the S5 loop) does not re-execute a job
        // that already ran this cycle. Jobs with no last_run are due
        // immediately; interval/cron dedup prevents immediate re-runs.
        const dueOpts: IsScheduleDueOptions = { schedule: job.schedule, now: now() };
        if (job.lastRun !== undefined) dueOpts.lastRun = job.lastRun;
        if (!isScheduleDue(dueOpts)) continue;
        cronJobsByPath.set(job.path, job);
        dueCronJobs.push({
          path: job.path,
          agentName: job.agent,
          devicePolicy: job.devicePolicy,
        });
      }
    } catch {
      // Agent cron dir may not exist yet; skip.
    }
  }

  const activeDevices = new Map<string, { deviceId: string; priority: number }[]>();
  for (const agentName of enabledAgents) {
    try {
      const devicesResult = await listActiveDevices({ vaultRoot: root, agentName, staleAfterMs, now });
      activeDevices.set(
        agentName,
        devicesResult.devices.map((d) => ({ deviceId: d.deviceId, priority: d.priority })),
      );
    } catch {
      activeDevices.set(agentName, []);
    }
  }

  // 3. Plan proposed claims (pure).
  const planned = planSchedulerTick({
    enabledAgents,
    pendingTasks,
    dueCronJobs,
    activeDevices,
    deviceId,
    staleAfterMs,
    now: now(),
  });

  // 4. Walk planned claims in priority order; claim first, execute only on
  //    success, skip failures, stop after the first execution attempt.
  const claimAttempts: SchedulerOnceClaimAttempt[] = [];
  let executed = false;
  let executedItemType: SchedulerItemType | undefined;
  let executedItemPath: string | undefined;
  let executedAgentName: string | undefined;
  let executionStatus: string | undefined;
  let executionSummary: string | undefined;

  for (const claim of planned) {
    if (executed) break;

    if (claim.itemType === "inbox_task") {
      let claimedPath: string;
      try {
        const claimed = await claims.claimInboxTask({
          vaultRoot: root,
          agentName: claim.agentName,
          taskPath: claim.itemPath,
          deviceId,
          staleAfterMs,
          now,
        });
        claimedPath = claimed.path;
      } catch (error) {
        claimAttempts.push({
          itemType: "inbox_task",
          itemPath: claim.itemPath,
          agentName: claim.agentName,
          outcome: "claim_failed",
          reason: errorMessage(error),
        });
        continue;
      }
      try {
        const res = await executors.executeInboxTask({
          agentName: claim.agentName,
          vaultRoot: root,
          claimedTaskPath: claimedPath,
        });
        executed = true;
        executedItemType = "inbox_task";
        executedItemPath = claimedPath;
        executedAgentName = claim.agentName;
        executionStatus = res.ok ? "completed" : "failed";
        executionSummary = res.ok ? res.assistantText : res.error ?? "failed";
        claimAttempts.push({
          itemType: "inbox_task",
          itemPath: claim.itemPath,
          agentName: claim.agentName,
          outcome: "executed",
        });
        break;
      } catch (error) {
        // Claim succeeded but execution threw: we have consumed the one slot.
        executed = true;
        executedItemType = "inbox_task";
        executedItemPath = claimedPath;
        executedAgentName = claim.agentName;
        executionStatus = "failed";
        executionSummary = errorMessage(error);
        claimAttempts.push({
          itemType: "inbox_task",
          itemPath: claim.itemPath,
          agentName: claim.agentName,
          outcome: "execution_failed",
          reason: errorMessage(error),
        });
        break;
      }
    } else {
      // cron_job
      const job = cronJobsByPath.get(claim.itemPath);
      if (job?.mode === "script") {
        // Script-mode: delegate the UNCLAIMED path to executeScriptCronJob,
        // which owns its own claim+execute+record flow (ADR-0023). Do NOT
        // pre-claim. A throw means the internal claim failed or setup failed:
        // skip without crashing the tick.
        try {
          const res = await executors.executeScriptCronJob({
            agentName: claim.agentName,
            vaultRoot: root,
            jobPath: claim.itemPath,
            deviceId,
          });
          executed = true;
          executedItemType = "cron_job";
          executedItemPath = claim.itemPath;
          executedAgentName = claim.agentName;
          executionStatus = res.status;
          executionSummary = res.stdout || res.stderr || res.status;
          claimAttempts.push({
            itemType: "cron_job",
            itemPath: claim.itemPath,
            agentName: claim.agentName,
            outcome: "executed",
          });
          break;
        } catch (error) {
          claimAttempts.push({
            itemType: "cron_job",
            itemPath: claim.itemPath,
            agentName: claim.agentName,
            outcome: "claim_failed",
            reason: errorMessage(error),
          });
          continue;
        }
      }

      // Agent-mode cron: claim first, then execute the claimed path (S3).
      let claimedPath: string;
      try {
        const claimed = await claims.claimCronJob({
          vaultRoot: root,
          jobPath: claim.itemPath,
          deviceId,
          agentName: claim.agentName,
          staleAfterMs,
          now,
        });
        claimedPath = claimed.path;
      } catch (error) {
        claimAttempts.push({
          itemType: "cron_job",
          itemPath: claim.itemPath,
          agentName: claim.agentName,
          outcome: "claim_failed",
          reason: errorMessage(error),
        });
        continue;
      }
      try {
        const res = await executors.executeAgentCronJob({
          agentName: claim.agentName,
          vaultRoot: root,
          claimedJobPath: claimedPath,
        });
        executed = true;
        executedItemType = "cron_job";
        executedItemPath = claimedPath;
        executedAgentName = claim.agentName;
        executionStatus = res.status;
        executionSummary = res.ok ? res.assistantText : res.error ?? "failed";
        claimAttempts.push({
          itemType: "cron_job",
          itemPath: claim.itemPath,
          agentName: claim.agentName,
          outcome: "executed",
        });
        break;
      } catch (error) {
        executed = true;
        executedItemType = "cron_job";
        executedItemPath = claimedPath;
        executedAgentName = claim.agentName;
        executionStatus = "failed";
        executionSummary = errorMessage(error);
        claimAttempts.push({
          itemType: "cron_job",
          itemPath: claim.itemPath,
          agentName: claim.agentName,
          outcome: "execution_failed",
          reason: errorMessage(error),
        });
        break;
      }
    }
  }

  const noWork = planned.length === 0 && !executed;

  const result: SchedulerOnceResult = {
    deviceId,
    enabledAgents,
    plannedCount: planned.length,
    claimAttempts,
    executed,
    noWork,
    summary: "",
  };
  if (executedItemType !== undefined) result.executedItemType = executedItemType;
  if (executedItemPath !== undefined) result.executedItemPath = executedItemPath;
  if (executedAgentName !== undefined) result.executedAgentName = executedAgentName;
  if (executionStatus !== undefined) result.executionStatus = executionStatus;
  if (executionSummary !== undefined) result.executionSummary = executionSummary;
  result.summary = formatSummary(result);
  return result;
}

// ---------------------------------------------------------------------------
// Production executor factory (thin glue reused by the CLI)
// ---------------------------------------------------------------------------

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
export function createSchedulerExecutors(options: CreateSchedulerExecutorsOptions): SchedulerOnceExecutors {
  const runner: ClaimedCronJobRunner = options.runner;
  return {
    async executeInboxTask(input) {
      return executeClaimedInboxTask({
        vaultRoot: input.vaultRoot,
        agentName: input.agentName,
        claimedTaskPath: input.claimedTaskPath,
        runner: options.runner,
      });
    },
    async executeAgentCronJob(input) {
      const opts: ExecuteClaimedAgentCronJobOptions = {
        vaultRoot: input.vaultRoot,
        agentName: input.agentName,
        claimedJobPath: input.claimedJobPath,
        runner,
      };
      if (options.now !== undefined) opts.now = options.now;
      return executeClaimedAgentCronJob(opts);
    },
    async executeScriptCronJob(input) {
      const opts: ExecuteScriptCronJobOptions = {
        vaultRoot: input.vaultRoot,
        jobPath: input.jobPath,
        agentName: input.agentName,
        deviceId: input.deviceId,
      };
      if (options.scriptTimeoutMs !== undefined) opts.timeoutMs = options.scriptTimeoutMs;
      if (options.now !== undefined) opts.now = options.now;
      return executeScriptCronJob(opts);
    },
  };
}
