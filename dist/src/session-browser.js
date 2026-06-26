import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveVaultPath } from "./vault-tools.js";
const MAX_SESSIONS = 100;
/**
 * Parse a session-summary Markdown file's frontmatter and first heading into
 * a loose `created` + `title`. Files without frontmatter still work: the title
 * falls back to the filename stem.
 */
function parseSessionSummary(content, filename) {
    let created = null;
    const lines = content.split("\n");
    // Parse YAML frontmatter if present (between leading --- fences).
    if (lines[0]?.trim() === "---") {
        let end = -1;
        for (let i = 1; i < lines.length; i++) {
            if (lines[i]?.trim() === "---") {
                end = i;
                break;
            }
        }
        if (end > 1) {
            for (let i = 1; i < end; i++) {
                const line = lines[i] ?? "";
                const match = /^created:\s*(.+?)\s*$/.exec(line);
                if (match && match[1]) {
                    created = match[1];
                }
            }
        }
    }
    // Title from the first `# Heading` outside the frontmatter.
    let title = "";
    const bodyStart = lines[0]?.trim() === "---" ? 0 : 0;
    for (let i = bodyStart; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const headingMatch = /^#\s+(.+?)\s*$/.exec(line);
        if (headingMatch && headingMatch[1]) {
            title = headingMatch[1];
            break;
        }
    }
    if (!title) {
        // Fall back to the filename stem (without extension).
        const stem = filename.replace(/\.md$/i, "");
        title = stem;
    }
    return { created, title };
}
/**
 * List session-summary files under `team/<agent>/sessions/` for a vault.
 *
 * Session summaries are the vault-durable records written by
 * `session_write_summary`. This is the "past conversations" surface for the
 * web UI's session list. Files are sorted newest-first by filename (the
 * timestamp-prefixed naming from session_write_summary sorts chronologically).
 *
 * Reuses resolveVaultPath for path-boundary enforcement: the resolved
 * directory must be inside the vault.
 */
export async function listAgentSessions(vaultRoot, agentName) {
    const relDir = `team/${agentName}/sessions`;
    const resolved = resolveVaultPath(vaultRoot, relDir);
    let dirents;
    try {
        dirents = await readdir(resolved.absolutePath, { withFileTypes: true });
    }
    catch (err) {
        // Missing sessions directory is not an error: return an empty list.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith("ENOENT") || msg.includes("ENOENT")) {
            return { agent: agentName, sessions: [] };
        }
        throw err;
    }
    const entries = [];
    for (const entry of dirents) {
        if (!entry.isFile())
            continue;
        if (!entry.name.endsWith(".md"))
            continue;
        if (entry.name.startsWith("."))
            continue;
        const absolutePath = join(resolved.absolutePath, entry.name);
        const metadata = await stat(absolutePath);
        const content = await readFile(absolutePath, "utf8");
        const parsed = parseSessionSummary(content, entry.name);
        entries.push({
            name: entry.name,
            path: `${relDir}/${entry.name}`,
            title: parsed.title,
            created: parsed.created,
            bytes: metadata.size,
            mtimeMs: metadata.mtimeMs,
        });
    }
    // Sort newest-first. The primary key is the `created` frontmatter date
    // (ISO string, sorts chronologically): dated sessions come first, newest
    // first. Files without a `created` date fall to the end, sorted by name
    // descending so the list is still deterministic.
    const dated = [];
    const undated = [];
    for (const entry of entries) {
        if (entry.created) {
            dated.push(entry);
        }
        else {
            undated.push(entry);
        }
    }
    dated.sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
    undated.sort((a, b) => b.name.localeCompare(a.name));
    const sorted = [...dated, ...undated].slice(0, MAX_SESSIONS);
    return { agent: agentName, sessions: sorted };
}
//# sourceMappingURL=session-browser.js.map