export interface SchedulerDryRunOptions {
    configPath?: string;
    deviceId?: string;
    staleAfterMs?: number;
    now?: Date;
}
/**
 * Execute a dry-run scheduler tick: load vault state, plan proposed claims,
 * and return a human-readable report. Does NOT execute any claims.
 */
export declare function schedulerDryRun(options: SchedulerDryRunOptions): Promise<string>;
