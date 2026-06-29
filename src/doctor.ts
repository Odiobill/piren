import { execFile } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { defaultPiCommandResolver } from "./run.js";
import { type BootstrapOptions, type LocalPirenConfig, type TelegramLocalConfig, type DiscordLocalConfig, type ServicesLocalConfig, resolveAgentDir } from "./bootstrap.js";
import { resolvePackages, defaultPackageResolver, type PackageEntryResolver } from "./packages.js";
import { checkVaultConformance, createRealVaultDirReader, type VaultConformanceResult, type VaultDirReader } from "./okf.js";

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
  packages: string[];
  checks: DoctorCheck[];
}

export interface DoctorPirenOptions extends BootstrapOptions {
  packageResolver?: PackageEntryResolver | undefined;
  piRuntimeChecker?: PiRuntimeChecker | undefined;
  vaultDirReader?: VaultDirReader | undefined;
}

export interface PiRuntimeCheck {
  source: "path" | "unavailable";
  version?: string | undefined;
  error?: string | undefined;
}

export type PiRuntimeChecker = (env?: NodeJS.ProcessEnv | Record<string, string | undefined>) => Promise<PiRuntimeCheck>;

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

function checkPackages(packages: string[], resolver: PackageEntryResolver): DoctorCheck | null {
  if (packages.length === 0) return null;
  const { missing, resolved } = resolvePackages(packages, resolver);
  if (missing.length > 0) {
    return { id: "packages", status: "warn", message: `Declared packages not installed: ${missing.join(", ")}. Run npm install for these packages. Resolved ${resolved.length} of ${packages.length} declared.` };
  }
  return { id: "packages", status: "ok", message: `All ${packages.length} declared package(s) installed: ${packages.join(", ")}.` };
}

/**
 * Validate Telegram transport config for `piren doctor`.
 *
 * Returns null when no telegram config is declared at all, so a normal doctor
 * run never depends on Telegram being configured. When a telegram block is
 * present, it warns on a missing bot_token or empty allowed_chat_ids, and on a
 * default_agent that is not in the runnable set.
 */
export function checkTelegramConfig(
  config: TelegramLocalConfig | undefined,
  runnableAgents: string[] = [],
): DoctorCheck | null {
  if (config === undefined) return null;
  const hasBlock = "bot_token" in config || "allowed_chat_ids" in config || "default_agent" in config;
  if (!hasBlock) return null;

  const hasToken = typeof config.bot_token === "string" && config.bot_token.trim() !== "";
  const chatIds = Array.isArray(config.allowed_chat_ids) ? config.allowed_chat_ids : [];

  if (!hasToken) {
    return { id: "telegram", status: "warn", message: "telegram config is present but telegram.bot_token is missing or empty." };
  }
  if (chatIds.length === 0) {
    return { id: "telegram", status: "warn", message: "telegram.bot_token is set but telegram.allowed_chat_ids is empty. No chats are authorized." };
  }
  if (config.default_agent !== undefined && config.default_agent.trim() !== "") {
    if (runnableAgents.length > 0 && !runnableAgents.includes(config.default_agent)) {
      return { id: "telegram", status: "warn", message: `telegram.default_agent '${config.default_agent}' is not in the runnable agent set (${runnableAgents.join(", ")}).` };
    }
  }
  return { id: "telegram", status: "ok", message: `Telegram configured with ${chatIds.length} allowlisted chat(s).` };
}

/**
 * Validate Discord transport config for `piren doctor`.
 *
 * Returns null when no discord config is declared at all, so a normal doctor
 * run never depends on Discord being configured. When a discord block is
 * present, it warns on a missing bot_token, empty guild/channel allowlists, or
 * a default_agent outside the runnable set.
 */
export function checkDiscordConfig(
  config: DiscordLocalConfig | undefined,
  runnableAgents: string[] = [],
): DoctorCheck | null {
  if (config === undefined) return null;
  const hasBlock =
    "bot_token" in config ||
    "allowed_guild_ids" in config ||
    "allowed_channel_ids" in config ||
    "allowed_thread_ids" in config ||
    "default_agent" in config ||
    "application_id" in config ||
    "install_url" in config;
  if (!hasBlock) return null;

  const hasToken = typeof config.bot_token === "string" && config.bot_token.trim() !== "";
  const guildIds = Array.isArray(config.allowed_guild_ids) ? config.allowed_guild_ids : [];
  const channelIds = Array.isArray(config.allowed_channel_ids) ? config.allowed_channel_ids : [];

  if (!hasToken) {
    return { id: "discord", status: "warn", message: "discord config is present but discord.bot_token is missing or empty." };
  }
  if (guildIds.length === 0) {
    return { id: "discord", status: "warn", message: "discord.bot_token is set but discord.allowed_guild_ids is empty. No guilds are authorized." };
  }
  if (channelIds.length === 0) {
    return { id: "discord", status: "warn", message: "discord.bot_token is set but discord.allowed_channel_ids is empty. No channels are authorized." };
  }
  if (config.default_agent !== undefined && config.default_agent.trim() !== "") {
    if (runnableAgents.length > 0 && !runnableAgents.includes(config.default_agent)) {
      return { id: "discord", status: "warn", message: `discord.default_agent '${config.default_agent}' is not in the runnable agent set (${runnableAgents.join(", ")}).` };
    }
  }
  return { id: "discord", status: "ok", message: `Discord configured with ${guildIds.length} guild(s) and ${channelIds.length} channel(s) allowlisted.` };
}

/**
 * The shape of a `services.transports.<name>` block the wizard / service CLI
 * writes into local config after install. Mirrors ServicesLocalConfig but is
 * re-declared here so the pure check has no cross-module type dependency beyond
 * the config contract.
 */
export type ServiceConfig = ServicesLocalConfig;

/**
 * Validate the service lifecycle status for `piren doctor`.
 *
 * Returns null when no `services.transports` block is declared at all, so a
 * normal doctor run never depends on service management being configured. When
 * a transport entry is present, it warns if the transport is declared but not
 * installed, or installed but not running.
 */
export function checkServiceConfig(config: ServiceConfig | undefined): DoctorCheck | null {
  if (config === undefined) return null;
  const transports = config.transports;
  if (transports === undefined || transports === null) return null;

  const names = Object.keys(transports).filter((name) => {
    const entry = transports[name];
    return entry !== undefined && entry !== null && ("installed" in entry || "running" in entry);
  });
  if (names.length === 0) return null;

  const notInstalled: string[] = [];
  const notRunning: string[] = [];
  const okInstalled: string[] = [];
  for (const name of names) {
    const entry = transports[name]!;
    if (entry.installed !== true) {
      notInstalled.push(name);
    } else {
      if (entry.running === false) {
        notRunning.push(name);
      } else {
        okInstalled.push(name);
      }
    }
  }

  if (notInstalled.length > 0) {
    return {
      id: "services",
      status: "warn",
      message: `Declared transport(s) not installed as a service: ${notInstalled.join(", ")}. Run \`piren service install <transport>\`.`,
    };
  }
  if (notRunning.length > 0) {
    return {
      id: "services",
      status: "warn",
      message: `Installed transport(s) reported as not running: ${notRunning.join(", ")}. Run \`piren service start <transport>\`.`,
    };
  }
  return {
    id: "services",
    status: "ok",
    message: `All declared transport services installed and running: ${okInstalled.join(", ")}.`,
  };
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise(String(stdout || stderr).trim());
    });
  });
}

/**
 * Run OKF v0.1 conformance over the vault and return a `DoctorCheck`.
 *
 * OKF conformance is a WARNING, never a hard fail: a vault with entropy is not
 * broken, it is drifting from the specified format. The check summarizes how
 * many concept documents were checked and lists up to a handful of problem
 * paths so the steward can fix the worst offenders without an overwhelming dump.
 */
export async function checkVaultOkfConformance(
  vaultRoot: string,
  options: { vaultDirReader?: VaultDirReader; exclude?: string[] } = {},
): Promise<DoctorCheck> {
  const reader = options.vaultDirReader ?? createRealVaultDirReader();
  const conformanceOptions: { root: string; reader: VaultDirReader; exclude?: string[] } = {
    root: vaultRoot,
    reader,
  };
  if (options.exclude !== undefined) conformanceOptions.exclude = options.exclude;
  let result: VaultConformanceResult;
  try {
    result = await checkVaultConformance(conformanceOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id: "vault-okf-conformance", status: "warn", message: `OKF conformance check failed: ${message}` };
  }

  if (result.ok) {
    const truncatedNote = result.truncated ? ` (truncated at ${result.checked})` : "";
    return {
      id: "vault-okf-conformance",
      status: "ok",
      message: `Vault is OKF v0.1 conformant. Checked ${result.checked} concept document(s)${truncatedNote}.`,
    };
  }

  const shown = result.problems.slice(0, 5);
  const shownPaths = shown
    .map((p) => {
      const detail = p.detail !== undefined ? ` (${p.detail})` : "";
      return `${p.kind}: ${p.path}${detail}`;
    })
    .join("; ");
  const more = result.problems.length > shown.length ? `; +${result.problems.length - shown.length} more` : "";
  return {
    id: "vault-okf-conformance",
    status: "warn",
    message: `OKF conformance problems in ${result.problems.length} of ${result.checked} concept document(s): ${shownPaths}${more}. Run 'piren doctor' or the vault_conformance_check tool for the full list.`,
  };
}

export async function defaultPiRuntimeChecker(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Promise<PiRuntimeCheck> {
  try {
    const target = await defaultPiCommandResolver(env);
    const version = await execFileText(target.command, ["--version"]);
    return { source: "path", version };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { source: "unavailable", error: message };
  }
}

async function checkPiRuntime(checker: PiRuntimeChecker, env?: NodeJS.ProcessEnv | Record<string, string | undefined>): Promise<DoctorCheck> {
  const runtime = await checker(env);
  if (runtime.source === "path") {
    const versionText = runtime.version ? ` version ${runtime.version}` : "";
    return { id: "pi-runtime", status: "ok", message: `Pi binary found on PATH${versionText}.` };
  }
  return { id: "pi-runtime", status: "fail", message: `Pi is required but was not found or could not be verified. Install Pi with: curl -fsSL https://pi.dev/install.sh | sh. Details: ${runtime.error ?? "unknown error"}.` };
}

export async function doctorPiren(options: DoctorPirenOptions = {}): Promise<DoctorReport> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const config = await readYamlConfig(configPath);
  const allowedAgents = normalizeStringArray(config.allowed_agents);
  const excludedAgents = normalizeStringArray(config.excluded_agents);
  const packages = normalizeStringArray(config.packages);
  const resolver = options.packageResolver ?? defaultPackageResolver;
  const piRuntimeChecker = options.piRuntimeChecker ?? defaultPiRuntimeChecker;
  const checks: DoctorCheck[] = [];

  const policyGap = checkPolicyGap(allowedAgents, config.vault_root === undefined ? undefined : resolve(config.vault_root));
  if (policyGap) checks.push(policyGap);

  const overlap = checkOverlappingPolicy(allowedAgents, excludedAgents);
  if (overlap) checks.push(overlap);

  const invalidNames = checkInvalidAgentNames(allowedAgents);
  if (invalidNames) checks.push(invalidNames);

  const packagesCheck = checkPackages(packages, resolver);
  if (packagesCheck) checks.push(packagesCheck);

  const telegramCheck = checkTelegramConfig(config.telegram, allowedAgents);
  if (telegramCheck) checks.push(telegramCheck);

  const discordCheck = checkDiscordConfig(config.discord, allowedAgents);
  if (discordCheck) checks.push(discordCheck);

  const serviceCheck = checkServiceConfig(config.services);
  if (serviceCheck) checks.push(serviceCheck);

  let agentDir: string;
  try {
    agentDir = await resolveAgentDir(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ id: "bootstrap", status: "fail", message });
    checks.push(await checkPiRuntime(piRuntimeChecker, options.env));
    return { ok: false, allowedAgents, excludedAgents, packages, checks };
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
    const okfReaderOptions: { vaultDirReader?: VaultDirReader } = {};
    if (options.vaultDirReader !== undefined) okfReaderOptions.vaultDirReader = options.vaultDirReader;
    checks.push(await checkVaultOkfConformance(vaultRoot, okfReaderOptions));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ id: "vault-layout", status: "fail", message });
  }

  checks.push(await checkPiRuntime(piRuntimeChecker, options.env));

  const report: DoctorReport = {
    ok: checks.every((check) => check.status !== "fail"),
    agentName,
    agentDir,
    allowedAgents,
    excludedAgents,
    packages,
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
  lines.push(`packages: ${report.packages.length ? report.packages.join(", ") : "<not set>"}`);
  lines.push("");
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.id}: ${check.message}`);
  }
  return lines.join("\n");
}
