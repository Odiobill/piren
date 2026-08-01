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
// ---------------------------------------------------------------------------
// Command manifest
// ---------------------------------------------------------------------------
/** Discord application-command option type STRING. */
export const DISCORD_OPTION_TYPE_STRING = 3;
/** Discord application-command type CHAT_INPUT. */
export const DISCORD_COMMAND_TYPE_CHAT_INPUT = 1;
/** Discord interaction type APPLICATION_COMMAND. */
export const DISCORD_INTERACTION_TYPE_APPLICATION_COMMAND = 2;
/** Discord interaction callback type CHANNEL_MESSAGE_WITH_SOURCE. */
export const DISCORD_INTERACTION_CALLBACK_CHANNEL_MESSAGE = 4;
/**
 * The deterministic manifest for precisely the five ADR-0040 commands. Order
 * is stable so registration planning and tests are deterministic.
 */
export const DISCORD_APPLICATION_COMMANDS = [
    { name: "start", description: "Readiness and help", type: DISCORD_COMMAND_TYPE_CHAT_INPUT },
    { name: "agents", description: "List runnable Piren agents and the active agent", type: DISCORD_COMMAND_TYPE_CHAT_INPUT },
    {
        name: "agent",
        description: "Switch the active Piren agent for this conversation",
        type: DISCORD_COMMAND_TYPE_CHAT_INPUT,
        options: [
            {
                name: "name",
                description: "Piren agent name",
                type: DISCORD_OPTION_TYPE_STRING,
                required: true,
            },
        ],
    },
    { name: "whoami", description: "Show the active Piren agent", type: DISCORD_COMMAND_TYPE_CHAT_INPUT },
    { name: "abort", description: "Abort the active Piren turn for this conversation", type: DISCORD_COMMAND_TYPE_CHAT_INPUT },
];
/**
 * Plan registration as narrow per-command create/update actions keyed by
 * command name. Existing commands whose names are not in the manifest are
 * never touched — there is deliberately no delete action and no bulk
 * overwrite, so unrelated application commands survive registration.
 */
export function planCommandRegistration(existing, desired) {
    const existingIdsByName = new Map(existing.map((command) => [command.name, command.id]));
    return desired.map((spec) => {
        const existingId = existingIdsByName.get(spec.name);
        if (existingId !== undefined) {
            return { kind: "update", commandId: existingId, spec };
        }
        return { kind: "create", spec };
    });
}
/**
 * Register the manifest against Discord's global application-commands
 * endpoints using narrow per-command create/update calls. Failures propagate
 * so the caller can degrade to the legacy text-command path with a
 * non-secret warning.
 */
export async function registerApplicationCommands(api, applicationId) {
    const existing = await api.listApplicationCommands(applicationId);
    const actions = planCommandRegistration(existing, DISCORD_APPLICATION_COMMANDS);
    const created = [];
    const updated = [];
    for (const action of actions) {
        if (action.kind === "create") {
            await api.createApplicationCommand(applicationId, action.spec);
            created.push(action.spec.name);
        }
        else {
            await api.updateApplicationCommand(applicationId, action.commandId, action.spec);
            updated.push(action.spec.name);
        }
    }
    return { created, updated };
}
/**
 * Register only when an application_id is configured. A missing/blank
 * application id returns null with NO registration call, preserving the
 * legacy text-only transport for installations without one.
 */
export async function maybeRegisterApplicationCommands(api, applicationId) {
    if (applicationId === undefined || applicationId.trim() === "")
        return null;
    return registerApplicationCommands(api, applicationId.trim());
}
const KNOWN_COMMANDS = ["start", "agents", "agent", "whoami", "abort"];
function isPlainRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
/**
 * Translate only the five defined application commands into command
 * semantics. Everything else — wrong interaction type, unknown names,
 * missing or malformed data/options containers, malformed /agent options —
 * fails closed without throwing, no matter how malformed the raw gateway
 * payload is. Arbitrary interaction data is never treated as a prompt.
 */
export function parseInteractionCommand(interaction) {
    if (interaction.type !== DISCORD_INTERACTION_TYPE_APPLICATION_COMMAND)
        return { ok: false };
    const data = interaction.data;
    if (!isPlainRecord(data))
        return { ok: false };
    const name = data.name;
    if (typeof name !== "string" || !KNOWN_COMMANDS.includes(name))
        return { ok: false };
    const options = data.options;
    if (name === "agent") {
        // Exactly one option: named 'name', Discord STRING type, nonblank string
        // value. Anything else — extra options, wrong type, malformed entries —
        // fails closed.
        if (!Array.isArray(options) || options.length !== 1)
            return { ok: false };
        const option = options[0];
        if (!isPlainRecord(option))
            return { ok: false };
        if (option.name !== "name" || option.type !== DISCORD_OPTION_TYPE_STRING)
            return { ok: false };
        if (typeof option.value !== "string" || option.value.trim() === "")
            return { ok: false };
        return { ok: true, command: "agent", arg: option.value.trim() };
    }
    // The other four commands accept no options; any nonempty or malformed
    // options container fails closed.
    if (options !== undefined && (!Array.isArray(options) || options.length > 0))
        return { ok: false };
    return { ok: true, command: name, arg: undefined };
}
//# sourceMappingURL=discord-commands.js.map