import { access, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { TransportFeedbackConfig } from "./transport-feedback.js";

export interface BootstrapOptions {
  cliAgentDir?: string | undefined;
  cliAgent?: string | undefined;
  cliVaultRoot?: string | undefined;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined;
  configPath?: string | undefined;
}

export interface TelegramLocalConfig {
  bot_token?: string;
  allowed_chat_ids?: Array<number | string>;
  feedback?: TransportFeedbackConfig;
  default_agent?: string;
}

export interface DiscordLocalConfig {
  bot_token?: string;
  application_id?: string;
  install_url?: string;
  allowed_guild_ids?: Array<number | string>;
  allowed_channel_ids?: Array<number | string>;
  allowed_thread_ids?: Array<number | string>;
  feedback?: TransportFeedbackConfig;
  default_agent?: string;
}

export interface LocalPirenConfig {
  agent_dir?: string;
  vault_root?: string;
  installation_id?: string;
  allowed_agents?: string[];
  excluded_agents?: string[];
  packages?: string[];
  telegram?: TelegramLocalConfig;
  discord?: DiscordLocalConfig;
  services?: ServicesLocalConfig;
  provider?: string;
  model?: string;
}

/**
 * Service lifecycle status stored in local config. Each transport may carry
 * `installed` (a service unit/script exists) and `running` (it is active now).
 * Both are optional; an empty object is treated as "not declared".
 */
export interface ServiceStatusEntry {
  installed?: boolean;
  running?: boolean;
}

export interface ServicesLocalConfig {
  transports?: Record<string, ServiceStatusEntry>;
}

export interface PirenContext {
  agentName: string;
  agentDir: string;
  vaultRoot: string;
  soul: string;
  stewardDirectives: string;
  config: LocalPirenConfig;
  allowedAgents: string[];
  excludedAgents: string[];
  packages: string[];
  paths: {
    stewardDirectives: string;
    soul: string;
    memory: string;
    config: string;
    inbox: string;
    outbox: string;
    logs: string;
    sessions: string;
  };
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

function assertValidAgentName(agentName: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(agentName)) {
    throw new Error("Invalid agent name. Use lowercase kebab-case, for example 'piren' or 'research-agent'.");
  }
}

function resolveRequestedAgent(options: BootstrapOptions, env: NodeJS.ProcessEnv | Record<string, string | undefined>, config: LocalPirenConfig): string | undefined {
  const explicit = options.cliAgent ?? env.PIREN_AGENT;
  if (explicit) {
    assertValidAgentName(explicit);
    return explicit;
  }

  const allowed = normalizeStringArray(config.allowed_agents);
  const excluded = normalizeStringArray(config.excluded_agents);
  const runnable = allowed.filter((agent) => !excluded.includes(agent));

  if (runnable.length === 1) return runnable[0];
  if (runnable.length > 1) {
    throw new Error("Multiple runnable agents configured. Pass --agent or set PIREN_AGENT.");
  }

  return undefined;
}

export async function resolveAgentDir(options: BootstrapOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const config = await readYamlConfig(configPath);
  const directCandidate = options.cliAgentDir ?? env.PIREN_AGENT_DIR ?? config.agent_dir;
  if (directCandidate) return resolve(directCandidate);

  const vaultRoot = options.cliVaultRoot ?? env.PIREN_VAULT_ROOT ?? config.vault_root;
  const agentName = resolveRequestedAgent(options, env, config);
  if (vaultRoot && agentName) return resolve(vaultRoot, "team", agentName);

  if (vaultRoot) {
    throw new Error("No Piren agent selected. Pass --agent, set PIREN_AGENT, or configure exactly one allowed_agents entry.");
  }

  throw new Error(`Missing Piren bootstrap config. Pass --agent-dir, set PIREN_AGENT_DIR, or configure vault_root in ${configPath}`);
}

async function detectVaultRoot(agentDir: string, config: LocalPirenConfig, cliVaultRoot?: string): Promise<string> {
  if (cliVaultRoot) return resolve(cliVaultRoot);
  if (config.vault_root) return resolve(config.vault_root);

  let current = resolve(agentDir);
  while (true) {
    if (await pathExists(join(current, ".piren-vault"))) return current;
    if ((await pathExists(join(current, "steward-directives.md"))) && (await pathExists(join(current, "team")))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(`Could not derive vault root from agent directory: ${agentDir}`);
}

function assertRunnable(agentName: string, config: LocalPirenConfig): void {
  const allowed = normalizeStringArray(config.allowed_agents);
  const excluded = normalizeStringArray(config.excluded_agents);

  if (excluded.includes(agentName)) {
    throw new Error(`Agent '${agentName}' is not allowed on this installation: excluded by policy`);
  }
  if (allowed.length > 0 && !allowed.includes(agentName)) {
    throw new Error(`Agent '${agentName}' is not allowed on this installation: not in allowed_agents`);
  }
}

export async function loadPirenContext(options: BootstrapOptions = {}): Promise<PirenContext> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const config = await readYamlConfig(configPath);
  const agentDir = await resolveAgentDir(options);
  const agentName = basename(agentDir);
  assertRunnable(agentName, config);

  const vaultRoot = await detectVaultRoot(agentDir, config, options.cliVaultRoot);
  const paths = {
    stewardDirectives: join(vaultRoot, "steward-directives.md"),
    soul: join(agentDir, "SOUL.md"),
    memory: join(agentDir, "MEMORY.md"),
    config: join(agentDir, "config.yml"),
    inbox: join(agentDir, "inbox"),
    outbox: join(agentDir, "outbox"),
    logs: join(agentDir, "logs"),
    sessions: join(agentDir, "sessions"),
  };

  await Promise.all([
    mkdir(paths.inbox, { recursive: true }),
    mkdir(paths.outbox, { recursive: true }),
    mkdir(paths.logs, { recursive: true }),
    mkdir(paths.sessions, { recursive: true }),
  ]);

  const [soul, stewardDirectives] = await Promise.all([
    readFile(paths.soul, "utf8"),
    readFile(paths.stewardDirectives, "utf8"),
  ]);

  return {
    agentName,
    agentDir,
    vaultRoot,
    soul,
    stewardDirectives,
    config,
    allowedAgents: normalizeStringArray(config.allowed_agents),
    excludedAgents: normalizeStringArray(config.excluded_agents),
    packages: normalizeStringArray(config.packages),
    paths,
  };
}
