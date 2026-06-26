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
    wroteAuthJson: boolean;
    wroteConfig: boolean;
}
export declare function runWizard(prompt: WizardPrompt, deps?: WizardDeps): Promise<WizardResult>;
