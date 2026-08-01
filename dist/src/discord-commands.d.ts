/**
 * Native Discord application commands (ADR-0040 D3).
 *
 * Pure, directly testable core for the five native commands — /start,
 * /agents, /agent <name>, /whoami, /abort — covering:
 *
 * - the deterministic command manifest registered through Discord REST;
 * - narrow, non-destructive registration planning (per-command create/update;
 *   unrelated application commands are never deleted or overwritten);
 * - fail-closed parsing of INTERACTION_CREATE application-command payloads.
 *
 * No application id, bot token, or command manifest ever enters the vault;
 * registration config stays in ~/.config/piren/config.yml. The REST adapter
 * lives on DiscordBotApiHttpClient in discord-transport.ts.
 */
/** Discord application-command option type STRING. */
export declare const DISCORD_OPTION_TYPE_STRING = 3;
/** Discord application-command type CHAT_INPUT. */
export declare const DISCORD_COMMAND_TYPE_CHAT_INPUT = 1;
/** Discord interaction type APPLICATION_COMMAND. */
export declare const DISCORD_INTERACTION_TYPE_APPLICATION_COMMAND = 2;
/** Discord interaction callback type CHANNEL_MESSAGE_WITH_SOURCE. */
export declare const DISCORD_INTERACTION_CALLBACK_CHANNEL_MESSAGE = 4;
export interface DiscordCommandOption {
    name: string;
    description: string;
    type: number;
    required: boolean;
}
export interface DiscordCommandSpec {
    name: string;
    description: string;
    type: number;
    options?: DiscordCommandOption[];
}
/**
 * The deterministic manifest for precisely the five ADR-0040 commands. Order
 * is stable so registration planning and tests are deterministic.
 */
export declare const DISCORD_APPLICATION_COMMANDS: readonly DiscordCommandSpec[];
export interface RegisteredCommandRef {
    id: string;
    name: string;
}
export type CommandRegistrationAction = {
    kind: "create";
    spec: DiscordCommandSpec;
} | {
    kind: "update";
    commandId: string;
    spec: DiscordCommandSpec;
};
/**
 * Plan registration as narrow per-command create/update actions keyed by
 * command name. Existing commands whose names are not in the manifest are
 * never touched — there is deliberately no delete action and no bulk
 * overwrite, so unrelated application commands survive registration.
 */
export declare function planCommandRegistration(existing: RegisteredCommandRef[], desired: readonly DiscordCommandSpec[]): CommandRegistrationAction[];
export interface DiscordApplicationCommandApi {
    listApplicationCommands(applicationId: string): Promise<RegisteredCommandRef[]>;
    createApplicationCommand(applicationId: string, spec: DiscordCommandSpec): Promise<void>;
    updateApplicationCommand(applicationId: string, commandId: string, spec: DiscordCommandSpec): Promise<void>;
}
export interface CommandRegistrationResult {
    created: string[];
    updated: string[];
}
/**
 * Register the manifest against Discord's global application-commands
 * endpoints using narrow per-command create/update calls. Failures propagate
 * so the caller can degrade to the legacy text-command path with a
 * non-secret warning.
 */
export declare function registerApplicationCommands(api: DiscordApplicationCommandApi, applicationId: string): Promise<CommandRegistrationResult>;
/**
 * Register only when an application_id is configured. A missing/blank
 * application id returns null with NO registration call, preserving the
 * legacy text-only transport for installations without one.
 */
export declare function maybeRegisterApplicationCommands(api: DiscordApplicationCommandApi, applicationId: string | undefined): Promise<CommandRegistrationResult | null>;
export type DiscordCommandName = "start" | "agents" | "agent" | "whoami" | "abort";
export type InteractionCommandParse = {
    ok: true;
    command: DiscordCommandName;
    arg: string | undefined;
} | {
    ok: false;
};
/** Loose inbound interaction shape; narrowed by parseInteractionCommand. */
export interface DiscordInteractionPayload {
    id?: string;
    token?: string;
    type?: number;
    guild_id?: string;
    channel_id?: string;
    /** Unknown direct-shape marker: any presence on a non-guild payload fails closed. */
    thread_id?: unknown;
    data?: {
        name?: string;
        options?: Array<{
            name?: string;
            type?: number;
            value?: unknown;
        }>;
    };
    user?: {
        id?: string;
        bot?: boolean;
    };
    member?: {
        user?: {
            id?: string;
            bot?: boolean;
        };
    };
}
/**
 * Translate only the five defined application commands into command
 * semantics. Everything else — wrong interaction type, unknown names,
 * missing or malformed data/options containers, malformed /agent options —
 * fails closed without throwing, no matter how malformed the raw gateway
 * payload is. Arbitrary interaction data is never treated as a prompt.
 */
export declare function parseInteractionCommand(interaction: DiscordInteractionPayload): InteractionCommandParse;
