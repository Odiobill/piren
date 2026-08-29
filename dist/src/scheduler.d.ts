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
    /**
     * Parsed task frontmatter, used for retry eligibility (ADR-0038 R3 wiring
     * of the accepted R2 semantics). When absent the retry gate is skipped and
     * the task retains its pre-ADR-0038 eligibility.
     */
    frontmatter?: Record<string, unknown>;
}
export interface PlannerCronJob {
    /** Vault-relative path, e.g. "cron/jobs/hourly-brief.md" */
    path: string;
    agentName: string;
    devicePolicy: {
        mode: "highest_priority";
        allowedDevices: string[];
    };
    /**
     * Cron job mode (0.2.0 S2). Used only for automation-class gating: a job
     * without a mode is gated as agent-mode, matching the cron parser default.
     */
    mode?: "agent" | "script";
}
/**
 * Resolved closed automation classes for planner gating (0.2.0 scope
 * amendment §2). Mirrors `ResolvedSchedulerAutomation` in scheduler-loop.ts
 * without a module dependency: when present, items of a disabled class are
 * never proposed. When absent, the planner retains its pre-S2 behavior and
 * proposes every eligible class.
 */
export interface PlannerAutomation {
    inboxTasks: boolean;
    agentCron: boolean;
    scriptCron: boolean;
}
/**
 * Resolved per-class agent scope for planner gating (S1a). Mirrors
 * `ResolvedSchedulerAgentScope` in scheduler-loop.ts without a module
 * dependency: a present class array narrows that class's candidates to those
 * agent names (an empty array allows none); an absent class key leaves every
 * enabled agent eligible. The scope applies after the enabled-agents gate and
 * never widens it.
 */
export interface PlannerAgentScope {
    inboxTasks?: string[];
    agentCron?: string[];
    scriptCron?: string[];
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
    /**
     * Task ids that appear on more than one visible inbox file (ADR-0038 R1). A
     * candidate whose own id is duplicated, or a dependency that resolves to a
     * duplicated id, is never claimable. Defaults to empty.
     */
    duplicateIds?: Set<string>;
    /**
     * Closed automation-class gates (0.2.0 S2). When present, items of a
     * disabled class are never proposed (fail-closed planner exclusion, scope
     * amendment §2): `inboxTasks` gates inbox tasks, `agentCron` gates
     * agent-mode cron, `scriptCron` gates script-mode cron. When omitted, all
     * classes are permitted (legacy behavior).
     */
    automation?: PlannerAutomation;
    /**
     * Resolved per-class agent scope (S1a). When present for a class, only the
     * listed agents' items of that class are proposed; an empty array excludes
     * every agent for that class. Applies to inbox tasks (including stale-claim
     * reclaims) and to agent-/script-mode cron independently.
     */
    agentScope?: PlannerAgentScope;
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
