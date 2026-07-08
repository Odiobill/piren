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
/**
 * Local scheduler runtime configuration (ADR-0029 / O7 S5). Lives in
 * ~/.config/piren/config.yml under `scheduler:`. Controls the opt-in
 * `piren scheduler` loop only; never placed in the vault, agent SOUL.md,
 * Web UI, gateway state, or .env files.
 */
export interface SchedulerLocalConfig {
    /** Seconds between scheduler ticks. Default 30. */
    poll_interval_seconds?: number;
    /** Device heartbeat staleness threshold in seconds. Default 300. */
    stale_after_seconds?: number;
    /** Parsed max concurrency. Effective concurrency is 1 in S5 (one-at-a-time). */
    max_concurrent_agents?: number;
    /** Explicit device id override. Absent -> S4 sanitized-hostname fallback. */
    device_id?: string;
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
    scheduler?: SchedulerLocalConfig;
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
export declare function resolveAgentDir(options?: BootstrapOptions): Promise<string>;
export declare function loadPirenContext(options?: BootstrapOptions): Promise<PirenContext>;
