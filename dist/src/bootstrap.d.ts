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
    default_agent?: string;
}
export interface DiscordLocalConfig {
    bot_token?: string;
    application_id?: string;
    install_url?: string;
    allowed_guild_ids?: Array<number | string>;
    allowed_channel_ids?: Array<number | string>;
    allowed_thread_ids?: Array<number | string>;
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
    provider?: string;
    model?: string;
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
