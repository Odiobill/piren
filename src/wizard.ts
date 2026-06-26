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

export interface WizardDeps {
  configPath?: string;
  piHome?: string;
  log?: (message: string) => void;
}

export interface WizardResult {
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

  log("Welcome to Piren setup. This wizard configures your vault, LLM provider, and local config.");
  log("");

  // --- Step 1: Vault ---
  const vaultAnswer = await prompt.text("Path to your Piren vault", process.cwd());
  const vaultRoot = resolve(vaultAnswer);

  let allowedAgents: string[] = [];
  let excludedAgents: string[] = [];
  let newVault = false;

  if (await isExistingVault(vaultRoot)) {
    newVault = false;
    log(`Found an existing vault at ${vaultRoot}.`);
    // Detect agents under team/.
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
      log("No agents found under team/. You can still proceed; configure allowed_agents manually.");
      const first = await prompt.text("Name the first agent for this vault", "piren");
      if (!AGENT_NAME_PATTERN.test(first)) {
        throw new Error("Invalid agent name. Use lowercase kebab-case, for example 'piren'.");
      }
      await initVault({ vaultRoot, agentName: first });
      allowedAgents = [first];
      excludedAgents = [];
    } else {
      log("Existing agents: " + vaultAgents.join(", "));
      const selected = await prompt.list("Which agents should this installation be allowed to run? (comma-separated)", vaultAgents.length === 1 ? vaultAgents : undefined);
      allowedAgents = selected.length > 0 ? selected : vaultAgents;
      const excluded = await prompt.list("Any agents to exclude on this installation? (comma-separated, or leave blank)", []);
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

  // --- Step 2: LLM provider + key + model ---
  let providerId: string | undefined;
  let modelId: string | undefined;
  let wroteAuthJson = false;
  let wroteAgentConfig = false;
  const setupLlm = await prompt.confirm("Configure a Pi LLM provider and API key now?", true);
  if (setupLlm) {
    log(formatProviderMenu());
    const idx = await prompt.select("Provider", PI_PROVIDERS.map((p) => `${p.name} (${p.id})`), 0);
    const provider = PI_PROVIDERS[idx] ?? PI_PROVIDERS[0]!;
    providerId = provider.id;
    const key = await prompt.secret(`Enter your ${provider.name} API key (${provider.envVar})`);
    if (key.trim() === "") {
      log("No key entered. Skipping auth.json write; you can set it later with Pi's login or an env var.");
    } else {
      const existing = await readAuthJson(piHome);
      const entry = buildAuthJsonEntry(provider.id, key.trim());
      const serialized = serializeAuthJson(existing, entry);
      await mkdir(piHome, { recursive: true });
      const authPath = join(piHome, "auth.json");
      await writeFile(authPath, serialized, "utf8");
      await chmod(authPath, 0o600);
      wroteAuthJson = true;
      log(`Wrote ${provider.name} key to ${authPath} (mode 0600).`);
    }

    log("");

    // Model selection: offer the curated catalog, then a custom/manual option.
    log(formatModelMenu(provider.id));
    const modelCount = (MODEL_CATALOG[provider.id] ?? []).length;
    const customIndex = modelCount; // the "enter manually" slot is 0-based == modelCount
    const modelIdx = await prompt.select("Model", Array.from({ length: modelCount + 1 }, (_, i) => {
      const m = MODEL_CATALOG[provider.id]?.[i];
      return m ? `${m.name} (${m.id})` : "Enter a model id manually (or skip)";
    }), 0);
    let chosenModelId: string | undefined;
    if (modelIdx === customIndex) {
      const manual = await prompt.text("Model id (e.g. claude-sonnet-4-6), or leave blank to skip", "");
      if (manual.trim() !== "") {
        chosenModelId = manual.trim();
      }
    } else {
      const resolved = resolveModelChoice(provider.id, modelIdx);
      if (resolved) chosenModelId = resolved.id;
    }

    if (chosenModelId) {
      const wantsThinking = await prompt.confirm("Set a thinking level? (off/minimal/low/medium/high/xhigh)", false);
      let thinking: string | undefined;
      if (wantsThinking) {
        thinking = (await prompt.text("Thinking level", "medium")).trim();
      }
      const modelConfig = buildAgentModelConfig({
        provider: provider.id,
        id: chosenModelId,
        ...(thinking !== undefined ? { thinking } : {}),
      });
      modelId = modelConfig.id;
      // Write the agent-local config.yml for the first agent.
      const agentConfigPath = join(vaultRoot, "team", allowedAgents[0] ?? "piren", "config.yml");
      const agentConfigContent = buildAgentConfigYaml({ model: modelConfig });
      await mkdir(dirname(agentConfigPath), { recursive: true });
      await writeFile(agentConfigPath, agentConfigContent, "utf8");
      wroteAgentConfig = true;
      log(`Wrote model selection to ${agentConfigPath}.`);
      log("");
      log("To add more providers or models later:");
      log(`  - Add another provider key: re-run \`piren setup\` (it merges without overwriting others).`);
      log(`  - See all models for a provider: \`pi --list-models <search>\``);
      log(`  - Edit the agent model anytime: edit ${agentConfigPath}`);
    }
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
  let configOnDisk = "";
  if (confirmWrite) {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, configContent, "utf8");
    wroteConfig = true;
    configOnDisk = configContent;
    log(`Wrote ${configPath}.`);
  } else {
    // If the file already exists, read it so the gateway merge can preserve it.
    try {
      configOnDisk = await readFile(configPath, "utf8");
    } catch {
      configOnDisk = "";
    }
    log("Skipped writing local config. Re-run piren setup when ready.");
  }

  log("");

  // --- Step 4: gateways (telegram / discord) ---
  const configuredTransports: string[] = [];
  const wantsGateway = await prompt.confirm("Configure a messaging gateway (Telegram or Discord)?", false);
  if (wantsGateway) {
    const which = await prompt.select("Gateway", ["Telegram", "Discord", "Both", "Skip"], 0);
    if (which === 0 || which === 2) {
      const token = (await prompt.secret("Telegram bot token (from @BotFather)")).trim();
      if (token !== "") {
        const chatIdsRaw = await prompt.text("Allowed Telegram chat IDs (comma-separated)", "");
        const chatIds = parseCommaList(chatIdsRaw)
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id !== 0);
        const merged = mergeTransportConfigYaml(configOnDisk, { telegram: { bot_token: token, allowed_chat_ids: chatIds } });
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, merged, "utf8");
        configOnDisk = merged;
        configuredTransports.push("telegram");
        log(`Wrote telegram block to ${configPath}.`);
      }
    }
    if (which === 1 || which === 2) {
      const token = (await prompt.secret("Discord bot token")).trim();
      if (token !== "") {
        const guildIds = parseCommaList(await prompt.text("Allowed Discord guild (server) IDs (comma-separated)", ""));
        const channelIds = parseCommaList(await prompt.text("Allowed Discord channel IDs (comma-separated)", ""));
        const merged = mergeTransportConfigYaml(configOnDisk, {
          discord: { bot_token: token, allowed_guild_ids: guildIds, allowed_channel_ids: channelIds },
        });
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, merged, "utf8");
        configOnDisk = merged;
        configuredTransports.push("discord");
        log(`Wrote discord block to ${configPath}.`);
      }
    }
    if (configuredTransports.length > 0) {
      log("Keep a gateway always-on with: piren service install <gateway|telegram|discord>");
    }
  }

  log("");
  log("Setup complete. Next steps:");
  log(`  piren doctor`);
  if (allowedAgents.length === 1) {
    log(`  piren --vault-root ${vaultRoot} --agent ${allowedAgents[0]!} run`);
  } else {
    log(`  piren --vault-root ${vaultRoot} --agent ${allowedAgents[0]!} run  (or pick from: ${allowedAgents.join(", ")})`);
  }

  const result: WizardResult = {
    vaultRoot,
    allowedAgents,
    excludedAgents,
    newVault,
    wroteAuthJson,
    wroteAgentConfig,
    wroteConfig,
    configuredTransports,
  };
  if (providerId !== undefined) result.providerId = providerId;
  if (modelId !== undefined) result.modelId = modelId;
  return result;
}
