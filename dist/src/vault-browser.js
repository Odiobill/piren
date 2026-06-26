import { open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveVaultPath } from "./vault-tools.js";
const MAX_LIST_ENTRIES = 100;
const MAX_READ_BYTES = 500_000; // 500 KB
/**
 * List directory contents under a vault root path.
 * Dirs first, alpha-sorted, capped entries, dotfiles hidden.
 * Reuses resolveVaultPath for path-boundary enforcement.
 */
export async function vaultBrowserList(vaultRoot, inputPath) {
    const resolved = resolveVaultPath(vaultRoot, inputPath);
    const dirents = await readdir(resolved.absolutePath, {
        withFileTypes: true,
    });
    const entries = [];
    for (const entry of dirents) {
        // Skip dotfiles (e.g. .piren-vault marker).
        if (entry.name.startsWith("."))
            continue;
        const absolutePath = join(resolved.absolutePath, entry.name);
        const metadata = await stat(absolutePath);
        const relPath = resolved.vaultPath
            ? `${resolved.vaultPath}/${entry.name}`
            : entry.name;
        const type = entry.isDirectory()
            ? "directory"
            : entry.isFile()
                ? "file"
                : "other";
        const listEntry = {
            name: entry.name,
            path: relPath,
            type,
            mtimeMs: metadata.mtimeMs,
        };
        if (type === "file") {
            listEntry.bytes = metadata.size;
        }
        entries.push(listEntry);
    }
    // Sort: dirs first (alpha), then files (alpha).
    const sorted = [...entries].sort((a, b) => {
        if (a.type === "directory" && b.type !== "directory")
            return -1;
        if (a.type !== "directory" && b.type === "directory")
            return 1;
        return a.name.localeCompare(b.name);
    });
    const capped = sorted.length > MAX_LIST_ENTRIES;
    const trimmed = capped ? sorted.slice(0, MAX_LIST_ENTRIES) : sorted;
    return {
        path: resolved.vaultPath,
        entries: trimmed,
        capped,
    };
}
/**
 * Read a file under a vault root path with a size cap.
 * Reuses resolveVaultPath for path-boundary enforcement.
 */
export async function vaultBrowserRead(vaultRoot, inputPath) {
    const resolved = resolveVaultPath(vaultRoot, inputPath);
    const metadata = await stat(resolved.absolutePath);
    const totalSize = metadata.size;
    if (totalSize > MAX_READ_BYTES) {
        const fh = await open(resolved.absolutePath, "r");
        try {
            const buf = Buffer.alloc(MAX_READ_BYTES);
            await fh.read(buf, 0, MAX_READ_BYTES, 0);
            return {
                path: resolved.vaultPath,
                content: buf.toString("utf8") +
                    "\n\n... (file truncated)",
                bytes: totalSize,
                mtimeMs: metadata.mtimeMs,
                capped: true,
            };
        }
        finally {
            await fh.close();
        }
    }
    const content = await readFile(resolved.absolutePath, "utf8");
    return {
        path: resolved.vaultPath,
        content,
        bytes: totalSize,
        mtimeMs: metadata.mtimeMs,
        capped: false,
    };
}
//# sourceMappingURL=vault-browser.js.map