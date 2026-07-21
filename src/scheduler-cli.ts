import { access, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { LocalPirenConfig } from "./bootstrap.js";
import { listCronJobs, listActiveDevices } from "./cron.js";
import { planSchedulerTick, type PlannerTask, type PlannerCronJob } from "./scheduler.js";
import {
  evaluateTaskDependencyEligibility,
  loadSchedulerInboxState,
  type DependencyTaskNode,
  type LoadedInboxTask,
} from "./scheduler-dependencies.js";

export interface SchedulerDryRunOptions {
  configPath?: string;
  deviceId?: string;
  staleAfterMs?: number;
  now?: Date;
}

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "piren", "config.yml");

/**
 * Resolve the locally enabled agent set: allowed_agents minus excluded_agents.
 * Shared by dry-run and --once so both apply the same local policy before
 * planning (ADR-0029: local policy first).
 */
export function resolveEnabledAgents(config: LocalPirenConfig): string[] {
  const allowed = config.allowed_agents ?? [];
  const excluded = new Set(config.excluded_agents ?? []);
  return allowed.filter((agent) => !excluded.has(agent));
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readYamlConfig(path: string): Promise<LocalPirenConfig> {
  if (!(await pathExists(path))) return {};
  const content = await readFile(path, "utf8");
  const parsed = parseYaml(content) as unknown;
  if (!parsed || typeof parsed !== "object") return {};
  return parsed as LocalPirenConfig;
}

export { DEFAULT_CONFIG_PATH };

/**
 * Execute a dry-run scheduler tick: load vault state, plan proposed claims,
 * and return a human-readable report. Does NOT execute any claims.
 */
export async function schedulerDryRun(options: SchedulerDryRunOptions): Promise<string> {
  const deviceId = options.deviceId ?? hostname();
  const staleAfterMs = options.staleAfterMs ?? 300_000;
  const now = options.now ?? new Date();

  // Resolve local config
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const config = await readYamlConfig(configPath);
  const vaultRoot = config.vault_root;
  if (!vaultRoot) {
    return "SCHEDULER DRY-RUN\n\nNo vault root configured. Set vault_root in ~/.config/piren/config.yml.\n";
  }

  const allowedAgents = resolveEnabledAgents(config);
  const enabledAgents = allowedAgents;

  if (enabledAgents.length === 0) {
    return `SCHEDULER DRY-RUN (device: ${deviceId})\n\nNo enabled agents. Configure allowed_agents in local config.\n`;
  }

  // Load inbox state (pending candidates + dependency resolver) across all
  // enabled agents. The resolver includes claimed files so an atomic claim
  // never hides a prerequisite (ADR-0038 R1).
  const inboxState = await loadSchedulerInboxState({ vaultRoot, enabledAgents });
  const pendingTasks: PlannerTask[] = inboxState.pendingTasks.map((t) => toPlannerTask(t));

  // Load due cron jobs for each enabled agent (cron jobs carry no deps).
  const dueCronJobs: PlannerCronJob[] = [];
  for (const agentName of enabledAgents) {
    try {
      // Load cron jobs
      const cronResult = await listCronJobs({ vaultRoot, agentName });
      for (const job of cronResult.jobs) {
        dueCronJobs.push({
          path: job.path,
          agentName: job.agent,
          devicePolicy: job.devicePolicy,
        });
      }
    } catch {
      // Skip if cron jobs can't be loaded
    }
  }

  // Load active devices per agent
  const activeDevices = new Map<string, { deviceId: string; priority: number }[]>();
  for (const agentName of enabledAgents) {
    try {
      const devicesResult = await listActiveDevices({ vaultRoot, agentName, staleAfterMs, now: () => now });
      activeDevices.set(
        agentName,
        devicesResult.devices.map((d) => ({ deviceId: d.deviceId, priority: d.priority })),
      );
    } catch {
      activeDevices.set(agentName, []);
    }
  }

  // Plan claims. The planner excludes dependency-blocked tasks from claim
  // proposals using the resolver map (fail-closed).
  const claims = planSchedulerTick({
    enabledAgents,
    pendingTasks,
    dueCronJobs,
    activeDevices,
    deviceId,
    staleAfterMs,
    now,
    dependencyNodes: inboxState.dependencyNodes,
    duplicateIds: inboxState.duplicateIds,
  });

  // Separately classify pending candidates for the human-readable report so
  // the dry-run can distinguish runnable from dependency-blocked work without
  // mutating anything. This reuses the same pure evaluator the planner uses.
  const blocked = classifyBlockedTasks(inboxState.pendingTasks, inboxState.dependencyNodes, inboxState.duplicateIds);

  // Format output
  return formatSchedulerDryRun(deviceId, enabledAgents, claims, blocked);
}

/** Map a loaded inbox task to the planner's task shape, carrying dependency fields. */
function toPlannerTask(task: LoadedInboxTask): PlannerTask {
  const plannerTask: PlannerTask = {
    path: task.path,
    agentName: task.agentName,
    status: "pending",
  };
  plannerTask.id = task.id;
  plannerTask.dependsOn = task.dependsOn;
  if (task.dependsOnError !== undefined) plannerTask.dependsOnError = task.dependsOnError;
  return plannerTask;
}

interface BlockedTask {
  agentName: string;
  path: string;
  reason: string;
}

/** Evaluate every pending candidate and return the blocked ones with reasons. */
function classifyBlockedTasks(
  pendingTasks: LoadedInboxTask[],
  dependencyNodes: Map<string, DependencyTaskNode>,
  duplicateIds: Set<string>,
): BlockedTask[] {
  const blocked: BlockedTask[] = [];
  for (const task of pendingTasks) {
    const candidate: DependencyTaskNode = {
      id: task.id,
      status: task.status,
      dependsOn: task.dependsOn,
      path: task.path,
    };
    if (task.dependsOnError !== undefined) candidate.dependsOnError = task.dependsOnError;
    if (task.claimedBy !== undefined) candidate.claimedBy = task.claimedBy;
    const verdict = evaluateTaskDependencyEligibility(candidate, dependencyNodes, duplicateIds);
    if (!verdict.eligible) {
      blocked.push({
        agentName: task.agentName,
        path: task.path,
        reason: verdict.reason ?? "dependency-blocked",
      });
    }
  }
  return blocked;
}

function formatSchedulerDryRun(
  deviceId: string,
  enabledAgents: string[],
  claims: { agentName: string; itemType: string; itemPath: string; deviceId: string; priority: number; rationale: string }[],
  blocked: BlockedTask[],
): string {
  const lines: string[] = [];
  lines.push(`SCHEDULER DRY-RUN (device: ${deviceId})`);

  // Group claims by agent
  const agentClaims = new Map<string, typeof claims>();
  for (const claim of claims) {
    const list = agentClaims.get(claim.agentName) ?? [];
    list.push(claim);
    agentClaims.set(claim.agentName, list);
  }

  // Group dependency-blocked tasks by agent
  const agentBlocked = new Map<string, BlockedTask[]>();
  for (const item of blocked) {
    const list = agentBlocked.get(item.agentName) ?? [];
    list.push(item);
    agentBlocked.set(item.agentName, list);
  }

  // Report claims and blocked tasks per agent
  for (const agentName of enabledAgents) {
    const agentClaimList = agentClaims.get(agentName) ?? [];
    const agentBlockedList = (agentBlocked.get(agentName) ?? []).slice().sort((a, b) => a.path.localeCompare(b.path));
    lines.push(`  agent: ${agentName}`);
    if (agentClaimList.length === 0 && agentBlockedList.length === 0) {
      lines.push(`    (no claims)`);
    } else {
      for (const claim of agentClaimList) {
        const tag = "[CLAIM]";
        lines.push(`    ${tag} ${claim.itemType.padEnd(12)} ${claim.itemPath} (priority ${claim.priority}) - ${claim.rationale}`);
      }
      for (const item of agentBlockedList) {
        lines.push(`    [BLOCK] ${"inbox_task".padEnd(12)} ${item.path} - ${item.reason}`);
      }
    }
  }

  return lines.join("\n") + "\n";
}
