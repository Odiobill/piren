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
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { checkDiscordConfig, checkTelegramConfig } from "./doctor.js";
const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "piren", "config.yml");
// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
/**
 * Redact a secret for display. The output contains NO characters from the
 * secret — only its length — so previews and logs can never leak token
 * contents.
 */
export function redactSecret(secret) {
    return `<redacted: ${secret.length} chars>`;
}
/**
 * Parse a comma-separated list of Telegram chat IDs. Chat IDs are integers;
 * group/supergroup IDs are negative. Empty entries, non-numeric values,
 * floats, and values beyond the safe-integer range are rejected.
 */
export function parseTelegramChatIds(input) {
    const parts = input.split(",").map((part) => part.trim());
    if (parts.length === 1 && parts[0] === "") {
        return { ok: false, error: "At least one chat ID is required." };
    }
    const ids = [];
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
        if (!ids.includes(value))
            ids.push(value);
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
export function parseDiscordSnowflakes(input, field, noun, options = {}) {
    const trimmed = input.trim();
    if (trimmed === "") {
        if (options.optional)
            return { ok: true, ids: [] };
        return { ok: false, error: `At least one ${noun} ID is required in ${field}.` };
    }
    if (options.optional && trimmed.toLowerCase() === "none") {
        return { ok: true, ids: [] };
    }
    const parts = trimmed.split(",").map((part) => part.trim());
    const ids = [];
    for (const part of parts) {
        if (part === "") {
            return { ok: false, error: `Empty entry in ${field}. Separate IDs with commas.` };
        }
        if (!/^\d{15,22}$/.test(part)) {
            return {
                ok: false,
                error: `Invalid entry '${part}' in ${field}: expected a Discord ${noun} ID (15-22 digits, copied with Developer Mode), not a user ID or name.`,
            };
        }
        if (!ids.includes(part))
            ids.push(part);
    }
    return { ok: true, ids };
}
export function buildTelegramConfigBlock(input) {
    return {
        bot_token: input.botToken,
        allowed_chat_ids: input.chatIds,
        feedback: input.feedback,
        default_agent: input.defaultAgent,
    };
}
export function buildDiscordConfigBlock(input) {
    const block = {
        bot_token: input.botToken,
        allowed_guild_ids: input.guildIds,
        allowed_channel_ids: input.channelIds,
        feedback: input.feedback,
        default_agent: input.defaultAgent,
    };
    if (input.threadIds.length > 0) {
        block.allowed_thread_ids = input.threadIds;
    }
    return block;
}
/**
 * Merge a managed transport block over an existing parsed block. Unprompted
 * fields survive; prompted fields are replaced. A managed value of
 * `undefined` is an explicit deletion marker (used to clear optional lists
 * such as allowed_thread_ids), never a YAML `null`.
 */
export function mergeTransportBlock(existingBlock, managedBlock) {
    const merged = { ...existingBlock };
    for (const [key, value] of Object.entries(managedBlock)) {
        if (value === undefined) {
            delete merged[key];
        }
        else {
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
export function mergeTransportIntoConfig(existingYaml, kind, managedBlock) {
    const trimmed = existingYaml.trim();
    let parsed = null;
    if (trimmed !== "") {
        try {
            parsed = parseYaml(trimmed);
        }
        catch {
            parsed = null;
        }
    }
    const root = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ...parsed }
        : {};
    root[kind] = mergeTransportBlock(asRecord(root[kind]) ?? {}, managedBlock);
    return stringifyYaml(root);
}
/**
 * Render a YAML preview of a merged transport block with the token replaced
 * by a length-only redaction. The preview never contains token contents.
 */
export function renderRedactedPreview(kind, mergedBlock) {
    const token = typeof mergedBlock.bot_token === "string" ? mergedBlock.bot_token : "";
    const redactedBlock = { ...mergedBlock, bot_token: redactSecret(token) };
    return stringifyYaml({ [kind]: redactedBlock }).trim();
}
export function createNodeTransportConfigureIo() {
    return {
        async readConfig(path) {
            try {
                return await readFile(path, "utf8");
            }
            catch {
                return null;
            }
        },
        async writeConfigAtomic(path, content) {
            await mkdir(dirname(path), { recursive: true });
            const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
            await writeFile(tmp, content, "utf8");
            await rename(tmp, path);
        },
    };
}
function asRecord(value) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return value;
    }
    return undefined;
}
function asNonEmptyString(value) {
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
function asIdList(value) {
    if (!Array.isArray(value))
        return [];
    return value
        .filter((entry) => typeof entry === "number" || typeof entry === "string")
        .map((entry) => String(entry));
}
async function promptValidatedIds(prompt, log, message, defaultRaw, parse) {
    while (true) {
        const raw = defaultRaw === "" ? await prompt.text(message) : await prompt.text(message, defaultRaw);
        const result = parse(raw);
        if (result.ok)
            return result.ids;
        log(`  ${result.error}`);
    }
}
export async function runTransportConfigure(prompt, kind, deps) {
    const log = deps.log ?? ((message) => console.log(message));
    const configPath = deps.configPath ?? DEFAULT_CONFIG_PATH;
    const io = deps.io ?? createNodeTransportConfigureIo();
    const runnable = deps.runnableAgents;
    if (runnable.length === 0) {
        throw new Error("No locally runnable agents on this installation. Configure allowed_agents in ~/.config/piren/config.yml (or run piren setup) before configuring a transport. No changes were written.");
    }
    log(`This configures the ${kind} transport in ${configPath} only.`);
    log("The bot token stays on this machine; nothing is written to the vault, no platform is contacted, and no service is installed or started.");
    log("");
    const existingText = await io.readConfig(configPath);
    let existingRoot = {};
    if (existingText !== null && existingText.trim() !== "") {
        try {
            existingRoot = asRecord(parseYaml(existingText)) ?? {};
        }
        catch {
            existingRoot = {};
        }
    }
    const existingBlock = asRecord(existingRoot[kind]) ?? {};
    // --- Bot token (secret input; keep-existing on re-run) ---
    const existingToken = asNonEmptyString(existingBlock.bot_token);
    let botToken;
    if (existingToken !== undefined) {
        const keep = await prompt.confirm(`A bot token is already configured for ${kind}. Keep the existing token?`, true);
        botToken = keep ? existingToken : (await prompt.secret(`${kind === "telegram" ? "Telegram" : "Discord"} bot token`)).trim();
    }
    else {
        const hint = kind === "telegram" ? " (from BotFather)" : " (from the Discord Developer Portal)";
        botToken = (await prompt.secret(`${kind === "telegram" ? "Telegram" : "Discord"} bot token${hint}`)).trim();
    }
    if (botToken === "") {
        throw new Error("A bot token is required. No changes were written.");
    }
    // --- Platform identifiers ---
    let chatIds = [];
    let guildIds = [];
    let channelIds = [];
    let threadIds = [];
    if (kind === "telegram") {
        chatIds = await promptValidatedIds(prompt, log, "Allowed chat IDs (comma-separated integers; group IDs are negative)", asIdList(existingBlock.allowed_chat_ids).join(", "), parseTelegramChatIds);
    }
    else {
        guildIds = await promptValidatedIds(prompt, log, "Server (guild) IDs (comma-separated snowflakes; enable Discord Developer Mode to copy them)", asIdList(existingBlock.allowed_guild_ids).join(", "), (raw) => parseDiscordSnowflakes(raw, "allowed_guild_ids", "server (guild)"));
        channelIds = await promptValidatedIds(prompt, log, "Channel IDs (comma-separated snowflakes)", asIdList(existingBlock.allowed_channel_ids).join(", "), (raw) => parseDiscordSnowflakes(raw, "allowed_channel_ids", "channel"));
        threadIds = await promptValidatedIds(prompt, log, "Thread IDs (comma-separated snowflakes; blank to keep current, 'none' to clear)", asIdList(existingBlock.allowed_thread_ids).join(", "), (raw) => parseDiscordSnowflakes(raw, "allowed_thread_ids", "thread", { optional: true }));
    }
    // --- Feedback preferences (platform-correct reaction defaults) ---
    const existingFeedback = asRecord(existingBlock.feedback);
    const feedbackEnabled = await prompt.confirm("Enable transport feedback (receipt and completion reactions plus a typing indicator)?", existingFeedback?.enabled !== false);
    let feedback;
    if (feedbackEnabled) {
        const receiveDefault = asNonEmptyString(existingFeedback?.reaction_on_receive) ?? "👀";
        const completeDefault = asNonEmptyString(existingFeedback?.reaction_on_complete) ?? (kind === "telegram" ? "👍" : "✅");
        const receiveAnswer = (await prompt.text("Receipt reaction emoji", receiveDefault)).trim();
        const completeAnswer = (await prompt.text("Completion reaction emoji", completeDefault)).trim();
        const typing = await prompt.confirm("Show a typing indicator while the agent works?", typeof existingFeedback?.typing_while_working === "boolean" ? existingFeedback.typing_while_working : true);
        feedback = {
            enabled: true,
            reaction_on_receive: receiveAnswer === "" ? receiveDefault : receiveAnswer,
            reaction_on_complete: completeAnswer === "" ? completeDefault : completeAnswer,
            typing_while_working: typing,
        };
    }
    else {
        feedback = { enabled: false };
    }
    // --- Default agent (runnable set only) ---
    const existingDefault = asNonEmptyString(existingBlock.default_agent);
    const defaultIndex = existingDefault !== undefined && runnable.includes(existingDefault) ? runnable.indexOf(existingDefault) : 0;
    const picked = await prompt.select("Default Piren agent for this transport", runnable, defaultIndex);
    const defaultAgent = runnable[picked];
    // --- Build, merge, preview, confirm ---
    const managedBlock = kind === "telegram"
        ? { ...buildTelegramConfigBlock({ botToken, chatIds, feedback, defaultAgent }) }
        : { ...buildDiscordConfigBlock({ botToken, guildIds, channelIds, threadIds, feedback, defaultAgent }) };
    if (kind === "discord" && threadIds.length === 0) {
        // Explicit deletion marker so 'none' clears a previously configured
        // thread allowlist instead of silently preserving it.
        managedBlock.allowed_thread_ids = undefined;
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
    const check = kind === "telegram"
        ? checkTelegramConfig(mergedBlock, runnable)
        : checkDiscordConfig(mergedBlock, runnable);
    const validation = {
        status: (check?.status === "warn" ? "warn" : "ok"),
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
    const result = { transport: kind, configPath, wrote: true, cancelled: false, validation };
    return result;
}
//# sourceMappingURL=transport-configure.js.map