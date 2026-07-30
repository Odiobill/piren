import type { DependencyTaskNode, LoadedInboxTask } from "./scheduler-dependencies.js";
/**
 * Read-only scheduler operator report (ADR-0038 R3 operator surface).
 *
 * Pure classification core for `piren scheduler --report`: surfaces
 * actionable, visible conditions for the locally enabled agent set —
 * dependency cycles, invalid retry policy/state, exhausted retry attempts,
 * and claimed inbox tasks that require manual triage.
 *
 * Boundaries:
 * - Read-only: no claims, no spawns, no heartbeat refreshes, no writes, no
 *   Pi/LLM calls. The report only reads vault files and local config.
 * - A claimed task is a manual-triage item. It is NEVER labeled an
 *   `ambiguous` failure: current task files do not persist that
 *   classification, so vault state alone cannot distinguish an active,
 *   interrupted, or ambiguous claim.
 * - Backoff-blocked and other dependency-blocked reasons stay in --dry-run;
 *   this report does not broaden into full blocked-work diagnostics.
 */
/** Finding categories in deterministic report order. */
export type SchedulerReportCategory = "cycle" | "retry" | "triage";
/** One actionable report finding. */
export interface SchedulerReportFinding {
    category: SchedulerReportCategory;
    agentName: string;
    path: string;
    reason: string;
    /** Non-action authority boundary statement (ADR-0039 E2-S1). */
    authority: string;
    /** Exactly one inspection action (ADR-0039 E2-S1). */
    nextStep: string;
}
/** Input to the pure classifier: pre-loaded inbox state plus the tick clock. */
export interface SchedulerReportClassifyInput {
    /** Pending unclaimed candidates (used for cycle detection). */
    pendingTasks: LoadedInboxTask[];
    /** Every visible inbox task, ordinary AND claimed (retry metadata + triage). */
    allTasks: LoadedInboxTask[];
    dependencyNodes: Map<string, DependencyTaskNode>;
    duplicateIds: Set<string>;
    now: Date;
}
/**
 * Classify report findings from loaded inbox state. Pure and deterministic:
 * findings are sorted by agent name, then category, then path, and identical
 * findings are deduplicated.
 */
export declare function classifySchedulerReportFindings(input: SchedulerReportClassifyInput): SchedulerReportFinding[];
/**
 * Format the operator report. Pure and deterministic: agents appear in
 * enabled-agent order, findings are pre-sorted by the classifier, and a
 * summary line counts findings by category. The footer states the read-only
 * guarantee and the ambiguity limitation (ADR-0038 R3): a claimed task
 * requires manual triage and may be active, interrupted, or ambiguous — the
 * report cannot identify which from vault state alone.
 */
export declare function formatSchedulerReport(enabledAgents: string[], findings: SchedulerReportFinding[]): string;
export interface SchedulerReportOptions {
    configPath?: string;
    now?: Date;
}
/**
 * Build the read-only scheduler operator report for the locally enabled
 * agent set. Reads only the vault and local config: no claims, no spawns,
 * no heartbeat refreshes, no writes, no Pi/LLM calls.
 */
export declare function schedulerReport(options: SchedulerReportOptions): Promise<string>;
