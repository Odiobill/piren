import { TelegramBotApiHttpClient, chunkTelegramMessage } from "./telegram-transport.js";
import { DiscordBotApiHttpClient, chunkDiscordMessage } from "./discord-transport.js";
/**
 * Production alert-mirror sender adapters (ADR-0039 E1, M3).
 *
 * Thin adapters over the existing best-effort Telegram/Discord HTTP clients.
 * Bot tokens are reused from the existing local `telegram.bot_token` /
 * `discord.bot_token` config (trimmed); no new credentials are introduced and
 * nothing here touches inbound allowlists.
 *
 * Platform chunking lives here, not in the M1 core: each logical notification
 * text is split with the existing platform chunkers and the chunks are sent
 * sequentially. If any chunk fails, the logical sender rejects, so the M1 core
 * records exactly one aggregate normalized `failed` delivery for that
 * destination. There is no retry, queue, or durable delivery state.
 *
 * The optional `fetchImpl` seam exists only so tests avoid live network calls;
 * production uses the global `fetch`.
 */
export function createAlertMirrorSenders(config, fetchImpl = fetch) {
    const senders = {};
    const telegramToken = typeof config.telegram?.bot_token === "string" ? config.telegram.bot_token.trim() : "";
    if (telegramToken !== "") {
        const client = new TelegramBotApiHttpClient(telegramToken, fetchImpl);
        senders.telegram = async (chatId, text) => {
            for (const chunk of chunkTelegramMessage(text)) {
                await client.sendMessage(chatId, chunk);
            }
        };
    }
    const discordToken = typeof config.discord?.bot_token === "string" ? config.discord.bot_token.trim() : "";
    if (discordToken !== "") {
        const client = new DiscordBotApiHttpClient(discordToken, fetchImpl);
        senders.discord = async (channelId, text) => {
            for (const chunk of chunkDiscordMessage(text)) {
                await client.createMessage(channelId, chunk);
            }
        };
    }
    return senders;
}
//# sourceMappingURL=alert-mirror-senders.js.map