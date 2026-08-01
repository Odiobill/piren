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
export const DISCORD_APPLICATION_COMMANDS: readonly DiscordCommandSpec[] = [
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

// ---------------------------------------------------------------------------
// Registration planning (narrow per-command create/update; never destructive)
// ---------------------------------------------------------------------------

export interface RegisteredCommandRef {
  id: string;
  name: string;
}

export type CommandRegistrationAction =
  | { kind: "create"; spec: DiscordCommandSpec }
  | { kind: "update"; commandId: string; spec: DiscordCommandSpec };

/**
 * Plan registration as narrow per-command create/update actions keyed by
 * command name. Existing commands whose names are not in the manifest are
 * never touched — there is deliberately no delete action and no bulk
 * overwrite, so unrelated application commands survive registration.
 */
export function planCommandRegistration(
  existing: RegisteredCommandRef[],
  desired: readonly DiscordCommandSpec[],
): CommandRegistrationAction[] {
  const existingIdsByName = new Map(existing.map((command) => [command.name, command.id]));
  return desired.map((spec) => {
    const existingId = existingIdsByName.get(spec.name);
    if (existingId !== undefined) {
      return { kind: "update", commandId: existingId, spec };
    }
    return { kind: "create", spec };
  });
}

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
export async function registerApplicationCommands(
  api: DiscordApplicationCommandApi,
  applicationId: string,
): Promise<CommandRegistrationResult> {
  const existing = await api.listApplicationCommands(applicationId);
  const actions = planCommandRegistration(existing, DISCORD_APPLICATION_COMMANDS);
  const created: string[] = [];
  const updated: string[] = [];
  for (const action of actions) {
    if (action.kind === "create") {
      await api.createApplicationCommand(applicationId, action.spec);
      created.push(action.spec.name);
    } else {
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
export async function maybeRegisterApplicationCommands(
  api: DiscordApplicationCommandApi,
  applicationId: string | undefined,
): Promise<CommandRegistrationResult | null> {
  if (applicationId === undefined || applicationId.trim() === "") return null;
  return registerApplicationCommands(api, applicationId.trim());
}

// ---------------------------------------------------------------------------
// Interaction command parsing (fail-closed shape validation)
// ---------------------------------------------------------------------------

export type DiscordCommandName = "start" | "agents" | "agent" | "whoami" | "abort";

export type InteractionCommandParse =
  | { ok: true; command: DiscordCommandName; arg: string | undefined }
  | { ok: false };

/** Loose inbound interaction shape; narrowed by parseInteractionCommand. */
export interface DiscordInteractionPayload {
  id?: string;
  token?: string;
  type?: number;
  guild_id?: string;
  channel_id?: string;
  data?: {
    name?: string;
    options?: Array<{ name?: string; type?: number; value?: unknown }>;
  };
  user?: { id?: string; bot?: boolean };
  member?: { user?: { id?: string; bot?: boolean } };
}

const KNOWN_COMMANDS: readonly DiscordCommandName[] = ["start", "agents", "agent", "whoami", "abort"];

/**
 * Translate only the five defined application commands into command
 * semantics. Everything else — wrong interaction type, unknown names,
 * missing data, malformed /agent options — fails closed. Arbitrary
 * interaction data is never treated as a prompt.
 */
export function parseInteractionCommand(interaction: DiscordInteractionPayload): InteractionCommandParse {
  if (interaction.type !== DISCORD_INTERACTION_TYPE_APPLICATION_COMMAND) return { ok: false };
  const name = interaction.data?.name;
  if (name === undefined || !(KNOWN_COMMANDS as readonly string[]).includes(name)) return { ok: false };
  if (name === "agent") {
    const option = interaction.data?.options?.find((entry) => entry.name === "name");
    const value = option?.value;
    if (typeof value !== "string" || value.trim() === "") return { ok: false };
    return { ok: true, command: "agent", arg: value.trim() };
  }
  return { ok: true, command: name as DiscordCommandName, arg: undefined };
}
