import type { BootstrapOptions } from "./bootstrap.js";
import { type FallbackRecommendation } from "./agent-groups.js";
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
export declare function listPirenAgents(options?: BootstrapOptions): Promise<AgentsReport>;
export declare function formatAgentsReport(report: AgentsReport): string;
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
export declare function listFallbackCandidates(vaultRoot: string, agentName: string, options?: FallbackOptions): Promise<FallbackRecommendation[]>;
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
export declare function formatFallbackReport(failedAgent: string, recommendations: FallbackRecommendation[]): string;
