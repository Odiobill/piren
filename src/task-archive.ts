import type { TaskStatus } from "./inbox.js";

export interface ArchiveTask {
  id: string;
  status: TaskStatus;
  path: string;
  agentName: string;
  dependsOn: readonly string[];
  claimedBy?: string;
}

export interface TaskArchivePlanItem {
  sourcePath: string;
  destinationPath: string;
}

export interface TaskArchiveSkip {
  sourcePath: string;
  reason: string;
}

const AGENT = /^[a-z][a-z0-9-]*$/;
const DIRECT_TASK = /^team\/([a-z][a-z0-9-]*)\/inbox\/([^/]+\.md)$/;
const TERMINAL = new Set<TaskStatus>(["completed", "cancelled"]);

function destination(path: string, archiveAt: string): string {
  const date = archiveAt.match(/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  if (date === null || Number.isNaN(Date.parse(archiveAt))) throw new Error("Archive operation time must be a canonical ISO instant.");
  const match = path.match(DIRECT_TASK);
  if (match === null) throw new Error("Task archive source must be a direct inbox Markdown file.");
  return `team/${match[1]}/inbox/archive/${date[1]}/${date[2]}/${date[3]}/${match[2]}`;
}

/** Pure, bounded selection for one agent's explicitly requested terminal cleanup. */
export function planTerminalTaskArchive(options: { agentName: string; archiveAt: string; tasks: readonly ArchiveTask[] }): { eligible: TaskArchivePlanItem[]; skipped: TaskArchiveSkip[] } {
  if (!AGENT.test(options.agentName)) throw new Error("Invalid archive agent name.");
  // Validate the time even if the selected inbox has no terminal tasks.
  destination(`team/${options.agentName}/inbox/.archive-time-check.md`, options.archiveAt);
  const liveDependents = new Map<string, string>();
  for (const task of options.tasks) {
    if (!TERMINAL.has(task.status)) {
      for (const dependency of task.dependsOn) liveDependents.set(dependency, task.id);
    }
  }
  const eligible: TaskArchivePlanItem[] = [];
  const skipped: TaskArchiveSkip[] = [];
  for (const task of [...options.tasks].sort((left, right) => left.path.localeCompare(right.path))) {
    if (task.agentName !== options.agentName || !TERMINAL.has(task.status)) continue;
    const sourcePath = task.path;
    const dependent = liveDependents.get(task.id);
    if (dependent !== undefined) {
      skipped.push({ sourcePath, reason: `required by live task: ${dependent}` });
      continue;
    }
    eligible.push({ sourcePath, destinationPath: destination(sourcePath, options.archiveAt) });
  }
  return { eligible, skipped };
}
