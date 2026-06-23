import { access, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { type BootstrapOptions, type LocalPirenConfig, resolveAgentDir } from "./bootstrap.js";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  agentName?: string;
  agentDir?: string;
  vaultRoot?: string;
  allowedAgents: string[];
  excludedAgents: string[];
  checks: DoctorCheck[];
}

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "piren", "config.yml");
const EXPECTED_PI_VERSION = "0.79.9";

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

async function detectVaultRoot(agentDir: string, config: LocalPirenConfig, cliVaultRoot?: string): Promise<string> {
  if (cliVaultRoot) return resolve(cliVaultRoot);
  if (config.vault_root) return resolve(config.vault_root);

  let current = resolve(agentDir);
  while (true) {
    if (await pathExists(join(current, ".piren-vault"))) return current;
    if ((await pathExists(join(current, "steward-directives.md"))) && (await pathExists(join(current, "team")))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(`Could not derive vault root from agent directory: ${agentDir}`);
}

function checkRunnablePolicy(agentName: string, allowedAgents: string[], excludedAgents: string[]): DoctorCheck {
  if (excludedAgents.includes(agentName)) {
    return { id: "runnable-agent-policy", status: "fail", message: `Agent '${agentName}' is excluded by local policy.` };
  }
  if (allowedAgents.length > 0 && !allowedAgents.includes(agentName)) {
    return { id: "runnable-agent-policy", status: "fail", message: `Agent '${agentName}' is not in allowed_agents.` };
  }
  if (allowedAgents.length === 0) {
    return { id: "runnable-agent-policy", status: "warn", message: "allowed_agents is not set. This installation can run any selected vault agent." };
  }
  const effective = allowedAgents.filter((agent) => !excludedAgents.includes(agent));
  return { id: "runnable-agent-policy", status: "ok", message: `Effective runnable agents: ${effective.join(", ") || "<none>"}.` };
}

async function checkRequiredPaths(id: string, root: string, required: string[]): Promise<DoctorCheck> {
  const missing: string[] = [];
  for (const path of required) {
    if (!(await pathExists(join(root, path)))) missing.push(path);
  }
  if (missing.length > 0) {
    return { id, status: "fail", message: `Missing required paths: ${missing.join(", ")}.` };
  }
  return { id, status: "ok", message: `Required paths present: ${required.join(", ")}.` };
}

function checkPolicyGap(allowedAgents: string[], vaultRoot?: string): DoctorCheck | null {
  if (allowedAgents.length === 0 && vaultRoot !== undefined) {
    return { id: "policy-gap", status: "warn", message: "allowed_agents is empty with vault_root configured. Any agent with a team/ directory can run on this installation." };
  }
  return null;
}

async function checkStaleAllowed(allowedAgents: string[], vaultRoot: string): Promise<DoctorCheck | null> {
  const teamDir = join(vaultRoot, "team");
  if (!(await pathExists(teamDir))) return null;
  const entries = await readdir(teamDir, { withFileTypes: true });
  const vaultAgentNames = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
  const stale = allowedAgents.filter((agent) => !vaultAgentNames.includes(agent));
  if (stale.length > 0) {
    return { id: "stale-allowed", status: "warn", message: `allowed_agents contains entries not found in vault team/: ${stale.join(", ")}.` };
  }
  return null;
}

function checkOverlappingPolicy(allowedAgents: string[], excludedAgents: string[]): DoctorCheck | null {
  const overlap = allowedAgents.filter((agent) => excludedAgents.includes(agent));
  if (overlap.length > 0) {
    return { id: "policy-overlap", status: "warn", message: `Agents appear in both allowed_agents and excluded_agents: ${overlap.join(", ")}. Excluded takes precedence.` };
  }
  return null;
}

function checkInvalidAgentNames(allowedAgents: string[]): DoctorCheck | null {
  const validPattern = /^[a-z][a-z0-9-]*$/;
  const invalid = allowedAgents.filter((agent) => !validPattern.test(agent));
  if (invalid.length > 0) {
    return { id: "invalid-agent-name", status: "warn", message: `allowed_agents contains names that do not match the required pattern (lowercase kebab-case): ${invalid.join(", ")}.` };
  }
  return null;
}

async function readProjectPackageJson(): Promise<{ dependencies?: Record<string, string> }> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "package.json"),
    join(moduleDir, "..", "package.json"),
    join(moduleDir, "..", "..", "package.json"),
  ];

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(await readFile(candidate, "utf8")) as { dependencies?: Record<string, string> };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function checkPiCompatibility(): Promise<DoctorCheck> {
  try {
    const packageJson = await readProjectPackageJson();
    const version = packageJson.dependencies?.["@earendil-works/pi-coding-agent"];
    if (version === EXPECTED_PI_VERSION) {
      return { id: "pi-compatibility", status: "ok", message: `@earendil-works/pi-coding-agent is pinned to ${EXPECTED_PI_VERSION}.` };
    }
    return { id: "pi-compatibility", status: "warn", message: `Expected @earendil-works/pi-coding-agent ${EXPECTED_PI_VERSION}, found ${version ?? "<not installed>"}.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id: "pi-compatibility", status: "warn", message: `Could not inspect package.json: ${message}` };
  }
}

export async function doctorPiren(options: BootstrapOptions = {}): Promise<DoctorReport> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const config = await readYamlConfig(configPath);
  const allowedAgents = normalizeStringArray(config.allowed_agents);
  const excludedAgents = normalizeStringArray(config.excluded_agents);
  const checks: DoctorCheck[] = [];

  const policyGap = checkPolicyGap(allowedAgents, config.vault_root === undefined ? undefined : resolve(config.vault_root));
  if (policyGap) checks.push(policyGap);

  const overlap = checkOverlappingPolicy(allowedAgents, excludedAgents);
  if (overlap) checks.push(overlap);

  const invalidNames = checkInvalidAgentNames(allowedAgents);
  if (invalidNames) checks.push(invalidNames);

  let agentDir: string;
  try {
    agentDir = await resolveAgentDir(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ id: "bootstrap", status: "fail", message });
    checks.push(await checkPiCompatibility());
    return { ok: false, allowedAgents, excludedAgents, checks };
  }

  const agentName = basename(agentDir);
  checks.push(checkRunnablePolicy(agentName, allowedAgents, excludedAgents));

  let vaultRoot: string | undefined;
  try {
    vaultRoot = await detectVaultRoot(agentDir, config, options.cliVaultRoot);
    checks.push(await checkRequiredPaths("vault-layout", vaultRoot, [".piren-vault", "steward-directives.md", "team"]));
    checks.push(await checkRequiredPaths("agent-files", agentDir, ["SOUL.md", "MEMORY.md", "config.yml", "inbox", "outbox", "logs", "sessions"]));
    const staleCheck = await checkStaleAllowed(allowedAgents, vaultRoot);
    if (staleCheck) checks.push(staleCheck);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ id: "vault-layout", status: "fail", message });
  }

  checks.push(await checkPiCompatibility());

  const report: DoctorReport = {
    ok: checks.every((check) => check.status !== "fail"),
    agentName,
    agentDir,
    allowedAgents,
    excludedAgents,
    checks,
  };
  if (vaultRoot !== undefined) report.vaultRoot = vaultRoot;
  return report;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ["Piren doctor"];
  if (report.agentName) lines.push(`agent_name: ${report.agentName}`);
  if (report.agentDir) lines.push(`agent_dir: ${report.agentDir}`);
  if (report.vaultRoot) lines.push(`vault_root: ${report.vaultRoot}`);
  lines.push(`allowed_agents: ${report.allowedAgents.length ? report.allowedAgents.join(", ") : "<not set>"}`);
  lines.push(`excluded_agents: ${report.excludedAgents.length ? report.excludedAgents.join(", ") : "<not set>"}`);
  lines.push("");
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.id}: ${check.message}`);
  }
  return lines.join("\n");
}
