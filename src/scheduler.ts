import { selectOwningDevice, type ActiveDevice } from "./cron.js";
import { evaluateTaskDependencyEligibility, type DependencyTaskNode } from "./scheduler-dependencies.js";

// ---------------------------------------------------------------------------
// Scheduler planner types
// ---------------------------------------------------------------------------

export interface PlannerTask {
  /** Vault-relative path, e.g. "team/codex/inbox/task-1.md" */
  path: string;
  agentName: string;
  status: "pending" | "claimed";
  /** Device ID that claimed the task (only set when status is "claimed"). */
  claimedBy?: string;
  /** Stable task id, used for dependency evaluation (ADR-0038 R1). */
  id?: string;
  /** Declared prerequisite task IDs (ADR-0038). Empty/absent = no deps. */
  dependsOn?: string[];
  /** Set when the task's `depends_on` declaration is structurally malformed. */
  dependsOnError?: string;
}

export interface PlannerCronJob {
  /** Vault-relative path, e.g. "cron/jobs/hourly-brief.md" */
  path: string;
  agentName: string;
  devicePolicy: { mode: "highest_priority"; allowedDevices: string[] };
}

export interface PlannerActiveDevice {
  deviceId: string;
  priority: number;
}

export interface PlannedClaim {
  agentName: string;
  itemType: "inbox_task" | "cron_job";
  itemPath: string;
  deviceId: string;
  priority: number;
  rationale: string;
}

export interface PlanSchedulerTickOptions {
  enabledAgents: string[];
  pendingTasks: PlannerTask[];
  dueCronJobs: PlannerCronJob[];
  /** Agent name -> active devices for that agent. Only non-stale devices. */
  activeDevices: Map<string, PlannerActiveDevice[]>;
  deviceId: string;
  staleAfterMs: number;
  now: Date;
  /**
   * Visible task nodes (id -> node) used to resolve `depends_on` prerequisites
   * (ADR-0038 R1). Must include ordinary AND `.claimed.<device>.md` inbox
   * files so atomic claiming never hides a prerequisite. When omitted, any
   * task that declares dependencies is treated as blocked (fail-closed).
   */
  dependencyNodes?: Map<string, DependencyTaskNode>;
}

// ---------------------------------------------------------------------------
// Pure scheduler planner
// ---------------------------------------------------------------------------

/**
 * Plan proposed claims for one scheduler tick. Pure function: takes
 * pre-loaded vault state and returns proposed claim attempts. No filesystem
 * access, no spawning, no side effects.
 *
 * The caller is responsible for loading the vault state (inbox tasks, cron
 * jobs, active devices) and executing or displaying the proposed claims.
 */
export function planSchedulerTick(options: PlanSchedulerTickOptions): PlannedClaim[] {
  const { enabledAgents, pendingTasks, dueCronJobs, activeDevices, deviceId, staleAfterMs, now, dependencyNodes } = options;
  const claims: PlannedClaim[] = [];
  const enabledSet = new Set(enabledAgents);

  // Process inbox tasks
  for (const task of pendingTasks) {
    if (!enabledSet.has(task.agentName)) continue;

    if (task.status === "pending") {
      // Dependency eligibility (ADR-0038 R1): a task with unsatisfied or
      // invalid dependencies is never claimable. Fail closed when a task
      // declares dependencies but the resolver is unavailable.
      if (!isDependencyEligible(task, dependencyNodes)) continue;
      // Unclaimed task: propose a claim
      const priority = devicePriorityForAgent(activeDevices, task.agentName, deviceId);
      claims.push({
        agentName: task.agentName,
        itemType: "inbox_task",
        itemPath: task.path,
        deviceId,
        priority,
        rationale: `unclaimed pending task for agent ${task.agentName}`,
      });
    } else if (task.status === "claimed" && task.claimedBy) {
      // Claimed task: propose reclaim only if claiming device is stale
      if (!isDeviceActive(activeDevices, task.agentName, task.claimedBy)) {
        const priority = devicePriorityForAgent(activeDevices, task.agentName, deviceId);
        claims.push({
          agentName: task.agentName,
          itemType: "inbox_task",
          itemPath: task.path,
          deviceId,
          priority,
          rationale: `stale claim by ${task.claimedBy} for agent ${task.agentName}`,
        });
      }
    }
  }

  // Process cron jobs
  for (const job of dueCronJobs) {
    if (!enabledSet.has(job.agentName)) continue;

    const agentDevices = activeDevices.get(job.agentName) ?? [];
    const activeList: ActiveDevice[] = agentDevices.map((d) => ({
      deviceId: d.deviceId,
      priority: d.priority,
    }));

    const ownership = selectOwningDevice({
      devicePolicy: job.devicePolicy,
      activeDevices: activeList,
      deviceId,
    });

    if (ownership.owns) {
      const priority = devicePriorityForAgent(activeDevices, job.agentName, deviceId);
      claims.push({
        agentName: job.agentName,
        itemType: "cron_job",
        itemPath: job.path,
        deviceId,
        priority,
        rationale: `this device owns the job for agent ${job.agentName}`,
      });
    }
  }

  // Sort by priority (lower = higher precedence), then by agent name for stability
  claims.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.agentName.localeCompare(b.agentName);
  });

  return claims;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Decide whether a pending task passes its `depends_on` gate. Tasks without
 * any declared dependency (no ids, no declaration error) are always eligible,
 * preserving pre-ADR-0038 behavior. A task that declares a dependency but
 * cannot be resolved (missing id or resolver) is blocked (fail-closed).
 */
function isDependencyEligible(
  task: PlannerTask,
  nodes: Map<string, DependencyTaskNode> | undefined,
): boolean {
  const hasDeps = (task.dependsOn !== undefined && task.dependsOn.length > 0) || task.dependsOnError !== undefined;
  if (!hasDeps) return true;
  // A declaration exists; an id is required to evaluate self/cycle cases, and
  // a resolver is required to look up targets. Fail closed when absent.
  if (task.id === undefined || nodes === undefined) return false;
  const candidate: DependencyTaskNode = {
    id: task.id,
    status: "pending",
    dependsOn: task.dependsOn ?? [],
    path: task.path,
  };
  if (task.dependsOnError !== undefined) candidate.dependsOnError = task.dependsOnError;
  return evaluateTaskDependencyEligibility(candidate, nodes).eligible;
}

function devicePriorityForAgent(
  activeDevices: Map<string, PlannerActiveDevice[]>,
  agentName: string,
  deviceId: string,
): number {
  const devices = activeDevices.get(agentName) ?? [];
  const match = devices.find((d) => d.deviceId === deviceId);
  return match?.priority ?? 10;
}

function isDeviceActive(
  activeDevices: Map<string, PlannerActiveDevice[]>,
  agentName: string,
  deviceId: string,
): boolean {
  const devices = activeDevices.get(agentName) ?? [];
  return devices.some((d) => d.deviceId === deviceId);
}
