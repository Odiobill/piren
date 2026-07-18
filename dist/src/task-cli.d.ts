/**
 * Task CLI core (Slice C, ADR-0031 / inbox-backed coordination).
 *
 * Pure core with injected filesystem deps for the human-facing `piren task`
 * CLI. It wraps the existing one-file-per-task inbox primitives in
 * src/inbox.ts without changing their schema or behavior: create/list/claim/
 * status-update are still done by the real-fs inbox functions, called from
 * src/cli.ts. This module owns only the CLI-specific concerns that would
 * otherwise be hard to test against the real filesystem:
 *
 *   - deciding whether an input is a task path or a task id,
 *   - vault-containment validation for task paths and body/result files,
 *   - resolving an id (or path) to a concrete vault-relative task path,
 *   - reading a body/result file from inside the vault,
 *   - parsing a task file into a rich detail view for `show`,
 *   - human-friendly formatters,
 *   - priority validation for the documented CLI surface.
 *
 * The module never imports src/inbox.ts so the inbox primitives stay the
 * single source of truth for the task-file format. It re-declares a
 * TaskStatus type matching the inbox schema.
 */
export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";
/** Injected filesystem operations, structurally compatible with node:fs/promises. */
export interface TaskCliDeps {
    readFile(path: string): Promise<string>;
    stat(path: string): Promise<{
        isDirectory(): boolean;
    }>;
    readdir(path: string): Promise<{
        name: string;
        isDirectory(): boolean;
        isFile(): boolean;
    }[]>;
    access(path: string): Promise<void>;
}
/** Row model for the `list` formatter. Mirrors the inbox summary shape. */
export interface TaskListRow {
    id: string;
    path: string;
    title: string;
    from: string;
    to: string;
    status: TaskStatus;
    priority: string;
    created: string;
    updated: string;
}
/** Rich detail view for the `show` formatter. */
export interface TaskDetail {
    id: string;
    path: string;
    title: string;
    from: string;
    to: string;
    status: TaskStatus;
    priority: string;
    created: string;
    updated: string;
    requiresApproval: boolean;
    body: string;
}
/** Priorities accepted by the documented `piren task send --priority` surface. */
export declare const CLI_PRIORITIES: readonly ["normal", "high", "urgent"];
export type CliPriority = (typeof CLI_PRIORITIES)[number];
export declare function isValidCliPriority(value: string): value is CliPriority;
/**
 * Decide whether an input looks like a task path (contains a separator or ends
 * in .md) rather than a bare task id. Bare ids (no slash, no backslash, no
 * .md suffix) are treated as ids to be resolved.
 */
export declare function isLikelyTaskPath(input: string): boolean;
/**
 * Assert that an absolute target path stays within the vault root. Throws on
 * traversal (`..`) or absolute paths that resolve outside the vault.
 */
export declare function assertVaultContained(vaultRoot: string, absPath: string): void;
/**
 * Validate a vault-relative task path has the inbox structure
 * `team/<agent>/inbox/<file>.md` and that the agent segment is a safe kebab
 * name. Returns the parsed agent name and filename. Throws on malformed
 * structure, traversal, or non-markdown files.
 */
export declare function assertInboxTaskRelPath(vaultRoot: string, relPath: string): {
    agentName: string;
    fileName: string;
};
/**
 * Resolve a user-supplied id-or-path input to a concrete vault-relative task
 * path and the owning agent name.
 *
 * - Path inputs are validated for vault containment and inbox structure.
 * - Id inputs are matched by the frontmatter `id` field (preferred) or by
 *   filename stem, across claimed and unclaimed files. When `agent` is
 *   provided, only that agent's inbox is searched; otherwise all agent
 *   inboxes are searched. An id that matches in more than one agent without
 *   `agent` specified is rejected as ambiguous.
 */
export declare function resolveTaskIdOrPath(deps: TaskCliDeps, vaultRoot: string, input: string, agent?: string): Promise<{
    path: string;
    agentName: string;
}>;
/**
 * Read a body/result file from inside the vault. The file argument may be
 * vault-relative or absolute, but it must resolve inside the vault root.
 * Throws on traversal or out-of-vault absolute paths. This deliberately keeps
 * human-supplied --body/--result content vault-scoped.
 */
export declare function readVaultFile(deps: TaskCliDeps, vaultRoot: string, file: string): Promise<string>;
/**
 * Read and parse a task file at a vault-relative path into a rich detail view.
 * Validates vault containment and inbox structure before reading.
 */
export declare function readTaskDetail(deps: TaskCliDeps, vaultRoot: string, relPath: string): Promise<TaskDetail>;
/** Format a list of task rows as a compact table. */
export declare function formatTaskList(rows: TaskListRow[]): string;
/** Format a single task detail view. */
export declare function formatTaskDetail(detail: TaskDetail): string;
/** Bare-filename helper kept exported for symmetry with other CLI cores. */
export declare function taskFileName(path: string): string;
export declare function createRealTaskCliDeps(): TaskCliDeps;
