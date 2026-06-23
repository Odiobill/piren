import { rm } from "node:fs/promises";

export interface CleanPirenOptions {
  force: boolean;
  configDir: string;
  stateDir: string;
}

export interface CleanPirenReport {
  dryRun: boolean;
  wouldRemove: string[];
  removed: string[];
  errors: string[];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    const { access } = await import("node:fs/promises");
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function cleanPiren(options: CleanPirenOptions): Promise<CleanPirenReport> {
  const wouldRemove: string[] = [];
  const removed: string[] = [];
  const errors: string[] = [];

  const candidates = [options.configDir, options.stateDir];

  for (const dir of candidates) {
    if (await pathExists(dir)) {
      wouldRemove.push(dir);
    }
  }

  if (options.force) {
    for (const dir of wouldRemove) {
      try {
        await rm(dir, { recursive: true, force: true });
        removed.push(dir);
      } catch (err) {
        errors.push(
          `${dir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return {
    dryRun: !options.force,
    wouldRemove: options.force ? [] : wouldRemove,
    removed,
    errors,
  };
}

export function formatCleanReport(report: CleanPirenReport): string {
  const lines: string[] = [];

  if (report.dryRun) {
    lines.push("Piren clean (dry run — nothing was removed)");
    lines.push("");
    if (report.wouldRemove.length === 0) {
      lines.push("Nothing to clean. Piren state directories are already absent.");
      return lines.join("\n");
    }
    lines.push("The following would be removed:");
    for (const d of report.wouldRemove) {
      lines.push(`  ${d}`);
    }
    lines.push("");
    lines.push("Run with --force to actually remove these directories.");
    return lines.join("\n");
  }

  if (report.removed.length > 0) {
    lines.push("Piren clean — removed:");
    for (const d of report.removed) {
      lines.push(`  ${d}`);
    }
  }

  if (report.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const e of report.errors) {
      lines.push(`  ${e}`);
    }
  }

  if (report.removed.length === 0 && report.errors.length === 0) {
    lines.push("Nothing to clean.");
  }

  return lines.join("\n");
}
