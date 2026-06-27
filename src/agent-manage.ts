/**
 * Agent identity + permission management (`piren agent` command).
 *
 * Piren splits agent identity (vault `team/<agent>/` dirs) from runtime
 * permission (local `allowed_agents` in ~/.config/piren/config.yml). This
 * module manages BOTH sides together so the operator never has to hand-edit
 * two places to add, remove, or clone an agent.
 *
 * Pure core + injected deps, mirroring the service-lifecycle pattern. The
 * pure `plan*` functions describe what would happen; the `execute*` functions
 * take injected filesystem deps so tests drive them against a tmpdir.
 *
 * Design decisions (confirmed with the steward):
 *   - add: scaffold team/<name>/ AND add to allowed_agents.
 *   - remove: ALWAYS drop from allowed_agents; the vault dir is deleted only
 *     after an explicit confirm at the CLI layer.
 *   - clone: copy the source team dir verbatim (identity files carry over) and
 *     permit the new name.
 *   - Config edits preserve all unrelated keys (discord, telegram, vault_root)
 *     by parse -> mutate -> stringify, exactly like updateServiceStatusYaml.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { join } from "node:path";

export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export type AgentSubcommand = "add" | "remove" | "clone" | "list";

export interface AgentNameValidation {
  ok: boolean;
  message?: string;
}

export function validateAgentName(name: string): AgentNameValidation {
  if (name === "") return { ok: false, message: "Agent name is required." };
  if (!AGENT_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      message: "Invalid agent name. Use lowercase kebab-case, for example 'piren' or 'research-agent'.",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Pure list editing
// ---------------------------------------------------------------------------

export function addAllowedAgent(existing: string[], agent: string): string[] {
  if (existing.includes(agent)) return [...existing];
  return [...existing, agent];
}

export function removeAllowedAgent(existing: string[], agent: string): string[] {
  return existing.filter((entry) => entry !== agent);
}

export function agentDirPath(vaultRoot: string, agentName: string): string {
  return join(vaultRoot, "team", agentName);
}

// ---------------------------------------------------------------------------
// Config read/write (preserves unrelated keys)
// ---------------------------------------------------------------------------

function readConfigObject(existingConfig: string): Record<string, unknown> {
  const trimmed = existingConfig.trim();
  if (trimmed === "") return {};
  const parsed = parseYaml(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

/**
 * Rewrite config.yml content with an updated allowed_agents list. Unrelated
 * keys (vault_root, discord, telegram, packages, ...) are preserved verbatim
 * by re-serializing the parsed document.
 */
export function updateAllowedAgentsInConfig(existingConfig: string, nextAllowed: string[]): string {
  const root = readConfigObject(existingConfig);
  if (nextAllowed.length > 0) {
    root.allowed_agents = nextAllowed;
  } else {
    delete root.allowed_agents;
  }
  return stringifyYaml(root);
}

function allowedAgentsFromConfig(existingConfig: string): string[] {
  const root = readConfigObject(existingConfig);
  return normalizeStringArray(root.allowed_agents);
}

// ---------------------------------------------------------------------------
// Plans (pure descriptions of intent)
// ---------------------------------------------------------------------------

export interface AddAgentPlan {
  shouldScaffold: boolean;
  shouldUpdateConfig: boolean;
  updatedConfig: string;
  dirPath: string;
  error?: string;
}

export interface AddAgentPlanOptions {
  vaultRoot: string;
  agentName: string;
  existingConfig: string;
  force: boolean;
}

export function planAddAgent(opts: AddAgentPlanOptions): AddAgentPlan {
  const dirPath = agentDirPath(opts.vaultRoot, opts.agentName);
  const currentAllowed = allowedAgentsFromConfig(opts.existingConfig);
  // `force` allows re-scaffolding an existing dir; the planner cannot stat the
  // filesystem (it is pure), so the executor enforces the existence check and
  // the planner reports intent. But for the "already in allowed_agents" case we
  // can short-circuit from config alone: no config write needed.
  const alreadyAllowed = currentAllowed.includes(opts.agentName);
  const nextConfig = alreadyAllowed ? opts.existingConfig : updateAllowedAgentsInConfig(opts.existingConfig, addAllowedAgent(currentAllowed, opts.agentName));
  return {
    shouldScaffold: true,
    shouldUpdateConfig: !alreadyAllowed,
    updatedConfig: nextConfig,
    dirPath,
  };
}

export interface RemoveAgentPlan {
  shouldRemoveDir: boolean;
  shouldUpdateConfig: boolean;
  updatedConfig: string;
  dirPath: string;
}

export interface RemoveAgentPlanOptions {
  vaultRoot: string;
  agentName: string;
  existingConfig: string;
}

export function planRemoveAgent(opts: RemoveAgentPlanOptions): RemoveAgentPlan {
  const dirPath = agentDirPath(opts.vaultRoot, opts.agentName);
  const currentAllowed = allowedAgentsFromConfig(opts.existingConfig);
  const nextConfig = updateAllowedAgentsInConfig(opts.existingConfig, removeAllowedAgent(currentAllowed, opts.agentName));
  return {
    // The dir may or may not exist; the executor checks. The plan assumes
    // intent to remove; shouldRemoveDir reflects whether the dir is present.
    shouldRemoveDir: true,
    shouldUpdateConfig: currentAllowed.includes(opts.agentName),
    updatedConfig: nextConfig,
    dirPath,
  };
}

export interface CloneAgentPlan {
  shouldCopy: boolean;
  shouldUpdateConfig: boolean;
  updatedConfig: string;
  sourceDir: string;
  targetDir: string;
  error?: string;
}

export interface CloneAgentPlanOptions {
  vaultRoot: string;
  sourceAgent: string;
  targetAgent: string;
  existingConfig: string;
}

export function planCloneAgent(opts: CloneAgentPlanOptions): CloneAgentPlan {
  const sourceDir = agentDirPath(opts.vaultRoot, opts.sourceAgent);
  const targetDir = agentDirPath(opts.vaultRoot, opts.targetAgent);
  const currentAllowed = allowedAgentsFromConfig(opts.existingConfig);
  const alreadyAllowed = currentAllowed.includes(opts.targetAgent);
  const nextConfig = alreadyAllowed ? opts.existingConfig : updateAllowedAgentsInConfig(opts.existingConfig, addAllowedAgent(currentAllowed, opts.targetAgent));
  return {
    shouldCopy: true,
    shouldUpdateConfig: !alreadyAllowed,
    updatedConfig: nextConfig,
    sourceDir,
    targetDir,
  };
}

// ---------------------------------------------------------------------------
// Execution (injected deps)
// ---------------------------------------------------------------------------

export interface AgentManageDeps {
  exists: (path: string) => Promise<boolean>;
  scaffoldAgentDir: (vaultRoot: string, agentName: string) => Promise<string>;
  copyDir: (source: string, target: string) => Promise<void>;
  removeDir: (path: string) => Promise<void>;
  log: (message: string) => void;
}

export interface AddAgentResult {
  agentName: string;
  scaffoldedDir: string;
  updatedConfig: string;
  configUpdated: boolean;
  error?: string;
}

export interface AddAgentExecOptions {
  vaultRoot: string;
  agentName: string;
  existingConfig: string;
  force: boolean;
  deps: AgentManageDeps;
}

export async function executeAddAgent(opts: AddAgentExecOptions): Promise<AddAgentResult> {
  const dirPath = agentDirPath(opts.vaultRoot, opts.agentName);
  if (!opts.force && (await opts.deps.exists(dirPath))) {
    return {
      agentName: opts.agentName,
      scaffoldedDir: dirPath,
      updatedConfig: opts.existingConfig,
      configUpdated: false,
      error: `Agent directory already exists: ${dirPath}. Re-run with --force to overwrite.`,
    };
  }
  await opts.deps.scaffoldAgentDir(opts.vaultRoot, opts.agentName);
  const plan = planAddAgent(opts);
  return {
    agentName: opts.agentName,
    scaffoldedDir: dirPath,
    updatedConfig: plan.updatedConfig,
    configUpdated: plan.shouldUpdateConfig,
  };
}

export interface CloneAgentResult {
  sourceAgent: string;
  targetAgent: string;
  targetDir: string;
  updatedConfig: string;
  configUpdated: boolean;
  error?: string;
}

export interface CloneAgentExecOptions {
  vaultRoot: string;
  sourceAgent: string;
  targetAgent: string;
  existingConfig: string;
  deps: AgentManageDeps;
}

export async function executeCloneAgent(opts: CloneAgentExecOptions): Promise<CloneAgentResult> {
  const sourceDir = agentDirPath(opts.vaultRoot, opts.sourceAgent);
  const targetDir = agentDirPath(opts.vaultRoot, opts.targetAgent);
  if (!(await opts.deps.exists(sourceDir))) {
    return {
      sourceAgent: opts.sourceAgent,
      targetAgent: opts.targetAgent,
      targetDir,
      updatedConfig: opts.existingConfig,
      configUpdated: false,
      error: `Source agent does not exist: ${sourceDir}.`,
    };
  }
  if (await opts.deps.exists(targetDir)) {
    return {
      sourceAgent: opts.sourceAgent,
      targetAgent: opts.targetAgent,
      targetDir,
      updatedConfig: opts.existingConfig,
      configUpdated: false,
      error: `Target agent already exists: ${targetDir}. Remove it first or pick another name.`,
    };
  }
  await opts.deps.copyDir(sourceDir, targetDir);
  const plan = planCloneAgent(opts);
  return {
    sourceAgent: opts.sourceAgent,
    targetAgent: opts.targetAgent,
    targetDir,
    updatedConfig: plan.updatedConfig,
    configUpdated: plan.shouldUpdateConfig,
  };
}

export interface RemoveAgentResult {
  agentName: string;
  dirPath: string;
  dirRemoved: boolean;
  updatedConfig: string;
  configUpdated: boolean;
  error?: string;
}

export interface RemoveAgentExecOptions {
  vaultRoot: string;
  agentName: string;
  existingConfig: string;
  /** Whether the operator confirmed deleting the vault directory. */
  confirmedDeleteDir: boolean;
  deps: AgentManageDeps;
}

export async function executeRemoveAgent(opts: RemoveAgentExecOptions): Promise<RemoveAgentResult> {
  const dirPath = agentDirPath(opts.vaultRoot, opts.agentName);
  let dirRemoved = false;
  const dirExists = await opts.deps.exists(dirPath);
  if (dirExists && opts.confirmedDeleteDir) {
    await opts.deps.removeDir(dirPath);
    dirRemoved = true;
  } else if (dirExists && !opts.confirmedDeleteDir) {
    // Permission is ALWAYS dropped; the dir is left in place without confirm.
    // The CLI surfaces a clear message about the skipped deletion.
  }
  const plan = planRemoveAgent(opts);
  return {
    agentName: opts.agentName,
    dirPath,
    dirRemoved,
    updatedConfig: plan.updatedConfig,
    configUpdated: plan.shouldUpdateConfig,
    ...(dirExists && !opts.confirmedDeleteDir
      ? { error: `Vault directory left in place (not confirmed): ${dirPath}. Re-run and confirm to delete it.` }
      : {}),
  };
}
