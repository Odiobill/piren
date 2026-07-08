import { access, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { LocalPirenConfig } from "./bootstrap.js";
import { listInboxTasks } from "./inbox.js";
import { listCronJobs, listActiveDevices } from "./cron.js";
import { planSchedulerTick, type PlannerTask, type PlannerCronJob } from "./scheduler.js";

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

  // Load pending tasks and due cron jobs for each enabled agent
  const pendingTasks: PlannerTask[] = [];
  const dueCronJobs: PlannerCronJob[] = [];

  for (const agentName of enabledAgents) {
    try {
      // Load inbox tasks
      const inboxResult = await listInboxTasks({ vaultRoot, agentName });
      for (const task of inboxResult.tasks) {
        if (task.status === "pending") {
          pendingTasks.push({
            path: task.path,
            agentName,
            status: "pending",
          });
        }
      }
    } catch {
      // Agent directory may not exist yet, skip
    }

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

  // Plan claims
  const claims = planSchedulerTick({
    enabledAgents,
    pendingTasks,
    dueCronJobs,
    activeDevices,
    deviceId,
    staleAfterMs,
    now,
  });

  // Format output
  return formatSchedulerDryRun(deviceId, enabledAgents, claims);
}

function formatSchedulerDryRun(
  deviceId: string,
  enabledAgents: string[],
  claims: { agentName: string; itemType: string; itemPath: string; deviceId: string; priority: number; rationale: string }[],
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

  // Report claims per agent
  for (const agentName of enabledAgents) {
    const agentClaimList = agentClaims.get(agentName) ?? [];
    lines.push(`  agent: ${agentName}`);
    if (agentClaimList.length === 0) {
      lines.push(`    (no claims)`);
    } else {
      for (const claim of agentClaimList) {
        const tag = "[CLAIM]";
        lines.push(`    ${tag} ${claim.itemType.padEnd(12)} ${claim.itemPath} (priority ${claim.priority}) - ${claim.rationale}`);
      }
    }
  }

  return lines.join("\n") + "\n";
}
