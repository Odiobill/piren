/**
 * Interactive setup wizard (pure helpers + runner).
 *
 * The wizard (`piren setup` with no flags) guides an operator through:
 *   1. Vault: existing (detect agents, enable/disable) or new (init + first agent).
 *   2. LLM: pick a Pi provider, enter the key, write ~/.pi/agent/auth.json at 0600.
 *   3. (Optional) gateways + service install.
 *
 * The pure helpers here are unit-tested directly (tests/wizard.test.ts). The
 * impure runner `runWizard(prompt, deps)` takes an injected WizardPrompt and fs
 * deps, so tests drive it with a fake prompter and a tmpdir. The real readline
 * implementation lives in src/prompt.ts.
 */

import { mkdir, readFile, writeFile, chmod, access, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { WizardPrompt } from "./prompt.js";
import { initVault } from "./init.js";
import { defaultPiCommandResolver } from "./run.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Known Pi providers with their api-key env var, reverse-engineered from the
 * pinned Pi source (packages/ai/src/providers/*.ts). The wizard uses this to
 * offer accurate env-var guidance and to write the auth.json entry keyed by the
 * Pi provider id.
 */
export interface PiProviderInfo {
  id: string;
  name: string;
  envVar: string;
  /** A default model id hint for the agent-local config.yml, Pi's `<provider>/<model>:<thinking>` form. */
  defaultModel?: string;
}

export const PI_PROVIDERS: readonly PiProviderInfo[] = [
  { id: "anthropic", name: "Anthropic (Claude)", envVar: "ANTHROPIC_API_KEY", defaultModel: "anthropic/claude-sonnet-4-20250514:medium" },
  { id: "openai", name: "OpenAI", envVar: "OPENAI_API_KEY" },
  { id: "google", name: "Google (Gemini)", envVar: "GEMINI_API_KEY" },
  { id: "deepseek", name: "DeepSeek", envVar: "DEEPSEEK_API_KEY" },
  { id: "groq", name: "Groq", envVar: "GROQ_API_KEY" },
  { id: "mistral", name: "Mistral", envVar: "MISTRAL_API_KEY" },
  { id: "xai", name: "xAI (Grok)", envVar: "XAI_API_KEY" },
  { id: "openrouter", name: "OpenRouter", envVar: "OPENROUTER_API_KEY" },
];

export function formatProviderMenu(): string {
  const lines: string[] = ["Choose a Pi provider:"];
  PI_PROVIDERS.forEach((provider, index) => {
    lines.push(`${index + 1}. ${provider.name} (${provider.id}) — key via ${provider.envVar}`);
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Model catalog + agent-local config serialization
// ---------------------------------------------------------------------------

export interface CatalogModel {
  id: string;
  name: string;
}

/**
 * Curated flagship models per provider, drawn from Pi's model registry
 * (packages/ai/src/providers/*.models.ts). Kept intentionally short: the
 * wizard offers a sensible default set, and points the user to
 * `pi --list-models` for the full live list after auth is configured. The
 * catalog is a static fallback so the wizard works without Pi installed.
 */
export const MODEL_CATALOG: Readonly<Record<string, readonly CatalogModel[]>> = {
  anthropic: [
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ],
  openai: [
    { id: "gpt-5.2", name: "GPT-5.2" },
    { id: "gpt-5.1", name: "GPT-5.1" },
    { id: "o4-mini", name: "o4-mini" },
  ],
  google: [
    { id: "gemini-3-pro-preview", name: "Gemini 3 Pro (preview)" },
    { id: "gemini-3-flash-preview", name: "Gemini 3 Flash (preview)" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  ],
  deepseek: [
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  ],
  groq: [
    { id: "openai/gpt-oss-20b", name: "GPT OSS 20B" },
    { id: "qwen/qwen3-32b", name: "Qwen3-32B" },
  ],
  mistral: [
    { id: "mistral-large-latest", name: "Mistral Large (latest)" },
    { id: "codestral-latest", name: "Codestral (latest)" },
  ],
  xai: [
    { id: "grok-4.3", name: "Grok 4.3" },
    { id: "grok-code-fast-1", name: "Grok Code Fast 1" },
  ],
};

/**
 * Render the model menu for a provider. Numbered entries from the catalog,
 * followed by a custom/enter-manually option. For an unknown provider, only
 * the custom option is shown.
 */
export function formatModelMenu(providerId: string): string {
  const models = MODEL_CATALOG[providerId] ?? [];
  const lines: string[] = [`Choose a model for ${providerId}:`];
  models.forEach((model, index) => {
    lines.push(`${index + 1}. ${model.name} (${model.id})`);
  });
  lines.push(`${models.length + 1}. Enter a model id manually (or skip)`);
  lines.push("");
  lines.push(`Tip: after setup, run \`pi --list-models\` to see the full live list for ${providerId}.`);
  return lines.join("\n");
}

/**
 * Resolve a 0-based menu selection. Returns the catalog entry, or null when
 * the user picked the custom slot (the last entry) or an out-of-range index.
 */
export function resolveModelChoice(providerId: string, selection: number): { provider: string; id: string; name: string } | null {
  const models = MODEL_CATALOG[providerId] ?? [];
  if (selection < 0 || selection >= models.length) return null;
  const model = models[selection]!;
  return { provider: providerId, id: model.id, name: model.name };
}

export interface AgentModelConfigInput {
  provider: string;
  id: string;
  thinking?: string;
}

export interface AgentModelConfigOutput {
  id: string;
  thinking?: string;
}

/**
 * Build the `model:` block for the agent-local config.yml (team/<agent>/config.yml).
 * The id is stored with the provider prefix unless it already has one, matching
 * what Piren's `normalizeModelId` in src/run.ts expects.
 */
export function buildAgentModelConfig(input: AgentModelConfigInput): AgentModelConfigOutput {
  const id = input.id.includes("/") ? input.id : `${input.provider}/${input.id}`;
  const result: AgentModelConfigOutput = { id };
  if (input.thinking !== undefined && input.thinking.trim() !== "") {
    result.thinking = input.thinking.trim();
  }
  return result;
}

export interface AgentConfigInput {
  model?: AgentModelConfigOutput;
}

/**
 * Serialize the agent-local config.yml content (team/<agent>/config.yml). This
 * mirrors the shape `initVault` writes and what `setup --apply` scaffolds, so
 * the wizard can write the model selection here after the operator picks one.
 * The file is intentionally small: model preferences plus the polling defaults.
 */
export function buildAgentConfigYaml(input: AgentConfigInput): string {
  const lines: string[] = [
    "# Agent-local Piren preferences.",
    "# Installation authority lives in ~/.config/piren/config.yml, not here.",
  ];
  if (input.model) {
    lines.push("model:");
    lines.push(`  id: ${input.model.id}`);
    if (input.model.thinking) {
      lines.push(`  thinking: ${input.model.thinking}`);
    }
  }
  lines.push("poll_interval_active_seconds: 60");
  lines.push("poll_interval_idle_seconds: 300");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Transport config merge (telegram/discord blocks into local config.yml)
// ---------------------------------------------------------------------------

export interface TransportConfigInput {
  telegram?: {
    bot_token: string;
    allowed_chat_ids: Array<number | string>;
    default_agent?: string;
  };
  discord?: {
    bot_token: string;
    allowed_guild_ids: Array<number | string>;
    allowed_channel_ids: Array<number | string>;
    allowed_thread_ids?: Array<number | string>;
    default_agent?: string;
  };
}

/**
 * Merge transport config blocks (telegram/discord) into an existing local
 * config.yml document. Re-serializes the whole document so unrelated keys are
 * preserved, and a re-run overwrites the previous transport values. This keeps
 * the wizard idempotent: running setup again to change a bot token replaces it
 * rather than duplicating the block.
 */
export function mergeTransportConfigYaml(existingConfig: string, transport: TransportConfigInput): string {
  const trimmed = existingConfig.trim();
  const parsed = trimmed === "" ? {} : (parseYaml(trimmed) as Record<string, unknown> | null) ?? {};
  const root = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  if (transport.telegram) {
    root.telegram = transport.telegram;
  }
  if (transport.discord) {
    root.discord = transport.discord;
  }
  return stringifyYaml(root);
}

/**
 * Detect whether a path is an existing Piren vault. Mirrors the bootstrap
 * detection heuristic: the `.piren-vault` marker, or `steward-directives.md`
 * alongside a `team/` directory.
 */
export async function isExistingVault(path: string): Promise<boolean> {
  try {
    await access(join(path, ".piren-vault"));
    return true;
  } catch {
    // fall through
  }
  try {
    await access(join(path, "steward-directives.md"));
    await access(join(path, "team"));
    return true;
  } catch {
    return false;
  }
}

export type AuthJsonCredential = { type: "api_key"; key: string };

/**
 * Build a single-provider auth.json fragment keyed by provider id. This matches
 * Pi's on-disk shape: Record<providerId, {type, key}>.
 */
export function buildAuthJsonEntry(providerId: string, apiKey: string): Record<string, AuthJsonCredential> {
  return { [providerId]: { type: "api_key", key: apiKey } };
}

/**
 * Merge a new auth entry into an existing auth.json object and serialize to the
 * 2-space-indented JSON Pi expects. Existing providers are preserved.
 */
export function serializeAuthJson(existing: Record<string, AuthJsonCredential>, entry: Record<string, AuthJsonCredential>): string {
  const merged: Record<string, AuthJsonCredential> = { ...existing };
  for (const [key, value] of Object.entries(entry)) {
    merged[key] = value;
  }
  return JSON.stringify(merged, null, 2) + "\n";
}

export interface LocalConfigInput {
  vaultRoot: string;
  allowedAgents: string[];
  excludedAgents: string[];
}

/**
 * Build the ~/.config/piren/config.yml content from wizard input. This is the
 * same shape `piren setup --apply` writes, extended to support multiple allowed
 * agents and an excluded list (useful when adopting an existing vault).
 */
export function buildLocalConfigPatch(input: LocalConfigInput): string {
  const lines: string[] = [
    "# Piren installation config — generated by piren setup wizard",
    `vault_root: ${input.vaultRoot}`,
    "",
    "allowed_agents:",
  ];
  for (const agent of input.allowedAgents) {
    lines.push(`  - ${agent}`);
  }
  if (input.excludedAgents.length > 0) {
    lines.push("");
    lines.push("excluded_agents:");
    for (const agent of input.excludedAgents) {
      lines.push(`  - ${agent}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Parse a comma-separated string into a trimmed, de-blanked array. Used by the
 * wizard when the operator enters multiple agents in one line.
 */
export function parseCommaList(input: string): string[] {
  return input
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

// ---------------------------------------------------------------------------
// Runner (impure; deps injected)
// ---------------------------------------------------------------------------

const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export type PiCommandCheck = { ok: true; command: string; version?: string } | { ok: false; error?: string };
export type PiCommandChecker = () => Promise<PiCommandCheck>;
export type WizardExitReason = "missing-pi" | "pi-not-configured";

export interface WizardDeps {
  configPath?: string;
  piHome?: string;
  piCommandChecker?: PiCommandChecker;
  log?: (message: string) => void;
}

export interface WizardResult {
  completed: boolean;
  exitReason?: WizardExitReason;
  vaultRoot: string;
  allowedAgents: string[];
  excludedAgents: string[];
  newVault: boolean;
  providerId?: string;
  modelId?: string;
  wroteAuthJson: boolean;
  wroteAgentConfig: boolean;
  wroteConfig: boolean;
  configuredTransports: string[];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultPiCommandChecker(): Promise<PiCommandCheck> {
  try {
    const target = await defaultPiCommandResolver(process.env);
    return { ok: true, command: target.command };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function hasConfiguredPiAuth(auth: Record<string, AuthJsonCredential>): boolean {
  return Object.keys(auth).length > 0;
}

function earlyExitResult(reason: WizardExitReason): WizardResult {
  return {
    completed: false,
    exitReason: reason,
    vaultRoot: "",
    allowedAgents: [],
    excludedAgents: [],
    newVault: false,
    wroteAuthJson: false,
    wroteAgentConfig: false,
    wroteConfig: false,
    configuredTransports: [],
  };
}

/**
 * Read an existing local config.yml and extract the values the wizard wants to
 * remember across runs (vault_root, allowed_agents, excluded_agents). Returns
 * empty arrays and an undefined root when the file is missing or unparseable,
 * so the wizard falls back to CWD / empty defaults on a first run. This is the
 * "value memory" behind frictionless re-runs: the operator does not have to
 * re-enter the vault path or re-pick agents every time they add a provider.
 */
export interface PriorLocalConfig {
  vaultRoot?: string;
  allowedAgents: string[];
  excludedAgents: string[];
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

async function readExistingLocalConfig(configPath: string): Promise<PriorLocalConfig> {
  try {
    if (!(await pathExists(configPath))) {
      return { allowedAgents: [], excludedAgents: [] };
    }
    const content = await readFile(configPath, "utf8");
    const parsed = parseYaml(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { allowedAgents: [], excludedAgents: [] };
    }
    const root = parsed as Record<string, unknown>;
    const vaultRoot = typeof root.vault_root === "string" && root.vault_root.trim() !== "" ? root.vault_root : undefined;
    // Build with required fields first, then add the optional field only when
    // defined (exactOptionalPropertyTypes forbids explicit undefined).
    const result: PriorLocalConfig = {
      allowedAgents: normalizeStringArray(root.allowed_agents),
      excludedAgents: normalizeStringArray(root.excluded_agents),
    };
    if (vaultRoot !== undefined) result.vaultRoot = vaultRoot;
    return result;
  } catch {
    return { allowedAgents: [], excludedAgents: [] };
  }
}

/**
 * Intersect a prior agent list with the agents that currently exist in the
 * vault, preserving the prior order. Used so a remembered "allowed" list never
 * silently re-enables an agent that has since been deleted from the vault.
 */
function filterToVaultAgents(prior: string[], vaultAgents: string[]): string[] {
  const vaultSet = new Set(vaultAgents);
  return prior.filter((agent) => vaultSet.has(agent));
}

async function readAuthJson(piHome: string): Promise<Record<string, AuthJsonCredential>> {
  const authPath = join(piHome, "auth.json");
  if (!(await pathExists(authPath))) return {};
  try {
    const content = await readFile(authPath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, AuthJsonCredential>;
    }
    return {};
  } catch {
    return {};
  }
}

export async function runWizard(prompt: WizardPrompt, deps: WizardDeps = {}): Promise<WizardResult> {
  const log = deps.log ?? ((message: string) => console.log(message));
  const configPath = deps.configPath ?? join(homedir(), ".config", "piren", "config.yml");
  const piHome = deps.piHome ?? join(homedir(), ".pi", "agent");
  const piCommandChecker = deps.piCommandChecker ?? defaultPiCommandChecker;

  log("Welcome to Piren setup. This first-run flow creates a vault and local agent after Pi is installed and configured.");
  log("");

  log("Step 1: Checking Pi Coding Agent...");
  const piCheck = await piCommandChecker();
  if (!piCheck.ok) {
    log("  pi: not found");
    if (piCheck.error) log(`  details: ${piCheck.error}`);
    log("");
    log("Piren requires Pi Coding Agent on PATH.");
    log("Install it with:");
    log("");
    log("  curl -fsSL https://pi.dev/install.sh | sh");
    log("");
    log("Then restart your shell and run:");
    log("");
    log("  piren setup");
    log("");
    log("No Piren files were changed.");
    return earlyExitResult("missing-pi");
  }
  log(`  pi: ${piCheck.command}${piCheck.version ? ` ${piCheck.version}` : ""}`);

  const piAuth = await readAuthJson(piHome);
  if (!hasConfiguredPiAuth(piAuth)) {
    log("  model/auth: not configured");
    log("");
    log("Before Piren can launch agents, configure Pi itself:");
    log("");
    log("  pi");
    log("");
    log("Use Pi's login/model setup flow, then run:");
    log("");
    log("  piren setup");
    log("");
    log("No Piren vault was created yet.");
    return earlyExitResult("pi-not-configured");
  }
  log(`  model/auth: found ${Object.keys(piAuth).length} provider credential(s) in ${join(piHome, "auth.json")}`);
  log("");

  // Value memory: read any existing config.yml so re-running setup offers
  // the previously entered vault path and previously allowed agents as defaults.
  const priorConfig = await readExistingLocalConfig(configPath);
  const priorVaultRoot = priorConfig.vaultRoot;
  const priorAllowedAgents = priorConfig.allowedAgents;
  const priorExcludedAgents = priorConfig.excludedAgents;

  // --- Step 2: Vault + first/local agents ---
  const vaultDefault = priorVaultRoot ?? join(homedir(), "Piren");
  const vaultAnswer = await prompt.text("Path to your Piren vault", vaultDefault);
  const vaultRoot = resolve(vaultAnswer);

  let allowedAgents: string[] = [];
  let excludedAgents: string[] = [];
  let newVault = false;

  if (await isExistingVault(vaultRoot)) {
    newVault = false;
    log(`Found an existing vault at ${vaultRoot}.`);
    const teamDir = join(vaultRoot, "team");
    let vaultAgents: string[] = [];
    if (await pathExists(teamDir)) {
      const entries = await readdir(teamDir, { withFileTypes: true });
      vaultAgents = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    }
    if (vaultAgents.length === 0) {
      log("No agents found under team/. A first agent will be created.");
      const first = await prompt.text("Name the first agent for this vault", "piren");
      if (!AGENT_NAME_PATTERN.test(first)) {
        throw new Error("Invalid agent name. Use lowercase kebab-case, for example 'piren'.");
      }
      await initVault({ vaultRoot, agentName: first });
      allowedAgents = [first];
      excludedAgents = [];
    } else {
      log("Existing agents: " + vaultAgents.join(", "));
      const defaultAllowed = filterToVaultAgents(priorAllowedAgents, vaultAgents);
      const selected = await prompt.list(
        "Which agents should this installation be allowed to run? (comma-separated)",
        defaultAllowed.length > 0 ? defaultAllowed : [vaultAgents[0]!],
      );
      allowedAgents = selected.length > 0 ? selected : (defaultAllowed.length > 0 ? defaultAllowed : [vaultAgents[0]!]);
      const excluded = await prompt.list(
        "Any agents to exclude on this installation? (comma-separated, or leave blank)",
        filterToVaultAgents(priorExcludedAgents, vaultAgents),
      );
      excludedAgents = excluded;
    }
  } else {
    newVault = true;
    log(`${vaultRoot} is not an existing vault. A new vault will be initialized there.`);
    const firstAgent = await prompt.text("Name the first agent", "piren");
    if (!AGENT_NAME_PATTERN.test(firstAgent)) {
      throw new Error("Invalid agent name. Use lowercase kebab-case, for example 'piren'.");
    }
    await initVault({ vaultRoot, agentName: firstAgent });
    log(`Initialized vault at ${vaultRoot} with agent '${firstAgent}'.`);
    allowedAgents = [firstAgent];
    excludedAgents = [];
  }

  log("");

  // --- Step 3: write local config ---
  const configContent = buildLocalConfigPatch({ vaultRoot, allowedAgents, excludedAgents });
  log("The following will be written to " + configPath + ":");
  log(configContent
    .split("\n")
    .map((line) => "  " + line)
    .join("\n"));
  const confirmWrite = await prompt.confirm("Write this configuration?", true);
  let wroteConfig = false;
  if (confirmWrite) {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, configContent, "utf8");
    wroteConfig = true;
    log(`Wrote ${configPath}.`);
  } else {
    log("Skipped writing local config. Re-run piren setup when ready.");
  }

  log("");
  log("Setup complete. Next steps:");
  log("  piren status");
  log("  piren run");
  log("");
  log("Optional always-on services:");
  log("  piren service install gateway");
  log("  piren service install telegram");
  log("  piren service install discord");

  const result: WizardResult = {
    completed: true,
    vaultRoot,
    allowedAgents,
    excludedAgents,
    newVault,
    wroteAuthJson: false,
    wroteAgentConfig: false,
    wroteConfig,
    configuredTransports: [],
  };
  return result;
}
