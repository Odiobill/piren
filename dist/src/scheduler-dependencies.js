import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
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
const VALID_STATUSES = ["pending", "in_progress", "completed", "cancelled"];
const SATISFIED_STATUS = "completed";
/**
 * Extract the `depends_on` sequence from a parsed frontmatter object.
 *
 * - Absent field -> empty ids, no error.
 * - Array of strings -> those ids (trimmed; empty entries dropped).
 * - Anything else -> empty ids + error (declaration malformed).
 */
export function extractDependsOn(frontmatter) {
    const raw = frontmatter["depends_on"];
    if (raw === undefined || raw === null)
        return { ids: [] };
    if (!Array.isArray(raw)) {
        return { ids: [], error: "depends_on must be a sequence of task IDs" };
    }
    const ids = [];
    for (const entry of raw) {
        if (typeof entry !== "string") {
            return { ids: [], error: "depends_on must be a sequence of task IDs" };
        }
        const trimmed = entry.trim();
        if (trimmed !== "")
            ids.push(trimmed);
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
export function parseDependencyTaskNode(content, path) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match)
        return undefined;
    const rawFields = match[1] ?? "";
    let parsed;
    try {
        parsed = parseYaml(rawFields);
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return undefined;
    const fields = parsed;
    const id = fields["id"];
    const status = fields["status"];
    if (typeof id !== "string" || id.trim() === "")
        return undefined;
    if (typeof status !== "string")
        return undefined;
    if (!VALID_STATUSES.includes(status))
        return undefined;
    const decl = extractDependsOn(fields);
    const node = {
        id: id.trim(),
        status: status,
        dependsOn: decl.ids,
        path,
    };
    if (decl.error !== undefined)
        node.dependsOnError = decl.error;
    return node;
}
/**
 * Evaluate whether a candidate task is runnable given the full set of visible
 * task nodes. The candidate carries its own id + depends_on; `nodes` provides
 * the prerequisite targets. Pure and deterministic.
 *
 * Validation order (first blocking category wins):
 *   1. malformed depends_on declaration (sequence shape)
 *   2. malformed ids (do not match the task-ID pattern)
 *   3. duplicate ids
 *   4. self-dependency
 *   5. missing target ids (no visible task with that id)
 *   6. dependency cycle involving the candidate
 *   7. unsatisfied (target exists but status != completed)
 *
 * A task with no depends_on (and no declaration error) is always eligible.
 */
export function evaluateTaskDependencyEligibility(candidate, nodes) {
    // 1. malformed declaration
    if (candidate.dependsOnError !== undefined) {
        return { eligible: false, reason: candidate.dependsOnError };
    }
    const deps = candidate.dependsOn;
    if (deps.length === 0)
        return { eligible: true };
    // 2. malformed ids
    const malformed = unique(deps.filter((id) => !TASK_ID_PATTERN.test(id)));
    if (malformed.length > 0) {
        return { eligible: false, reason: `malformed dependency id: ${malformed.join(", ")}` };
    }
    // 3. duplicate ids
    const dupes = duplicates(deps);
    if (dupes.length > 0) {
        return { eligible: false, reason: `duplicate dependency id: ${dupes.join(", ")}` };
    }
    // 4. self-dependency
    if (deps.includes(candidate.id)) {
        return { eligible: false, reason: `self-dependency: ${candidate.id}` };
    }
    // 5. missing target ids
    const missing = deps.filter((id) => !nodes.has(id));
    if (missing.length > 0) {
        return { eligible: false, reason: `missing dependency: ${missing.join(", ")}` };
    }
    // 6. dependency cycle involving the candidate
    const cycle = detectCycleThroughCandidate(candidate, nodes);
    if (cycle !== undefined) {
        return { eligible: false, reason: `dependency cycle: ${cycle.join(" -> ")}` };
    }
    // 7. unsatisfied prerequisites
    const unsatisfied = [];
    for (const id of deps) {
        const target = nodes.get(id);
        if (target === undefined)
            continue; // already reported as missing
        if (target.status !== SATISFIED_STATUS) {
            unsatisfied.push(`${id} (status: ${target.status})`);
        }
    }
    if (unsatisfied.length > 0) {
        return { eligible: false, reason: `unsatisfied dependency: ${unsatisfied.join(", ")}` };
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
function detectCycleThroughCandidate(candidate, nodes) {
    const onPath = [candidate.id];
    const onPathSet = new Set([candidate.id]);
    let found;
    function visit(node) {
        if (found !== undefined)
            return;
        for (const dep of node.dependsOn) {
            if (found !== undefined)
                return;
            if (dep === candidate.id) {
                found = [...onPath, candidate.id];
                return;
            }
            if (onPathSet.has(dep))
                continue; // back-edge not reaching the candidate
            const depNode = nodes.get(dep);
            if (depNode === undefined)
                continue; // missing targets handled upstream
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
function unique(ids) {
    const seen = new Set();
    const out = [];
    for (const id of ids) {
        if (!seen.has(id)) {
            seen.add(id);
            out.push(id);
        }
    }
    return out;
}
function duplicates(ids) {
    const seen = new Set();
    const dupes = new Set();
    const ordered = [];
    for (const id of ids) {
        if (seen.has(id)) {
            if (!dupes.has(id)) {
                dupes.add(id);
                ordered.push(id);
            }
        }
        else {
            seen.add(id);
        }
    }
    return ordered;
}
function claimedDeviceFromName(name) {
    const match = name.match(/\.claimed\.([a-z][a-z0-9-]*)\.md$/);
    return match?.[1];
}
/** Reject agent names that would let the inbox path escape the vault root. */
function assertValidAgentName(agentName) {
    if (!/^[a-z][a-z0-9-]*$/.test(agentName)) {
        throw new Error("Invalid agent name. Use lowercase kebab-case, for example 'piren' or 'research-agent'.");
    }
}
/**
 * Read every Markdown file in one agent's inbox (ordinary AND claimed) and
 * return the parseable task nodes. Tolerant: unparseable files are skipped.
 */
export async function loadInboxDependencyNodes(options) {
    assertValidAgentName(options.agentName);
    const inboxPath = join("team", options.agentName, "inbox");
    const absolutePath = resolve(options.vaultRoot, inboxPath);
    const entries = await readdir(absolutePath, { withFileTypes: true });
    const tasks = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md"))
            continue;
        const taskPath = join(inboxPath, entry.name);
        const content = await readFile(resolve(absolutePath, entry.name), "utf8");
        const node = parseDependencyTaskNode(content, taskPath);
        if (node === undefined)
            continue;
        const loaded = {
            id: node.id,
            status: node.status,
            dependsOn: node.dependsOn,
            path: node.path,
            agentName: options.agentName,
        };
        if (node.dependsOnError !== undefined)
            loaded.dependsOnError = node.dependsOnError;
        const claimedBy = claimedDeviceFromName(entry.name);
        if (claimedBy !== undefined)
            loaded.claimedBy = claimedBy;
        tasks.push(loaded);
    }
    return tasks;
}
/**
 * Load scheduler inbox state across the enabled agent set: a resolver map of
 * every visible task node (so claimed/completed prerequisites resolve) plus
 * the pending, unclaimed candidate tasks. Agent inboxes that do not exist are
 * skipped. Task IDs are globally unique (timestamp-based); on an unexpected
 * collision the last-loaded node wins.
 */
export async function loadSchedulerInboxState(options) {
    const dependencyNodes = new Map();
    const pendingTasks = [];
    for (const agentName of options.enabledAgents) {
        let loaded;
        try {
            loaded = await loadInboxDependencyNodes({ vaultRoot: options.vaultRoot, agentName });
        }
        catch {
            // Inbox directory may not exist yet for this agent; skip.
            continue;
        }
        for (const task of loaded) {
            dependencyNodes.set(task.id, toNode(task));
            if (task.status === "pending" && task.claimedBy === undefined) {
                pendingTasks.push(task);
            }
        }
    }
    return { dependencyNodes, pendingTasks };
}
function toNode(task) {
    const node = {
        id: task.id,
        status: task.status,
        dependsOn: task.dependsOn,
        path: task.path,
    };
    if (task.dependsOnError !== undefined)
        node.dependsOnError = task.dependsOnError;
    return node;
}
//# sourceMappingURL=scheduler-dependencies.js.map