/** Read-only bounded preview for one steward-selected agent's terminal cleanup. */
export declare function previewStoredTerminalTaskArchive(vaultRoot: string, agentName: string, now?: () => Date): Promise<{
    eligible: import("./task-archive.js").TaskArchivePlanItem[];
    skipped: import("./task-archive.js").TaskArchiveSkip[];
}>;
/** Confirmed basic-filesystem move for exactly the terminal-task preview set. */
export declare function archiveStoredTerminalTasks(options: {
    vaultRoot: string;
    agentName: string;
    expectedDestinations: readonly string[];
    now?: () => Date;
}): Promise<{
    moved: import("./task-archive.js").TaskArchivePlanItem[];
    eligible: import("./task-archive.js").TaskArchivePlanItem[];
    skipped: import("./task-archive.js").TaskArchiveSkip[];
}>;
