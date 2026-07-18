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
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { readFile, stat, readdir, access } from "node:fs/promises";
/** Priorities accepted by the documented `piren task send --priority` surface. */
export const CLI_PRIORITIES = ["normal", "high", "urgent"];
export function isValidCliPriority(value) {
    return CLI_PRIORITIES.includes(value);
}
// ---------------------------------------------------------------------------
// Path / id heuristics
// ---------------------------------------------------------------------------
/**
 * Decide whether an input looks like a task path (contains a separator or ends
 * in .md) rather than a bare task id. Bare ids (no slash, no backslash, no
 * .md suffix) are treated as ids to be resolved.
 */
export function isLikelyTaskPath(input) {
    return input.includes("/") || input.includes("\\") || input.endsWith(".md");
}
// ---------------------------------------------------------------------------
// Containment validation
// ---------------------------------------------------------------------------
/**
 * Assert that an absolute target path stays within the vault root. Throws on
 * traversal (`..`) or absolute paths that resolve outside the vault.
 */
export function assertVaultContained(vaultRoot, absPath) {
    const normalizedVault = resolve(vaultRoot);
    const normalizedPath = resolve(absPath);
    const rel = relative(normalizedVault, normalizedPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`Path resolves outside vault: ${absPath}`);
    }
}
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
/**
 * Validate a vault-relative task path has the inbox structure
 * `team/<agent>/inbox/<file>.md` and that the agent segment is a safe kebab
 * name. Returns the parsed agent name and filename. Throws on malformed
 * structure, traversal, or non-markdown files.
 */
export function assertInboxTaskRelPath(vaultRoot, relPath) {
    const absolute = resolve(vaultRoot, relPath);
    assertVaultContained(vaultRoot, absolute);
    const rel = relative(resolve(vaultRoot), absolute);
    const parts = rel.split(/[\\/]+/);
    if (parts.length < 4 ||
        parts[0] !== "team" ||
        parts[2] !== "inbox" ||
        !(parts[3] ?? "").endsWith(".md")) {
        throw new Error("Task path must point to a Markdown task file under team/<agent>/inbox/.");
    }
    const agentName = parts[1] ?? "";
    if (!AGENT_NAME_PATTERN.test(agentName)) {
        throw new Error("Invalid agent name. Use lowercase kebab-case, for example 'piren' or 'research-agent'.");
    }
    return { agentName, fileName: parts.slice(3).join("/") };
}
function splitFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match)
        return null;
    return { raw: match[1] ?? "", body: match[2] ?? "" };
}
function parseTaskFields(content, path) {
    const split = splitFrontmatter(content);
    if (!split) {
        throw new Error(`Task file is missing YAML frontmatter: ${path}`);
    }
    const fields = {};
    for (const line of split.raw.split("\n")) {
        const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (m)
            fields[m[1] ?? ""] = m[2] ?? "";
    }
    return { fields, body: split.body };
}
function firstMarkdownHeading(body) {
    const match = body.match(/^#\s+(.+)$/m);
    return match?.[1]?.trim() || "Untitled task";
}
// ---------------------------------------------------------------------------
// Id / path resolution
// ---------------------------------------------------------------------------
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
export async function resolveTaskIdOrPath(deps, vaultRoot, input, agent) {
    if (isLikelyTaskPath(input)) {
        const parsed = assertInboxTaskRelPath(vaultRoot, input);
        return { path: input, agentName: parsed.agentName };
    }
    // Id resolution.
    const searchAgents = [];
    if (agent !== undefined) {
        if (!AGENT_NAME_PATTERN.test(agent)) {
            throw new Error("Invalid agent name. Use lowercase kebab-case, for example 'piren' or 'research-agent'.");
        }
        searchAgents.push(agent);
    }
    else {
        const teamDir = join(vaultRoot, "team");
        let entries = [];
        try {
            entries = await deps.readdir(teamDir);
        }
        catch {
            entries = [];
        }
        for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith(".") && AGENT_NAME_PATTERN.test(entry.name)) {
                searchAgents.push(entry.name);
            }
        }
    }
    const matches = [];
    for (const agentName of searchAgents) {
        const inboxDir = join(vaultRoot, "team", agentName, "inbox");
        let entries = [];
        try {
            entries = await deps.readdir(inboxDir);
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith(".md"))
                continue;
            const abs = join(inboxDir, entry.name);
            let fields = {};
            try {
                const content = await deps.readFile(abs);
                fields = parseTaskFields(content, abs).fields;
            }
            catch {
                // Unreadable/unparseable: fall back to filename match only.
            }
            const idField = fields.id;
            const stem = entry.name.replace(/\.md$/i, "");
            const matchesById = idField !== undefined && idField === input;
            const matchesByName = stem === input || stem.startsWith(input + ".claimed.");
            if (matchesById || matchesByName) {
                matches.push({ agentName, relPath: relative(resolve(vaultRoot), abs) });
            }
        }
    }
    if (matches.length === 0) {
        throw new Error(`Task not found: ${input}`);
    }
    if (matches.length > 1) {
        const distinctAgents = new Set(matches.map((m) => m.agentName));
        if (distinctAgents.size > 1) {
            throw new Error(`Task id '${input}' is ambiguous across agents (${[...distinctAgents].join(", ")}). Pass --agent <agent> to disambiguate.`);
        }
        // Same agent, multiple files (e.g. stale claim + fresh): prefer the
        // unclaimed file when present, else the first match.
        const unclaimed = matches.find((m) => !m.relPath.includes(".claimed."));
        const chosen = unclaimed ?? matches[0];
        return { path: chosen.relPath, agentName: chosen.agentName };
    }
    return { path: matches[0].relPath, agentName: matches[0].agentName };
}
// ---------------------------------------------------------------------------
// Body / result file reading
// ---------------------------------------------------------------------------
/**
 * Read a body/result file from inside the vault. The file argument may be
 * vault-relative or absolute, but it must resolve inside the vault root.
 * Throws on traversal or out-of-vault absolute paths. This deliberately keeps
 * human-supplied --body/--result content vault-scoped.
 */
export async function readVaultFile(deps, vaultRoot, file) {
    const abs = isAbsolute(file) ? file : resolve(vaultRoot, file);
    assertVaultContained(vaultRoot, abs);
    return deps.readFile(abs);
}
// ---------------------------------------------------------------------------
// Task detail parsing (for `show`)
// ---------------------------------------------------------------------------
/**
 * Read and parse a task file at a vault-relative path into a rich detail view.
 * Validates vault containment and inbox structure before reading.
 */
export async function readTaskDetail(deps, vaultRoot, relPath) {
    const parsed = assertInboxTaskRelPath(vaultRoot, relPath);
    const abs = resolve(vaultRoot, relPath);
    const content = await deps.readFile(abs);
    const { fields, body } = parseTaskFields(content, relPath);
    return {
        id: fields.id ?? "",
        path: relPath,
        title: firstMarkdownHeading(body),
        from: fields.from ?? "",
        to: fields.to ?? parsed.agentName,
        status: fields.status ?? "pending",
        priority: fields.priority ?? "normal",
        created: fields.created ?? "",
        updated: fields.updated ?? "",
        requiresApproval: fields.requires_approval === "true",
        body,
    };
}
// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------
function pad(value, width) {
    return value.length >= width ? value : value + " ".repeat(width - value.length);
}
/** Format a list of task rows as a compact table. */
export function formatTaskList(rows) {
    if (rows.length === 0)
        return "No tasks found.";
    const statusWidth = Math.max(6, ...rows.map((r) => r.status.length));
    const fromWidth = Math.max(4, ...rows.map((r) => r.from.length));
    const titleWidth = Math.min(40, Math.max(5, ...rows.map((r) => r.title.length)));
    const lines = [];
    lines.push(`${pad("STATUS", statusWidth)}  ${pad("FROM", fromWidth)}  ${pad("TITLE", titleWidth)}  PATH`);
    lines.push(`${"-".repeat(statusWidth)}  ${"-".repeat(fromWidth)}  ${"-".repeat(titleWidth)}  ${"-".repeat(4)}`);
    for (const row of rows) {
        const title = row.title.length > titleWidth ? row.title.slice(0, titleWidth - 1) + "…" : row.title;
        lines.push(`${pad(row.status, statusWidth)}  ${pad(row.from, fromWidth)}  ${pad(title, titleWidth)}  ${row.path}`);
    }
    return lines.join("\n");
}
/** Format a single task detail view. */
export function formatTaskDetail(detail) {
    const lines = [];
    lines.push(`Title: ${detail.title}`);
    lines.push(`Path: ${detail.path}`);
    lines.push(`ID: ${detail.id}`);
    lines.push(`From: ${detail.from}`);
    lines.push(`To: ${detail.to}`);
    lines.push(`Status: ${detail.status}`);
    lines.push(`Priority: ${detail.priority}`);
    if (detail.created)
        lines.push(`Created: ${detail.created}`);
    if (detail.updated)
        lines.push(`Updated: ${detail.updated}`);
    lines.push(`Requires approval: ${detail.requiresApproval ? "true" : "false"}`);
    lines.push("");
    lines.push(detail.body.trim());
    return lines.join("\n");
}
/** Bare-filename helper kept exported for symmetry with other CLI cores. */
export function taskFileName(path) {
    return basename(path);
}
// ---------------------------------------------------------------------------
// Real adapter
// ---------------------------------------------------------------------------
export function createRealTaskCliDeps() {
    return {
        readFile: async (path) => {
            const buf = await readFile(path);
            return buf.toString("utf8");
        },
        stat: async (path) => {
            const s = await stat(path);
            return { isDirectory: () => s.isDirectory() };
        },
        readdir: async (path) => {
            const entries = await readdir(path, { withFileTypes: true });
            return entries.map((e) => ({
                name: e.name,
                isDirectory: () => e.isDirectory(),
                isFile: () => e.isFile(),
            }));
        },
        access: async (path) => {
            await access(path);
        },
    };
}
//# sourceMappingURL=task-cli.js.map