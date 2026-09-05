import { access, mkdir, readdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

/** Confirmed basic-filesystem move for exactly the terminal-task preview set. */
export async function archiveStoredTerminalTasks(options: {
  vaultRoot: string;
  agentName: string;
  expectedDestinations: readonly string[];
  now?: () => Date;
}) {
  const preview = await previewStoredTerminalTaskArchive(options.vaultRoot, options.agentName, options.now);
  const destinations = preview.eligible.map((item) => item.destinationPath);
  if (destinations.length !== options.expectedDestinations.length || destinations.some((value, index) => value !== options.expectedDestinations[index])) {
    throw new Error("task archive destinations do not match preview");
  }
  const moved = [];
  for (const item of preview.eligible) {
    const source = resolve(options.vaultRoot, item.sourcePath);
    const destination = resolve(options.vaultRoot, item.destinationPath);
    await mkdir(dirname(destination), { recursive: true });
    try {
      await access(destination);
      throw new Error(`task archive destination already exists: ${item.destinationPath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(source, destination);
    moved.push(item);
  }
  return { ...preview, moved };
}
