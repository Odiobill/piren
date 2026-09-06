export interface SessionSummaryArchivePlan {
    sourcePath: string;
    destinationPath: string;
}
/** Pure, fail-closed plan for one explicitly selected vault session summary. */
export declare function planSessionSummaryArchive(options: {
    path: string;
    archiveAt: string;
}): SessionSummaryArchivePlan;
