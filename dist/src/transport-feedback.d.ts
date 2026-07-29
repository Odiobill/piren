/**
 * Transport feedback (ADR-0025).
 *
 * Receipt reactions and typing indicators for messaging transports. Both
 * Telegram and Discord use this config shape and default-on behavior.
 *
 * The pure `resolveFeedback` normalizes the snake_case config block from
 * local installation YAML into a camelCase resolved object with sensible
 * defaults. The transport layer calls the resolved config to decide whether
 * to send a reaction and/or typing indicator around each prompt.
 */
export interface TransportFeedbackConfig {
    enabled?: boolean;
    reaction_on_receive?: string;
    reaction_on_complete?: string;
    typing_while_working?: boolean;
}
export interface TransportFeedback {
    enabled: boolean;
    reactionOnReceive: string;
    reactionOnComplete: string;
    typingWhileWorking: boolean;
}
/**
 * Default-on feedback, matching ADR-0025: receipt reaction, completion
 * reaction, and typing indicator all active unless explicitly disabled.
 */
export declare const DEFAULT_FEEDBACK: TransportFeedback;
/**
 * Telegram default feedback. Identical to the shared defaults except the
 * completion reaction: ✅ is not a Telegram-valid reaction emoji (the Bot
 * API rejects it with REACTION_INVALID), so Telegram defaults to 👍.
 * Operators can still explicitly override with any emoji; feedback calls are
 * best-effort and Piren does not validate platform emoji availability.
 */
export declare const TELEGRAM_DEFAULT_FEEDBACK: TransportFeedback;
/**
 * Normalize a raw feedback config block into a resolved object. Missing or
 * empty values fall back to the given `defaults` (shared defaults unless a
 * transport passes its own) so a bare or absent `feedback:` block enables all
 * feedback. `enabled: false` disables everything at once. Explicitly
 * configured values always pass through unchanged.
 */
export declare function resolveFeedback(config: TransportFeedbackConfig | undefined, defaults?: TransportFeedback): TransportFeedback;
