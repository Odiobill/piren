import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadInboxDependencyNodes } from "./scheduler-dependencies.js";
import { planTerminalTaskArchive, type ArchiveTask } from "./task-archive.js";

/** Read-only bounded preview for one steward-selected agent's terminal cleanup. */
export async function previewStoredTerminalTaskArchive(
  vaultRoot: string,
  agentName: string,
  now: () => Date = () => new Date(),
) {
  const team = resolve(vaultRoot, "team");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(team, { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read vault team directory: ${message}`);
  }
  const tasks: ArchiveTask[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-z][a-z0-9-]*$/.test(entry.name)) continue;
    try {
      const loaded = await loadInboxDependencyNodes({ vaultRoot, agentName: entry.name });
      tasks.push(...loaded);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`cannot inspect inbox for ${entry.name}: ${message}`);
      }
    }
  }
  return planTerminalTaskArchive({ agentName, archiveAt: now().toISOString(), tasks });
}
