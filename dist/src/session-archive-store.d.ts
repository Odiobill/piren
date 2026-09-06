import { type SessionSummaryArchivePlan } from "./session-archive.js";
/**
 * Read-only exact-session archive preview. It deliberately neither creates the
 * archive hierarchy nor changes session-browser or Pi session state.
 */
export declare function previewStoredSessionSummaryArchive(vaultRoot: string, path: string, now?: () => Date): Promise<SessionSummaryArchivePlan>;
/**
 * Explicitly confirmed basic-filesystem move for one vault summary. The caller
 * must send the destination it just previewed; this function never chooses one.
 */
export declare function archiveStoredSessionSummary(options: {
    vaultRoot: string;
    path: string;
    expectedDestination: string;
    now?: () => Date;
}): Promise<SessionSummaryArchivePlan>;
