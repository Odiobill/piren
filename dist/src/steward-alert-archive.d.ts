import type { StewardAlert } from "./steward-alerts.js";
export interface StewardAlertArchivePlan {
    sourcePath: string;
    destinationPath: string;
}
/**
 * Pure, fail-closed archive plan for one explicitly selected closed alert.
 * It deliberately does not inspect the filesystem or move bytes: the mutation
 * adapter must first verify destination absence, then rename this exact source.
 */
export declare function planStewardAlertArchive(options: {
    alert: StewardAlert;
    archiveAt: string;
}): StewardAlertArchivePlan;
