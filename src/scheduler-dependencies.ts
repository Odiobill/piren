import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
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
export const TASK_ID_PATTERN = /^[0-9]{8}T[0-9]{9}Z-[a-z0-9]+(?:-[a-z0-9]+)*$/;

const VALID_STATUSES: readonly TaskStatus[] = ["pending", "in_progress", "completed", "cancelled"];
const SATISFIED_STATUS: TaskStatus = "completed";
const EMPTY_SET: Set<string> = new Set();

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
export function extractDependsOn(frontmatter: Record<string, unknown>): DependencyDeclaration {
  const raw = frontmatter["depends_on"];
  if (raw === undefined || raw === null) return { ids: [] };
  if (!Array.isArray(raw)) {
    return { ids: [], error: "depends_on must be a sequence of task IDs" };
  }
  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      return { ids: [], error: "depends_on must be a sequence of task IDs" };
    }
    const trimmed = entry.trim();
    if (trimmed !== "") ids.push(trimmed);
  }
  return { ids };
}

/**
 * Parse one inbox-task file's content into a dependency node. Tolerant: files
 * without parseable frontmatter, a missing id, or an invalid status are skipped
 * (return undefined) so a single malformed file never breaks resolution.
 *
 * A structurally malformed `depends_on` is preserved via `dependsOnError` so
 * the task can still be reported as blocked rather than silently treated as
 * dependency-free.
 */
export function parseDependencyTaskNode(content: string, path: string): DependencyTaskNode | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return undefined;
  const rawFields = match[1] ?? "";
  let parsed: unknown;
  try {
    parsed = parseYaml(rawFields);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const fields = parsed as Record<string, unknown>;
  const id = fields["id"];
  const status = fields["status"];
  if (typeof id !== "string" || id.trim() === "") return undefined;
  if (typeof status !== "string") return undefined;
  if (!VALID_STATUSES.includes(status as TaskStatus)) return undefined;
  const decl = extractDependsOn(fields);
  const node: DependencyTaskNode = {
    id: id.trim(),
    status: status as TaskStatus,
    dependsOn: decl.ids,
    path,
  };
  if (decl.error !== undefined) node.dependsOnError = decl.error;
  return node;
}

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
export function evaluateTaskDependencyEligibility(
  candidate: DependencyTaskNode,
  nodes: Map<string, DependencyTaskNode>,
  duplicateIds: Set<string> = EMPTY_SET,
): DependencyEligibility {
  // 1. malformed declaration
  if (candidate.dependsOnError !== undefined) {
    return { eligible: false, reason: candidate.dependsOnError };
  }

  // 2. candidate's own id is duplicated: identity is ambiguous, never claimable.
  if (duplicateIds.has(candidate.id)) {
    return { eligible: false, reason: `duplicate task id: ${candidate.id}` };
  }

  const deps = candidate.dependsOn;
  if (deps.length === 0) return { eligible: true };

  // 3. malformed ids
  const malformed = unique(deps.filter((id) => !TASK_ID_PATTERN.test(id)));
  if (malformed.length > 0) {
    return { eligible: false, reason: `malformed dependency id: ${malformed.join(", ")}` };
  }

  // 4. duplicate ids within the depends_on list
  const dupes = duplicates(deps);
  if (dupes.length > 0) {
    return { eligible: false, reason: `duplicate dependency id: ${dupes.join(", ")}` };
  }

  // 5. self-dependency
  if (deps.includes(candidate.id)) {
    return { eligible: false, reason: `self-dependency: ${candidate.id}` };
  }

  // 6. duplicated target ids (ambiguous) take precedence over genuinely missing.
  const duplicatedTargets = deps.filter((id) => duplicateIds.has(id));
  if (duplicatedTargets.length > 0) {
    return { eligible: false, reason: `duplicate task id: ${unique(duplicatedTargets).join(", ")}` };
  }
  const missing = deps.filter((id) => !nodes.has(id));
  if (missing.length > 0) {
    return { eligible: false, reason: `missing dependency: ${missing.join(", ")}` };
  }

  // 7. dependency cycle involving the candidate
  const cycle = detectCycleThroughCandidate(candidate, nodes);
  if (cycle !== undefined) {
    return { eligible: false, reason: `dependency cycle: ${cycle.join(" -> ")}` };
  }

  // 8. unsatisfied prerequisites. A claimed target never satisfies (ADR-0038),
  //    even when its status field is completed; otherwise only completed satisfies.
  const blocking: string[] = [];
  for (const id of deps) {
    const target = nodes.get(id);
    if (target === undefined) continue; // already reported as missing
    if (target.claimedBy !== undefined) {
      blocking.push(`${id} (claimed)`);
    } else if (target.status !== SATISFIED_STATUS) {
      blocking.push(`${id} (status: ${target.status})`);
    }
  }
  if (blocking.length > 0) {
    return { eligible: false, reason: `unsatisfied dependency: ${blocking.join(", ")}` };
  }

  return { eligible: true };
}

/**
 * Detect a dependency cycle that returns to the candidate. Returns the cycle
 * path `[candidate, ..., candidate]`, or undefined when the candidate is not
 * part of any cycle. Back-edges to intermediate path nodes that do not reach
 * the candidate are ignored: those cycles are reported when their own member
 * is evaluated, and the current candidate is simply left unsatisfied by them.
 */
function detectCycleThroughCandidate(
  candidate: DependencyTaskNode,
  nodes: Map<string, DependencyTaskNode>,
): string[] | undefined {
  const onPath: string[] = [candidate.id];
  const onPathSet = new Set<string>([candidate.id]);
  let found: string[] | undefined;

  function visit(node: DependencyTaskNode): void {
    if (found !== undefined) return;
    for (const dep of node.dependsOn) {
      if (found !== undefined) return;
      if (dep === candidate.id) {
        found = [...onPath, candidate.id];
        return;
      }
      if (onPathSet.has(dep)) continue; // back-edge not reaching the candidate
      const depNode = nodes.get(dep);
      if (depNode === undefined) continue; // missing targets handled upstream
      onPath.push(dep);
      onPathSet.add(dep);
      visit(depNode);
      onPath.pop();
      onPathSet.delete(dep);
    }
  }

  visit(candidate);
  return found;
}

function unique(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  const ordered: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      if (!dupes.has(id)) {
        dupes.add(id);
        ordered.push(id);
      }
    } else {
      seen.add(id);
    }
  }
  return ordered;
}

function claimedDeviceFromName(name: string): string | undefined {
  const match = name.match(/\.claimed\.([a-z][a-z0-9-]*)\.md$/);
  return match?.[1];
}

/** Reject agent names that would let the inbox path escape the vault root. */
function assertValidAgentName(agentName: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(agentName)) {
    throw new Error("Invalid agent name. Use lowercase kebab-case, for example 'piren' or 'research-agent'.");
  }
}

/**
 * Read every Markdown file in one agent's inbox (ordinary AND claimed) and
 * return the parseable task nodes. Tolerant: unparseable files are skipped.
 */
export async function loadInboxDependencyNodes(options: {
  vaultRoot: string;
  agentName: string;
}): Promise<LoadedInboxTask[]> {
  assertValidAgentName(options.agentName);
  const inboxPath = join("team", options.agentName, "inbox");
  const absolutePath = resolve(options.vaultRoot, inboxPath);
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const tasks: LoadedInboxTask[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const taskPath = join(inboxPath, entry.name);
    const content = await readFile(resolve(absolutePath, entry.name), "utf8");
    const node = parseDependencyTaskNode(content, taskPath);
    if (node === undefined) continue;
    const loaded: LoadedInboxTask = {
      id: node.id,
      status: node.status,
      dependsOn: node.dependsOn,
      path: node.path,
      agentName: options.agentName,
    };
    if (node.dependsOnError !== undefined) loaded.dependsOnError = node.dependsOnError;
    const claimedBy = claimedDeviceFromName(entry.name);
    if (claimedBy !== undefined) loaded.claimedBy = claimedBy;
    tasks.push(loaded);
  }
  return tasks;
}

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
export async function loadSchedulerInboxState(options: {
  vaultRoot: string;
  enabledAgents: string[];
}): Promise<SchedulerInboxLoad> {
  const dependencyNodes = new Map<string, DependencyTaskNode>();
  const duplicateIds = new Set<string>();
  const pendingTasks: LoadedInboxTask[] = [];
  for (const agentName of options.enabledAgents) {
    let loaded: LoadedInboxTask[];
    try {
      loaded = await loadInboxDependencyNodes({ vaultRoot: options.vaultRoot, agentName });
    } catch {
      // Inbox directory may not exist yet for this agent; skip.
      continue;
    }
    for (const task of loaded) {
      if (dependencyNodes.has(task.id) || duplicateIds.has(task.id)) {
        // Collision: this id now spans more than one visible file. Remove any
        // previously-inserted node so resolution is never first/last-writer-wins.
        dependencyNodes.delete(task.id);
        duplicateIds.add(task.id);
      } else {
        dependencyNodes.set(task.id, toNode(task));
      }
      if (task.status === "pending" && task.claimedBy === undefined) {
        pendingTasks.push(task);
      }
    }
  }
  return { dependencyNodes, pendingTasks, duplicateIds };
}

function toNode(task: LoadedInboxTask): DependencyTaskNode {
  const node: DependencyTaskNode = {
    id: task.id,
    status: task.status,
    dependsOn: task.dependsOn,
    path: task.path,
  };
  if (task.dependsOnError !== undefined) node.dependsOnError = task.dependsOnError;
  if (task.claimedBy !== undefined) node.claimedBy = task.claimedBy;
  return node;
}
