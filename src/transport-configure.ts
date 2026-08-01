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
 * discord.application_id / install_url) are preserved on re-runs. The
 * Discord flow optionally collects explicit one-to-one DM user IDs
 * (allowed_dm_user_ids, ADR-0040 D1/D2); blank on a fresh config omits the
 * key so every DM stays denied, and the scope stays machine-local and
 * fail-closed.
 *
 * The pure helpers are unit-tested directly; the runner takes an injected
 * WizardPrompt and TransportConfigureIo so tests drive it with fakes. The
 * production fs adapter performs an atomic temp-file + rename write.
 */

import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { WizardPrompt } from "./prompt.js";
import type { TransportFeedbackConfig } from "./transport-feedback.js";
import { checkDiscordConfig, checkTelegramConfig } from "./doctor.js";

export type ConfigureTransportKind = "telegram" | "discord";

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "piren", "config.yml");

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Redact a secret for display. The output contains NO characters from the
 * secret — only its length — so previews and logs can never leak token
 * contents.
 */
export function redactSecret(secret: string): string {
  return `<redacted: ${secret.length} chars>`;
}

export type IdParseResult = { ok: true; ids: number[] } | { ok: false; error: string };
export type SnowflakeParseResult = { ok: true; ids: string[] } | { ok: false; error: string };

/**
 * Parse a comma-separated list of Telegram chat IDs. Chat IDs are integers;
 * group/supergroup IDs are negative. Empty entries, non-numeric values,
 * floats, and values beyond the safe-integer range are rejected.
 */
export function parseTelegramChatIds(input: string): IdParseResult {
  const parts = input.split(",").map((part) => part.trim());
  if (parts.length === 1 && parts[0] === "") {
    return { ok: false, error: "At least one chat ID is required." };
  }
  const ids: number[] = [];
  for (const part of parts) {
    if (part === "") {
      return { ok: false, error: "Empty entry in the chat ID list. Separate IDs with commas, for example: 123456789, -1001234567890" };
    }
    if (!/^-?\d+$/.test(part)) {
      return { ok: false, error: `Invalid chat ID '${part}': expected an integer (group IDs are negative).` };
    }
    const value = Number(part);
    if (!Number.isSafeInteger(value)) {
      return { ok: false, error: `Invalid chat ID '${part}': outside the safe integer range.` };
    }
    if (!ids.includes(value)) ids.push(value);
  }
  return { ok: true, ids };
}

/**
 * Parse a comma-separated list of Discord snowflake IDs. Snowflakes are
 * 15-22 digit strings and are stored as strings (they exceed the safe
 * integer range). The field key and noun make error messages distinguish
 * server (guild), channel, and thread IDs — and explicitly steer operators
 * away from the classic mistake of entering a user ID as a guild ID.
 * Optional lists accept blank input (keep/none) and the literal "none" as an
 * explicit clear.
 */
export function parseDiscordSnowflakes(
  input: string,
  field: string,
  noun: string,
  options: { optional?: boolean; userIdsExpected?: boolean } = {},
): SnowflakeParseResult {
  const trimmed = input.trim();
  if (trimmed === "") {
    if (options.optional) return { ok: true, ids: [] };
    return { ok: false, error: `At least one ${noun} ID is required in ${field}.` };
  }
  if (options.optional && trimmed.toLowerCase() === "none") {
    return { ok: true, ids: [] };
  }
  const parts = trimmed.split(",").map((part) => part.trim());
  const ids: string[] = [];
  for (const part of parts) {
    if (part === "") {
      return { ok: false, error: `Empty entry in ${field}. Separate IDs with commas.` };
    }
    if (!/^\d{15,22}$/.test(part)) {
      // For guild/channel/thread fields the classic mistake is entering a
      // user ID; for the DM user field a user ID is exactly right, so the
      // hint would be contradictory.
      const hint = options.userIdsExpected === true ? "." : ", not a user ID or name.";
      return {
        ok: false,
        error: `Invalid entry '${part}' in ${field}: expected a Discord ${noun} ID (15-22 digits, copied with Developer Mode)${hint}`,
      };
    }
    if (!ids.includes(part)) ids.push(part);
  }
  return { ok: true, ids };
}

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

export function buildTelegramConfigBlock(input: TelegramConfigureInput): TelegramConfigBlock {
  return {
    bot_token: input.botToken,
    allowed_chat_ids: input.chatIds,
    feedback: input.feedback,
    default_agent: input.defaultAgent,
  };
}

export interface DiscordConfigBlock {
  bot_token: string;
  allowed_guild_ids: string[];
  allowed_channel_ids: string[];
  allowed_thread_ids?: string[];
  allowed_dm_user_ids?: string[];
  feedback: TransportFeedbackConfig;
  default_agent: string;
}

export interface DiscordConfigureInput {
  botToken: string;
  guildIds: string[];
  channelIds: string[];
  threadIds: string[];
  dmUserIds: string[];
  feedback: TransportFeedbackConfig;
  defaultAgent: string;
}

export function buildDiscordConfigBlock(input: DiscordConfigureInput): DiscordConfigBlock {
  const block: DiscordConfigBlock = {
    bot_token: input.botToken,
    allowed_guild_ids: input.guildIds,
    allowed_channel_ids: input.channelIds,
    feedback: input.feedback,
    default_agent: input.defaultAgent,
  };
  if (input.threadIds.length > 0) {
    block.allowed_thread_ids = input.threadIds;
  }
  if (input.dmUserIds.length > 0) {
    block.allowed_dm_user_ids = input.dmUserIds;
  }
  return block;
}

/**
 * Merge a managed transport block over an existing parsed block. Unprompted
 * fields survive; prompted fields are replaced. A managed value of
 * `undefined` is an explicit deletion marker (used to clear optional lists
 * such as allowed_thread_ids), never a YAML `null`.
 */
export function mergeTransportBlock(
  existingBlock: Record<string, unknown>,
  managedBlock: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existingBlock };
  for (const [key, value] of Object.entries(managedBlock)) {
    if (value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Deep-merge one managed transport block into an existing local config.yml
 * document. Unrelated top-level keys survive; unprompted fields inside the
 * transport block (application_id, install_url, unknown keys) survive;
 * prompted keys are replaced on a re-run. The whole document is
 * re-serialized, so the managed block never duplicates.
 */
export function mergeTransportIntoConfig(
  existingYaml: string,
  kind: ConfigureTransportKind,
  managedBlock: Record<string, unknown>,
): string {
  const trimmed = existingYaml.trim();
  let parsed: unknown = null;
  if (trimmed !== "") {
    try {
      parsed = parseYaml(trimmed);
    } catch {
      parsed = null;
    }
  }
  const root: Record<string, unknown> =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};
  root[kind] = mergeTransportBlock(asRecord(root[kind]) ?? {}, managedBlock);
  return stringifyYaml(root);
}

/**
 * Render a YAML preview of a merged transport block with the token replaced
 * by a length-only redaction. The preview never contains token contents.
 */
export function renderRedactedPreview(kind: ConfigureTransportKind, mergedBlock: Record<string, unknown>): string {
  const token = typeof mergedBlock.bot_token === "string" ? mergedBlock.bot_token : "";
  const redactedBlock = { ...mergedBlock, bot_token: redactSecret(token) };
  return stringifyYaml({ [kind]: redactedBlock }).trim();
}

// ---------------------------------------------------------------------------
// Runner (impure; deps injected)
// ---------------------------------------------------------------------------

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
export const LOCAL_CONFIG_FILE_MODE = 0o600;

/**
 * Resolve the mode a replacement config file must carry. Existing owner-only
 * (or stricter) modes — no group/other bits, no owner execute — are
 * preserved; anything weaker becomes 0600.
 */
export function resolveLocalConfigFileMode(existingMode: number | undefined): number {
  if (existingMode !== undefined) {
    const bits = existingMode & 0o777;
    const noGroupOrOther = (bits & 0o077) === 0;
    const noOwnerExecute = (bits & 0o100) === 0;
    if (noGroupOrOther && noOwnerExecute) return bits;
  }
  return LOCAL_CONFIG_FILE_MODE;
}

export function createNodeTransportConfigureIo(): TransportConfigureIo {
  return {
    async readConfig(path: string): Promise<string | null> {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async writeConfigAtomic(path: string, content: string): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      let existingMode: number | undefined;
      try {
        existingMode = (await stat(path)).mode;
      } catch {
        existingMode = undefined;
      }
      const mode = resolveLocalConfigFileMode(existingMode);
      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, content, { encoding: "utf8", mode: LOCAL_CONFIG_FILE_MODE });
      // writeFile's mode applies only at creation and is umask-masked; chmod
      // pins the exact target mode before the rename lands it on the config.
      await chmod(tmp, mode);
      await rename(tmp, path);
    },
  };
}

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
  validation?: { status: "ok" | "warn"; message: string };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is number | string => typeof entry === "number" || typeof entry === "string")
    .map((entry) => String(entry));
}

async function promptValidatedIds<T>(
  prompt: WizardPrompt,
  log: (message: string) => void,
  message: string,
  defaultRaw: string,
  parse: (raw: string) => { ok: true; ids: T[] } | { ok: false; error: string },
): Promise<T[]> {
  while (true) {
    const raw = defaultRaw === "" ? await prompt.text(message) : await prompt.text(message, defaultRaw);
    const result = parse(raw);
    if (result.ok) return result.ids;
    log(`  ${result.error}`);
  }
}

export async function runTransportConfigure(
  prompt: WizardPrompt,
  kind: ConfigureTransportKind,
  deps: TransportConfigureDeps,
): Promise<TransportConfigureResult> {
  const log = deps.log ?? ((message: string) => console.log(message));
  const configPath = deps.configPath ?? DEFAULT_CONFIG_PATH;
  const io = deps.io ?? createNodeTransportConfigureIo();
  const runnable = deps.runnableAgents;

  if (runnable.length === 0) {
    throw new Error(
      "No locally runnable agents on this installation. Configure allowed_agents in ~/.config/piren/config.yml (or run piren setup) before configuring a transport. No changes were written.",
    );
  }

  log(`This configures the ${kind} transport in ${configPath} only.`);
  log("The bot token stays on this machine; nothing is written to the vault, no platform is contacted, and no service is installed or started.");
  log("");

  const existingText = await io.readConfig(configPath);
  let existingRoot: Record<string, unknown> = {};
  if (existingText !== null && existingText.trim() !== "") {
    // Fail closed: silently replacing an unparseable or non-mapping config
    // after confirmation would destroy unrelated local configuration.
    let parsed: unknown;
    try {
      parsed = parseYaml(existingText);
    } catch (error) {
      throw new Error(
        `Existing config at ${configPath} is not parseable YAML (${error instanceof Error ? error.message : String(error)}). Fix or back it up manually. No changes were written.`,
      );
    }
    const record = asRecord(parsed);
    if (record === undefined) {
      throw new Error(`Existing config at ${configPath} is not parseable as a YAML mapping. Fix or back it up manually. No changes were written.`);
    }
    existingRoot = record;
  }
  const existingBlock = asRecord(existingRoot[kind]) ?? {};

  // --- Bot token (secret input; keep-existing on re-run) ---
  const existingToken = asNonEmptyString(existingBlock.bot_token);
  let botToken: string;
  if (existingToken !== undefined) {
    const keep = await prompt.confirm(`A bot token is already configured for ${kind}. Keep the existing token?`, true);
    botToken = keep ? existingToken : (await prompt.secret(`${kind === "telegram" ? "Telegram" : "Discord"} bot token`)).trim();
  } else {
    const hint = kind === "telegram" ? " (from BotFather)" : " (from the Discord Developer Portal)";
    botToken = (await prompt.secret(`${kind === "telegram" ? "Telegram" : "Discord"} bot token${hint}`)).trim();
  }
  if (botToken === "") {
    throw new Error("A bot token is required. No changes were written.");
  }

  // --- Platform identifiers ---
  let chatIds: number[] = [];
  let guildIds: string[] = [];
  let channelIds: string[] = [];
  let threadIds: string[] = [];
  let dmUserIds: string[] = [];
  if (kind === "telegram") {
    chatIds = await promptValidatedIds(
      prompt,
      log,
      "Allowed chat IDs (comma-separated integers; group IDs are negative)",
      asIdList(existingBlock.allowed_chat_ids).join(", "),
      parseTelegramChatIds,
    );
  } else {
    guildIds = await promptValidatedIds(
      prompt,
      log,
      "Server (guild) IDs (comma-separated snowflakes; enable Discord Developer Mode to copy them)",
      asIdList(existingBlock.allowed_guild_ids).join(", "),
      (raw) => parseDiscordSnowflakes(raw, "allowed_guild_ids", "server (guild)"),
    );
    channelIds = await promptValidatedIds(
      prompt,
      log,
      "Channel IDs (comma-separated snowflakes)",
      asIdList(existingBlock.allowed_channel_ids).join(", "),
      (raw) => parseDiscordSnowflakes(raw, "allowed_channel_ids", "channel"),
    );
    threadIds = await promptValidatedIds(
      prompt,
      log,
      "Thread IDs (comma-separated snowflakes; blank to keep current, 'none' to clear)",
      asIdList(existingBlock.allowed_thread_ids).join(", "),
      (raw) => parseDiscordSnowflakes(raw, "allowed_thread_ids", "thread", { optional: true }),
    );
    // ADR-0040 D2: optional one-to-one DM sender allowlist. Blank keeps the
    // current value (none configured = every DM stays denied); 'none'
    // clears. These are user IDs — never guild/channel IDs.
    log("Optional: authorize one-to-one direct messages from explicit Discord user IDs. With none configured, every DM is denied.");
    dmUserIds = await promptValidatedIds(
      prompt,
      log,
      "One-to-one DM user IDs (comma-separated user snowflakes, not a server or channel ID; blank to keep current, 'none' to clear)",
      asIdList(existingBlock.allowed_dm_user_ids).join(", "),
      (raw) => parseDiscordSnowflakes(raw, "allowed_dm_user_ids", "user", { optional: true, userIdsExpected: true }),
    );
  }

  // --- Feedback preferences (platform-correct reaction defaults) ---
  const existingFeedback = asRecord(existingBlock.feedback) as TransportFeedbackConfig | undefined;
  const feedbackEnabled = await prompt.confirm(
    "Enable transport feedback (receipt and completion reactions plus a typing indicator)?",
    existingFeedback?.enabled !== false,
  );
  let feedback: TransportFeedbackConfig;
  if (feedbackEnabled) {
    const receiveDefault = asNonEmptyString(existingFeedback?.reaction_on_receive) ?? "👀";
    const completeDefault =
      asNonEmptyString(existingFeedback?.reaction_on_complete) ?? (kind === "telegram" ? "👍" : "✅");
    const receiveAnswer = (await prompt.text("Receipt reaction emoji", receiveDefault)).trim();
    const completeAnswer = (await prompt.text("Completion reaction emoji", completeDefault)).trim();
    const typing = await prompt.confirm(
      "Show a typing indicator while the agent works?",
      typeof existingFeedback?.typing_while_working === "boolean" ? existingFeedback.typing_while_working : true,
    );
    feedback = {
      enabled: true,
      reaction_on_receive: receiveAnswer === "" ? receiveDefault : receiveAnswer,
      reaction_on_complete: completeAnswer === "" ? completeDefault : completeAnswer,
      typing_while_working: typing,
    };
  } else {
    feedback = { enabled: false };
  }

  // --- Default agent (runnable set only) ---
  const existingDefault = asNonEmptyString(existingBlock.default_agent);
  const defaultIndex = existingDefault !== undefined && runnable.includes(existingDefault) ? runnable.indexOf(existingDefault) : 0;
  const picked = await prompt.select("Default Piren agent for this transport", runnable, defaultIndex);
  const defaultAgent = runnable[picked]!;

  // --- Build, merge, preview, confirm ---
  const managedBlock: Record<string, unknown> =
    kind === "telegram"
      ? { ...buildTelegramConfigBlock({ botToken, chatIds, feedback, defaultAgent }) }
      : { ...buildDiscordConfigBlock({ botToken, guildIds, channelIds, threadIds, dmUserIds, feedback, defaultAgent }) };
  if (kind === "discord" && threadIds.length === 0) {
    // Explicit deletion marker so 'none' clears a previously configured
    // thread allowlist instead of silently preserving it.
    managedBlock.allowed_thread_ids = undefined;
  }
  if (kind === "discord" && dmUserIds.length === 0) {
    // Same deletion marker for the DM user allowlist: blank/'none' must omit
    // the key (absent means every DM denied), never serialize []/null.
    managedBlock.allowed_dm_user_ids = undefined;
  }
  const mergedYaml = mergeTransportIntoConfig(existingText ?? "", kind, managedBlock);
  const mergedBlock = mergeTransportBlock(existingBlock, managedBlock);

  log("");
  log(`The following ${kind} block will be written to ${configPath} (bot token redacted):`);
  log(renderRedactedPreview(kind, mergedBlock)
    .split("\n")
    .map((line) => "  " + line)
    .join("\n"));
  log("");
  const confirmWrite = await prompt.confirm("Write this configuration?", true);
  if (!confirmWrite) {
    log("Cancelled. No changes were written.");
    return { transport: kind, configPath, wrote: false, cancelled: true };
  }

  await io.writeConfigAtomic(configPath, mergedYaml);
  log(`Wrote ${configPath}.`);

  // --- Validate without launching anything ---
  const check =
    kind === "telegram"
      ? checkTelegramConfig(mergedBlock, runnable)
      : checkDiscordConfig(mergedBlock, runnable);
  const validation = {
    status: (check?.status === "warn" ? "warn" : "ok") as "ok" | "warn",
    message: check?.message ?? "",
  };
  if (check) {
    log(`Validation: [${validation.status}] ${validation.message}`);
  }
  log("");
  log("Next steps (nothing has been started):");
  log("  piren doctor");
  log(`  piren ${kind}          # foreground; Ctrl-C to stop`);
  log(`Then send /start from an allowlisted ${kind === "telegram" ? "chat" : "channel"}, followed by an ordinary message.`);
  log(`To run as a service: piren service install ${kind}`);

  const result: TransportConfigureResult = { transport: kind, configPath, wrote: true, cancelled: false, validation };
  return result;
}
