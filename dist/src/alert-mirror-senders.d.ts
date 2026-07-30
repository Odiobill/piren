import type { LocalPirenConfig } from "./bootstrap.js";
import type { AlertMirrorSenders } from "./alert-mirror.js";
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
export declare function createAlertMirrorSenders(config: LocalPirenConfig, fetchImpl?: typeof fetch): AlertMirrorSenders;
