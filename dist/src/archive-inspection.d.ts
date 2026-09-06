export type ArchiveKind = "alerts" | "tasks" | "sessions";
/** Read-only bounded inspection of one canonical archive hierarchy. */
export declare function listArchivedFiles(options: {
    vaultRoot: string;
    kind: ArchiveKind;
    agentName?: string;
}): Promise<string[]>;
