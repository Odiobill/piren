import type { LocalPirenConfig } from "./bootstrap.js";
export interface SchedulerDryRunOptions {
    configPath?: string;
    deviceId?: string;
    staleAfterMs?: number;
    now?: Date;
}
declare const DEFAULT_CONFIG_PATH: string;
/**
 * Resolve the locally enabled agent set: allowed_agents minus excluded_agents.
 * Shared by dry-run and --once so both apply the same local policy before
 * planning (ADR-0029: local policy first).
 */
export declare function resolveEnabledAgents(config: LocalPirenConfig): string[];
export declare function pathExists(path: string): Promise<boolean>;
export declare function readYamlConfig(path: string): Promise<LocalPirenConfig>;
export { DEFAULT_CONFIG_PATH };
/**
 * Execute a dry-run scheduler tick: load vault state, plan proposed claims,
 * and return a human-readable report. Does NOT execute any claims.
 */
export declare function schedulerDryRun(options: SchedulerDryRunOptions): Promise<string>;
