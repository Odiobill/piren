import type { StewardAlert } from "./steward-alerts.js";
import { isDirectActiveStewardAlertPath } from "./steward-alerts.js";

export interface StewardAlertArchivePlan {
  sourcePath: string;
  destinationPath: string;
}

/**
 * Pure, fail-closed archive plan for one explicitly selected closed alert.
 * It deliberately does not inspect the filesystem or move bytes: the mutation
 * adapter must first verify destination absence, then rename this exact source.
 */
export function planStewardAlertArchive(options: { alert: StewardAlert; archiveAt: string }): StewardAlertArchivePlan {
  const { alert, archiveAt } = options;
  if (!isDirectActiveStewardAlertPath(alert.path)) {
    throw new Error("Alert archive source must be one direct active alert path.");
  }
  if (alert.status !== "closed") throw new Error("Only closed alerts may be archived.");
  if (alert.closedAt === undefined || alert.closedVia !== "workbench") {
    throw new Error("Closed alert must have valid closure evidence.");
  }
  const match = archiveAt.match(/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  if (match === null || Number.isNaN(Date.parse(archiveAt))) {
    throw new Error("Archive operation time must be a canonical ISO instant.");
  }
  const name = alert.path.slice("steward-inbox/alerts/".length);
  return {
    sourcePath: alert.path,
    destinationPath: `steward-inbox/alerts/archive/${match[1]}/${match[2]}/${match[3]}/${name}`,
  };
}
