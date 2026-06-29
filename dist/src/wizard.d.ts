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
import type { WizardPrompt } from "./prompt.js";
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
export declare const PI_PROVIDERS: readonly PiProviderInfo[];
export declare function formatProviderMenu(): string;
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
export declare const MODEL_CATALOG: Readonly<Record<string, readonly CatalogModel[]>>;
/**
 * Render the model menu for a provider. Numbered entries from the catalog,
 * followed by a custom/enter-manually option. For an unknown provider, only
 * the custom option is shown.
 */
export declare function formatModelMenu(providerId: string): string;
/**
 * Resolve a 0-based menu selection. Returns the catalog entry, or null when
 * the user picked the custom slot (the last entry) or an out-of-range index.
 */
export declare function resolveModelChoice(providerId: string, selection: number): {
    provider: string;
    id: string;
    name: string;
} | null;
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
export declare function buildAgentModelConfig(input: AgentModelConfigInput): AgentModelConfigOutput;
export interface AgentConfigInput {
    model?: AgentModelConfigOutput;
}
/**
 * Serialize the agent-local config.yml content (team/<agent>/config.yml). This
 * mirrors the shape `initVault` writes and what `setup --apply` scaffolds, so
 * the wizard can write the model selection here after the operator picks one.
 * The file is intentionally small: model preferences plus the polling defaults.
 */
export declare function buildAgentConfigYaml(input: AgentConfigInput): string;
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
export declare function mergeTransportConfigYaml(existingConfig: string, transport: TransportConfigInput): string;
/**
 * Detect whether a path is an existing Piren vault. Mirrors the bootstrap
 * detection heuristic: the `.piren-vault` marker, or `steward-directives.md`
 * alongside a `team/` directory.
 */
export declare function isExistingVault(path: string): Promise<boolean>;
export type AuthJsonCredential = {
    type: "api_key";
    key: string;
};
/**
 * Build a single-provider auth.json fragment keyed by provider id. This matches
 * Pi's on-disk shape: Record<providerId, {type, key}>.
 */
export declare function buildAuthJsonEntry(providerId: string, apiKey: string): Record<string, AuthJsonCredential>;
/**
 * Merge a new auth entry into an existing auth.json object and serialize to the
 * 2-space-indented JSON Pi expects. Existing providers are preserved.
 */
export declare function serializeAuthJson(existing: Record<string, AuthJsonCredential>, entry: Record<string, AuthJsonCredential>): string;
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
export declare function buildLocalConfigPatch(input: LocalConfigInput): string;
/**
 * Parse a comma-separated string into a trimmed, de-blanked array. Used by the
 * wizard when the operator enters multiple agents in one line.
 */
export declare function parseCommaList(input: string): string[];
export type PiCommandCheck = {
    ok: true;
    command: string;
    version?: string;
} | {
    ok: false;
    error?: string;
};
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
export declare function runWizard(prompt: WizardPrompt, deps?: WizardDeps): Promise<WizardResult>;
