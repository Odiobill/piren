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
/** Pure, bounded selection for one agent's explicitly requested terminal cleanup. */
export declare function planTerminalTaskArchive(options: {
    agentName: string;
    archiveAt: string;
    tasks: readonly ArchiveTask[];
}): {
    eligible: TaskArchivePlanItem[];
    skipped: TaskArchiveSkip[];
};
