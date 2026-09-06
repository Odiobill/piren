import { type StewardAlert, type StewardAlertProjection } from "./steward-alerts.js";
export declare class StewardAlertStoreError extends Error {
    readonly kind: "bad-request" | "not-found" | "conflict";
    constructor(message: string, kind: "bad-request" | "not-found" | "conflict");
}
/** Read and strictly validate exactly one direct active alert. */
export declare function readStewardAlert(vaultRoot: string, path: string): Promise<{
    alert: StewardAlert;
    content: string;
}>;
/** Read the bounded direct active-alert directory and produce its projection. */
export declare function listStewardAlerts(vaultRoot: string): Promise<StewardAlertProjection>;
/**
 * Preview one exact closed alert archive. This adapter only validates current
 * source evidence and destination vacancy; it never creates or moves anything.
 */
export declare function previewStoredStewardAlertArchive(vaultRoot: string, path: string, now?: () => Date): Promise<import("./steward-alert-archive.js").StewardAlertArchivePlan>;
/** Explicitly confirmed basic-filesystem move for one previewed closed alert. */
export declare function archiveStoredStewardAlert(options: {
    vaultRoot: string;
    path: string;
    expectedDestination: string;
    now?: () => Date;
}): Promise<import("./steward-alert-archive.js").StewardAlertArchivePlan>;
/**
 * Close one exact open alert. The caller supplies the only accepted expected
 * state; it cannot use this adapter to reopen or edit alert content.
 */
export declare function closeStoredStewardAlert(options: {
    vaultRoot: string;
    path: string;
    expectedStatus: "open";
    now?: () => Date;
}): Promise<StewardAlert>;
