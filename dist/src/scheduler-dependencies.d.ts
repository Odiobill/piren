import type { TaskStatus } from "./inbox.js";
/**
 * Scheduler task dependency eligibility (ADR-0038, Slice R1).
 *
 * Pure core for parsing `depends_on` task IDs from inbox-task frontmatter,
 * validating them, and resolving whether a candidate task's prerequisites are
 * satisfied. A dependency is satisfied ONLY when the target task has
 * `status: completed`. Lookup includes ordinary AND `.claimed.<device>.md`
 * inbox files so atomic claiming never hides a prerequisite.
 *
 * This module answers exactly one question: "is this task runnable right now,
 * and if not, why?". It performs no retry, no execution, and no task-status
 * mutation. The filesystem loader (`loadInboxDependencyNodes` /
 * `loadSchedulerInboxState`) is a thin real adapter; the evaluation logic is
 * pure and unit-tested directly.
 */
/** ADR-0038 generated task-ID pattern. */
export declare const TASK_ID_PATTERN: RegExp;
/** A task node in the dependency graph: id, status, and its own depends_on. */
export interface DependencyTaskNode {
    id: string;
    status: TaskStatus;
    dependsOn: string[];
    path: string;
    /** Set when `depends_on` is present but structurally malformed (not a sequence). */
    dependsOnError?: string;
    /** Device id when this node comes from a `.claimed.<device>.md` file; a claimed target never satisfies (ADR-0038). */
    claimedBy?: string;
}
/** Eligibility verdict for one candidate task. */
export interface DependencyEligibility {
    eligible: boolean;
    /** Exact human-readable reason when not eligible. */
    reason?: string;
}
/** Result of extracting `depends_on` from parsed frontmatter. */
export interface DependencyDeclaration {
    ids: string[];
    /** Set when `depends_on` is present but structurally malformed. */
    error?: string;
}
/** A loaded inbox task carrying agent/claim metadata alongside its node fields. */
export interface LoadedInboxTask extends DependencyTaskNode {
    agentName: string;
    /** Device id when the file is a `.claimed.<device>.md` atomic claim. */
    claimedBy?: string;
}
/** Result of loading scheduler inbox state for one planning tick. */
export interface SchedulerInboxLoad {
    /** All visible task nodes keyed by id, for prerequisite resolution. */
    dependencyNodes: Map<string, DependencyTaskNode>;
    /** Pending, unclaimed candidate tasks (eligible candidates are derived by the planner). */
    pendingTasks: LoadedInboxTask[];
    /** Task ids that appear on more than one visible inbox file; a dependency on (or a candidate with) such an id is never claimable (ADR-0038). */
    duplicateIds: Set<string>;
}
/**
 * Extract the `depends_on` sequence from a parsed frontmatter object.
 *
 * - Absent field -> empty ids, no error.
 * - Array of strings -> those ids (trimmed; empty entries dropped).
 * - Anything else -> empty ids + error (declaration malformed).
 */
export declare function extractDependsOn(frontmatter: Record<string, unknown>): DependencyDeclaration;
/**
 * Parse one inbox-task file's content into a dependency node. Tolerant: files
 * without parseable frontmatter, a missing id, or an invalid status are skipped
 * (return undefined) so a single malformed file never breaks resolution.
 *
 * A structurally malformed `depends_on` is preserved via `dependsOnError` so
 * the task can still be reported as blocked rather than silently treated as
 * dependency-free.
 */
export declare function parseDependencyTaskNode(content: string, path: string): DependencyTaskNode | undefined;
/**
 * Evaluate whether a candidate task is runnable given the full set of visible
 * task nodes. The candidate carries its own id + depends_on; `nodes` provides
 * the prerequisite targets; `duplicateIds` lists task ids that appear on more
 * than one visible inbox file. Pure and deterministic.
 *
 * Validation order (first blocking category wins):
 *   1. malformed depends_on declaration (sequence shape)
 *   2. candidate's own id is duplicated in the vault
 *   3. malformed ids (do not match the task-ID pattern)
 *   4. duplicate ids within the depends_on list
 *   5. self-dependency
 *   6. duplicated target ids (ambiguous resolution), then missing target ids
 *   7. dependency cycle involving the candidate
 *   8. unsatisfied prerequisites (claimed target, or status != completed)
 *
 * A task with no depends_on (and no declaration error, and a unique id) is
 * always eligible. A claimed target never satisfies even when its status is
 * completed (ADR-0038).
 */
export declare function evaluateTaskDependencyEligibility(candidate: DependencyTaskNode, nodes: Map<string, DependencyTaskNode>, duplicateIds?: Set<string>): DependencyEligibility;
/**
 * Read every Markdown file in one agent's inbox (ordinary AND claimed) and
 * return the parseable task nodes. Tolerant: unparseable files are skipped.
 */
export declare function loadInboxDependencyNodes(options: {
    vaultRoot: string;
    agentName: string;
}): Promise<LoadedInboxTask[]>;
/**
 * Load scheduler inbox state across the enabled agent set: a resolver map of
 * every visible task node, the pending unclaimed candidate tasks, and the set
 * of task ids that appear on more than one visible file. Agent inboxes that do
 * not exist are skipped.
 *
 * Duplicate visible task ids are treated as invalid resolution (ADR-0038): the
 * duplicated id is recorded in `duplicateIds` and excluded from the resolver
 * map so resolution can never depend on traversal order. Pending candidates
 * with a duplicated own id are still returned (so the planner/dry-run can
 * report them as blocked) but never become claimable.
 */
export declare function loadSchedulerInboxState(options: {
    vaultRoot: string;
    enabledAgents: string[];
}): Promise<SchedulerInboxLoad>;
