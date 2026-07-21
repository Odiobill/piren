import { type DependencyTaskNode } from "./scheduler-dependencies.js";
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
    devicePolicy: {
        mode: "highest_priority";
        allowedDevices: string[];
    };
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
/**
 * Plan proposed claims for one scheduler tick. Pure function: takes
 * pre-loaded vault state and returns proposed claim attempts. No filesystem
 * access, no spawning, no side effects.
 *
 * The caller is responsible for loading the vault state (inbox tasks, cron
 * jobs, active devices) and executing or displaying the proposed claims.
 */
export declare function planSchedulerTick(options: PlanSchedulerTickOptions): PlannedClaim[];
