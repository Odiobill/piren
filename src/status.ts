import { access, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PirenContext } from "./bootstrap.js";

export type PirenWriteMode = "authoritative-vault" | "local-outbox";
export type PirenCacheReadMode = "available-if-degraded" | "unavailable";

export interface PirenStatusReport {
  agentName: string;
  agentDir: string;
  vaultRoot: string;
  allowedAgents: string[];
  excludedAgents: string[];
  packages: string[];
  vaultAvailable: boolean;
  degraded: boolean;
  writeMode: PirenWriteMode;
  localOutboxDir: string;
  localCacheDir: string;
  cacheAvailable: boolean;
  cacheReadMode: PirenCacheReadMode;
  cacheFiles: string[];
  toolNames: string[];
  skillCount: number;
  degradedReason?: string;
}

export interface BuildPirenStatusReportOptions {
  context: PirenContext;
  toolNames: string[];
  localOutboxDir: string;
  localCacheDir: string;
  skillCount?: number;
  packages?: string[];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function checkVaultAvailability(vaultRoot: string): Promise<{ available: true } | { available: false; reason: string }> {
  let metadata;
  try {
    metadata = await stat(vaultRoot);
  } catch {
    return { available: false, reason: `Vault unavailable: ${vaultRoot}` };
  }

  if (!metadata.isDirectory()) {
    return { available: false, reason: `Vault unavailable: ${vaultRoot} is not a directory` };
  }

  const hasMarker = await pathExists(join(vaultRoot, ".piren-vault"));
  const hasFallbackShape = (await pathExists(join(vaultRoot, "steward-directives.md"))) && (await pathExists(join(vaultRoot, "team")));
  if (!hasMarker && !hasFallbackShape) {
    return { available: false, reason: `Vault unavailable: ${vaultRoot} is missing Piren vault markers` };
  }

  return { available: true };
}

async function inspectLocalCache(localCacheDir: string): Promise<{ cacheAvailable: boolean; cacheReadMode: PirenCacheReadMode; cacheFiles: string[] }> {
  try {
    const metadata = await stat(localCacheDir);
    if (!metadata.isDirectory()) {
      return { cacheAvailable: false, cacheReadMode: "unavailable", cacheFiles: [] };
    }
    const entries = await readdir(localCacheDir, { withFileTypes: true });
    const cacheFiles = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    return {
      cacheAvailable: cacheFiles.length > 0,
      cacheReadMode: cacheFiles.length > 0 ? "available-if-degraded" : "unavailable",
      cacheFiles,
    };
  } catch {
    return { cacheAvailable: false, cacheReadMode: "unavailable", cacheFiles: [] };
  }
}

export async function buildPirenStatusReport(options: BuildPirenStatusReportOptions): Promise<PirenStatusReport> {
  const availability = await checkVaultAvailability(options.context.vaultRoot);
  const cache = await inspectLocalCache(options.localCacheDir);
  const toolNames = [...options.toolNames].sort();
  const skillCount = options.skillCount ?? 0;
  const packages = options.packages ?? options.context.packages ?? [];
  const base = {
    agentName: options.context.agentName,
    agentDir: options.context.agentDir,
    vaultRoot: options.context.vaultRoot,
    allowedAgents: [...options.context.allowedAgents],
    excludedAgents: [...options.context.excludedAgents],
    packages: [...packages],
    localOutboxDir: options.localOutboxDir,
    localCacheDir: options.localCacheDir,
    cacheAvailable: cache.cacheAvailable,
    cacheReadMode: cache.cacheReadMode,
    cacheFiles: cache.cacheFiles,
    toolNames,
    skillCount,
  };

  if (availability.available) {
    return {
      ...base,
      vaultAvailable: true,
      degraded: false,
      writeMode: "authoritative-vault",
    };
  }

  if ("reason" in availability) {
    return {
      ...base,
      vaultAvailable: false,
      degraded: true,
      writeMode: "local-outbox",
      degradedReason: availability.reason,
    };
  }

  throw new Error("Unexpected Piren status availability state");
}

export function formatPirenStatusReport(report: PirenStatusReport): string {
  const lines = [
    "Piren status",
    `agent_name: ${report.agentName}`,
    `agent_dir: ${report.agentDir}`,
    `vault_root: ${report.vaultRoot}`,
    `allowed_agents: ${report.allowedAgents.length ? report.allowedAgents.join(", ") : "<not set>"}`,
    `excluded_agents: ${report.excludedAgents.length ? report.excludedAgents.join(", ") : "<not set>"}`,
    `packages: ${report.packages.length ? report.packages.join(", ") : "<none>"}`,
    `vault_available: ${report.vaultAvailable}`,
    `degraded: ${report.degraded}`,
    `write_mode: ${report.writeMode}`,
    `local_outbox_dir: ${report.localOutboxDir}`,
    `local_cache_dir: ${report.localCacheDir}`,
    `cache_available: ${report.cacheAvailable}`,
    `cache_read_mode: ${report.cacheReadMode}`,
    `cache_files: ${report.cacheFiles.length ? report.cacheFiles.join(", ") : "<none>"}`,
    `registered_tools: ${report.toolNames.length ? report.toolNames.join(", ") : "<none>"}`,
    `skills_loaded: ${report.skillCount}`,
  ];

  if (report.degradedReason) {
    lines.push(`degraded_reason: ${report.degradedReason}`);
  }

  return lines.join("\n");
}
