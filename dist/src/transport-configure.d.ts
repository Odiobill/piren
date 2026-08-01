/**
 * Guided local transport configuration (`piren telegram configure` /
 * `piren discord configure`, ADR-0040).
 *
 * An interactive, local-only onboarding flow for the messaging transports. It
 * operates exclusively on ~/.config/piren/config.yml: the bot token is
 * collected as secret input, platform IDs are validated with
 * platform-correct types (Telegram integer chat IDs, Discord snowflake
 * strings with distinct guild/channel/thread fields), feedback preferences
 * use platform-correct reaction defaults, and the default agent is chosen
 * only from the local runnable-agent set. A redacted preview (never token
 * contents) requires explicit confirmation before an atomic write, and the
 * resulting configuration is validated without launching a daemon,
 * installing/starting a service, or contacting either platform.
 *
 * Unrelated top-level keys and unprompted transport fields (for example
 * discord.application_id / install_url) are preserved on re-runs. Discord DM
 * authorization (allowed_dm_user_ids) is intentionally NOT collected in this
 * slice; it remains accepted deferred ADR-0040 work.
 *
 * The pure helpers are unit-tested directly; the runner takes an injected
 * WizardPrompt and TransportConfigureIo so tests drive it with fakes. The
 * production fs adapter performs an atomic temp-file + rename write.
 */
import type { WizardPrompt } from "./prompt.js";
import type { TransportFeedbackConfig } from "./transport-feedback.js";
export type ConfigureTransportKind = "telegram" | "discord";
/**
 * Redact a secret for display. The output contains NO characters from the
 * secret — only its length — so previews and logs can never leak token
 * contents.
 */
export declare function redactSecret(secret: string): string;
export type IdParseResult = {
    ok: true;
    ids: number[];
} | {
    ok: false;
    error: string;
};
export type SnowflakeParseResult = {
    ok: true;
    ids: string[];
} | {
    ok: false;
    error: string;
};
/**
 * Parse a comma-separated list of Telegram chat IDs. Chat IDs are integers;
 * group/supergroup IDs are negative. Empty entries, non-numeric values,
 * floats, and values beyond the safe-integer range are rejected.
 */
export declare function parseTelegramChatIds(input: string): IdParseResult;
/**
 * Parse a comma-separated list of Discord snowflake IDs. Snowflakes are
 * 15-22 digit strings and are stored as strings (they exceed the safe
 * integer range). The field key and noun make error messages distinguish
 * server (guild), channel, and thread IDs — and explicitly steer operators
 * away from the classic mistake of entering a user ID as a guild ID.
 * Optional lists accept blank input (keep/none) and the literal "none" as an
 * explicit clear.
 */
export declare function parseDiscordSnowflakes(input: string, field: string, noun: string, options?: {
    optional?: boolean;
}): SnowflakeParseResult;
export interface TelegramConfigBlock {
    bot_token: string;
    allowed_chat_ids: number[];
    feedback: TransportFeedbackConfig;
    default_agent: string;
}
export interface TelegramConfigureInput {
    botToken: string;
    chatIds: number[];
    feedback: TransportFeedbackConfig;
    defaultAgent: string;
}
export declare function buildTelegramConfigBlock(input: TelegramConfigureInput): TelegramConfigBlock;
export interface DiscordConfigBlock {
    bot_token: string;
    allowed_guild_ids: string[];
    allowed_channel_ids: string[];
    allowed_thread_ids?: string[];
    feedback: TransportFeedbackConfig;
    default_agent: string;
}
export interface DiscordConfigureInput {
    botToken: string;
    guildIds: string[];
    channelIds: string[];
    threadIds: string[];
    feedback: TransportFeedbackConfig;
    defaultAgent: string;
}
export declare function buildDiscordConfigBlock(input: DiscordConfigureInput): DiscordConfigBlock;
/**
 * Merge a managed transport block over an existing parsed block. Unprompted
 * fields survive; prompted fields are replaced. A managed value of
 * `undefined` is an explicit deletion marker (used to clear optional lists
 * such as allowed_thread_ids), never a YAML `null`.
 */
export declare function mergeTransportBlock(existingBlock: Record<string, unknown>, managedBlock: Record<string, unknown>): Record<string, unknown>;
/**
 * Deep-merge one managed transport block into an existing local config.yml
 * document. Unrelated top-level keys survive; unprompted fields inside the
 * transport block (application_id, install_url, unknown keys) survive;
 * prompted keys are replaced on a re-run. The whole document is
 * re-serialized, so the managed block never duplicates.
 */
export declare function mergeTransportIntoConfig(existingYaml: string, kind: ConfigureTransportKind, managedBlock: Record<string, unknown>): string;
/**
 * Render a YAML preview of a merged transport block with the token replaced
 * by a length-only redaction. The preview never contains token contents.
 */
export declare function renderRedactedPreview(kind: ConfigureTransportKind, mergedBlock: Record<string, unknown>): string;
export interface TransportConfigureIo {
    /**
     * Returns the config file content, or null ONLY when the file is absent
     * (ENOENT). Any other read failure (permissions, EISDIR, I/O) propagates
     * so the configure flow fails closed before prompting or writing.
     */
    readConfig(path: string): Promise<string | null>;
    /**
     * Atomically replace the config file (temp file + rename). The file holds
     * bot tokens, so the replacement is always owner-only: a fresh file is
     * created 0600, a weaker existing mode is strengthened to 0600, and an
     * existing owner-only (or stricter) mode is preserved.
     */
    writeConfigAtomic(path: string, content: string): Promise<void>;
}
/** Owner-only mode for the local config file, which contains bot tokens. */
export declare const LOCAL_CONFIG_FILE_MODE = 384;
/**
 * Resolve the mode a replacement config file must carry. Existing owner-only
 * (or stricter) modes — no group/other bits, no owner execute — are
 * preserved; anything weaker becomes 0600.
 */
export declare function resolveLocalConfigFileMode(existingMode: number | undefined): number;
export declare function createNodeTransportConfigureIo(): TransportConfigureIo;
export interface TransportConfigureDeps {
    configPath?: string;
    /** Local runnable-agent set (from listPirenAgents). Required; the default agent is chosen only from this set. */
    runnableAgents: string[];
    io?: TransportConfigureIo;
    log?: (message: string) => void;
}
export interface TransportConfigureResult {
    transport: ConfigureTransportKind;
    configPath: string;
    wrote: boolean;
    cancelled: boolean;
    validation?: {
        status: "ok" | "warn";
        message: string;
    };
}
export declare function runTransportConfigure(prompt: WizardPrompt, kind: ConfigureTransportKind, deps: TransportConfigureDeps): Promise<TransportConfigureResult>;
