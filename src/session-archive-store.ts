import { access, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { planSessionSummaryArchive, type SessionSummaryArchivePlan } from "./session-archive.js";

/**
 * Read-only exact-session archive preview. It deliberately neither creates the
 * archive hierarchy nor changes session-browser or Pi session state.
 */
export async function previewStoredSessionSummaryArchive(
  vaultRoot: string,
  path: string,
  now: () => Date = () => new Date(),
): Promise<SessionSummaryArchivePlan> {
  const plan = planSessionSummaryArchive({ path, archiveAt: now().toISOString() });
  const source = resolve(vaultRoot, plan.sourcePath);
  try {
    const sourceStat = await stat(source);
    if (!sourceStat.isFile()) throw new Error("session archive source is not a regular file");
    await readFile(source); // prove the selected summary is readable before offering a move.
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read session summary: ${message}`);
  }
  try {
    await access(resolve(vaultRoot, plan.destinationPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return plan;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot inspect session archive destination: ${message}`);
  }
  throw new Error("session archive destination already exists");
}
