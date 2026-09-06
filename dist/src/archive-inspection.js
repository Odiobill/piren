import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
const AGENT = /^[a-z][a-z0-9-]*$/;
const DATE = /^\d{4}$|^\d{2}$/;
const MAX_ARCHIVED_FILES = 500;
/** Read-only bounded inspection of one canonical archive hierarchy. */
export async function listArchivedFiles(options) {
    let root;
    if (options.kind === "alerts") {
        if (options.agentName !== undefined)
            throw new Error("Alert archives do not take an agent name.");
        root = "steward-inbox/alerts/archive";
    }
    else {
        if (options.agentName === undefined || !AGENT.test(options.agentName))
            throw new Error("A valid agent name is required for this archive.");
        root = `team/${options.agentName}/${options.kind === "tasks" ? "inbox" : "sessions"}/archive`;
    }
    const absoluteRoot = resolve(options.vaultRoot, root);
    const files = [];
    async function descend(dir, depth) {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch (error) {
            if (error.code === "ENOENT")
                return;
            throw error;
        }
        for (const entry of entries) {
            if (entry.name.startsWith("."))
                continue;
            const target = join(dir, entry.name);
            if (depth < 3) {
                if (entry.isDirectory() && DATE.test(entry.name))
                    await descend(target, depth + 1);
            }
            else if (entry.isFile() && entry.name.endsWith(".md")) {
                files.push(relative(resolve(options.vaultRoot), target));
                if (files.length > MAX_ARCHIVED_FILES)
                    throw new Error(`archive inspection exceeds ${MAX_ARCHIVED_FILES} files`);
            }
        }
    }
    await descend(absoluteRoot, 0);
    return files.sort((a, b) => a.localeCompare(b));
}
//# sourceMappingURL=archive-inspection.js.map