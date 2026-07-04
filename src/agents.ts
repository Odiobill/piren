import { access, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { BootstrapOptions, LocalPirenConfig } from "./bootstrap.js";
import { resolveAgentGroups, recommendFallback, type FallbackRecommendation } from "./agent-groups.js";

export interface AgentsReport {
  vaultRoot?: string;
  vaultAgents: string[];
  allowedAgents: string[];
  excludedAgents: string[];
  runnableAgents: string[];
  missingAllowedAgents: string[];
  staleVaultAgents?: string[];
  unsafePolicy?: boolean;
  /** Agent name -> group names they belong to (Slice 3c). */
  groups?: Map<string, string[]>;
}

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "piren", "config.yml");

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readYamlConfig(path: string): Promise<LocalPirenConfig> {
  if (!(await pathExists(path))) return {};
  const content = await readFile(path, "utf8");
  const parsed = parseYaml(content) as unknown;
  if (!parsed || typeof parsed !== "object") return {};
  return parsed as LocalPirenConfig;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function uniquePreservingOrder(values: string[]): string[] {
  return Array.from(new Set(values));
}

function sorted(values: string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

async function readVaultAgents(vaultRoot: string): Promise<string[]> {
  const teamDir = join(vaultRoot, "team");
  if (!(await pathExists(teamDir))) return [];
  const entries = await readdir(teamDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function readStaleVaultAgents(vaultRoot: string, vaultAgents: string[]): Promise<string[]> {
  const stale: string[] = [];
  for (const agent of vaultAgents) {
    const agentDir = join(vaultRoot, "team", agent);
    const hasSoul = await pathExists(join(agentDir, "SOUL.md"));
    const hasMemory = await pathExists(join(agentDir, "MEMORY.md"));
    if (!hasSoul || !hasMemory) {
      stale.push(agent);
    }
  }
  return stale;
}

export async function listPirenAgents(options: BootstrapOptions = {}): Promise<AgentsReport> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const config = await readYamlConfig(configPath);
  const vaultRoot = options.cliVaultRoot ?? config.vault_root;
  const allowedAgents = uniquePreservingOrder(normalizeStringArray(config.allowed_agents));
  const excludedAgents = uniquePreservingOrder(normalizeStringArray(config.excluded_agents));
  const resolvedVaultRoot = vaultRoot === undefined ? undefined : resolve(vaultRoot);
  const vaultAgents = resolvedVaultRoot === undefined ? [] : await readVaultAgents(resolvedVaultRoot);
  const staleVaultAgents = resolvedVaultRoot === undefined ? [] : await readStaleVaultAgents(resolvedVaultRoot, vaultAgents);
  const healthyVaultAgents = vaultAgents.filter((agent) => !staleVaultAgents.includes(agent));
  const runnableSource = allowedAgents.length > 0 ? allowedAgents : healthyVaultAgents;
  const runnableAgents = sorted(uniquePreservingOrder(runnableSource.filter((agent) => !excludedAgents.includes(agent) && healthyVaultAgents.includes(agent))));
  const missingAllowedAgents = uniquePreservingOrder(allowedAgents.filter((agent) => !vaultAgents.includes(agent)));

  // Resolve group memberships for all vault agents (Slice 3c).
  const groups = new Map<string, string[]>();
  if (resolvedVaultRoot !== undefined) {
    for (const agent of vaultAgents) {
      groups.set(agent, await resolveAgentGroups(resolvedVaultRoot, agent));
    }
  }

  const report: AgentsReport = {
    vaultAgents,
    allowedAgents,
    excludedAgents,
    runnableAgents,
    missingAllowedAgents,
    groups,
  };
  if (allowedAgents.length === 0 && vaultRoot !== undefined) report.unsafePolicy = true;
  if (staleVaultAgents.length > 0) report.staleVaultAgents = staleVaultAgents;
  if (resolvedVaultRoot !== undefined) report.vaultRoot = resolvedVaultRoot;
  return report;
}

export function formatAgentsReport(report: AgentsReport): string {
  const lines = ["Piren agents"];
  if (report.vaultRoot) lines.push(`vault_root: ${report.vaultRoot}`);
  lines.push(`allowed_agents: ${report.allowedAgents.length ? report.allowedAgents.join(", ") : "<not set>"}`);
  lines.push(`excluded_agents: ${report.excludedAgents.length ? report.excludedAgents.join(", ") : "<not set>"}`);
  if (report.unsafePolicy) {
    lines.push("");
    lines.push("WARNING: no allowed_agents configured. Any vault agent with a team/ directory can run on this installation.");
  }
  lines.push("");
  lines.push("vault-defined:");
  if (report.vaultAgents.length === 0) {
    lines.push("  <none>");
  } else {
    for (const agent of report.vaultAgents) {
      const isStale = report.staleVaultAgents?.includes(agent);
      const label = report.runnableAgents.includes(agent) ? "runnable" : isStale ? "stale" : "vault-only";
      const agentGroups = report.groups?.get(agent);
      const groupInfo = agentGroups && agentGroups.length > 0 ? `groups: ${agentGroups.join(", ")}` : "<no groups>";
      lines.push(`  [${label}] ${agent} ${groupInfo}`);
    }
  }
  if (report.missingAllowedAgents.length > 0) {
    lines.push("");
    lines.push("allowed-but-missing:");
    for (const agent of report.missingAllowedAgents) lines.push(`  [missing] ${agent}`);
  }
  return lines.join("\n");
}

/**
 * Options for {@link listFallbackCandidates}.
 */
export interface FallbackOptions {
  /** Path to the local config.yml. Defaults to ~/.config/piren/config.yml. */
  configPath?: string;
  /** Override allowed_agents from config. */
  allowedAgents?: string[];
  /** Override excluded_agents from config. */
  excludedAgents?: string[];
}

/**
 * Resolve read-only fallback candidates for a failed agent, reading local
 * runnable-agent policy from the config file unless overridden in options.
 * Returns an empty array when the agent has no eligible fallback candidates.
 *
 * This is a diagnostic helper, not an automatic rerouting action.
 */
export async function listFallbackCandidates(
  vaultRoot: string,
  agentName: string,
  options: FallbackOptions = {},
): Promise<FallbackRecommendation[]> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const config = await readYamlConfig(configPath);
  const resolvedVaultRoot = resolve(vaultRoot);

  const rawAllowed = options.allowedAgents ??
    uniquePreservingOrder(normalizeStringArray(config.allowed_agents));
  const excludedAgents = options.excludedAgents ??
    uniquePreservingOrder(normalizeStringArray(config.excluded_agents));

  // Filter allowed agents to only those that actually exist in the vault
  // (healthy: has SOUL.md + MEMORY.md). This matches the runnable set
  // computed by listPirenAgents. An empty rawAllowed (no policy) means
  // "allow all healthy vault agents".
  const vaultAgents = await readVaultAgents(resolvedVaultRoot);
  const staleAgents = await readStaleVaultAgents(resolvedVaultRoot, vaultAgents);
  const healthyAgents = new Set(vaultAgents.filter((a) => !staleAgents.includes(a)));
  const allowedAgents = rawAllowed.length > 0
    ? rawAllowed.filter((a) => healthyAgents.has(a))
    : [...healthyAgents];

  return recommendFallback(resolvedVaultRoot, agentName, allowedAgents, excludedAgents);
}

/**
 * Format the fallback recommendation report for CLI output.
 *
 * Example output:
 * ```
 * Fallback candidates for zai:
 *   dipu (via developers)
 *   sam (via developers, reviewers)
 * ```
 *
 * When no candidates are available:
 * ```
 * No fallback candidates found for zai.
 * ```
 */
export function formatFallbackReport(
  failedAgent: string,
  recommendations: FallbackRecommendation[],
): string {
  if (recommendations.length === 0) {
    return `No fallback candidates found for ${failedAgent}.`;
  }
  const lines = [`Fallback candidates for ${failedAgent}:`];
  for (const rec of recommendations) {
    lines.push(`  ${rec.agent} (via ${rec.sourceGroups.join(", ")})`);
  }
  return lines.join("\n");
}
