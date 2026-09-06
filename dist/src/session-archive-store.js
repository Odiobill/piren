import { access, mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { planSessionSummaryArchive } from "./session-archive.js";
/**
 * Read-only exact-session archive preview. It deliberately neither creates the
 * archive hierarchy nor changes session-browser or Pi session state.
 */
export async function previewStoredSessionSummaryArchive(vaultRoot, path, now = () => new Date()) {
    const plan = planSessionSummaryArchive({ path, archiveAt: now().toISOString() });
    const source = resolve(vaultRoot, plan.sourcePath);
    try {
        const sourceStat = await stat(source);
        if (!sourceStat.isFile())
            throw new Error("session archive source is not a regular file");
        await readFile(source); // prove the selected summary is readable before offering a move.
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`cannot read session summary: ${message}`);
    }
    try {
        await access(resolve(vaultRoot, plan.destinationPath));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return plan;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`cannot inspect session archive destination: ${message}`);
    }
    throw new Error("session archive destination already exists");
}
/**
 * Explicitly confirmed basic-filesystem move for one vault summary. The caller
 * must send the destination it just previewed; this function never chooses one.
 */
export async function archiveStoredSessionSummary(options) {
    const plan = await previewStoredSessionSummaryArchive(options.vaultRoot, options.path, options.now);
    if (plan.destinationPath !== options.expectedDestination) {
        throw new Error("session archive destination does not match preview");
    }
    const source = resolve(options.vaultRoot, plan.sourcePath);
    const destination = resolve(options.vaultRoot, plan.destinationPath);
    await mkdir(dirname(destination), { recursive: true });
    try {
        await access(destination);
        throw new Error("session archive destination already exists");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    try {
        await rename(source, destination);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`cannot archive session summary: ${message}`);
    }
    return plan;
}
//# sourceMappingURL=session-archive-store.js.map