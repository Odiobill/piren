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
export const DEFAULT_FEEDBACK: TransportFeedback = {
  enabled: true,
  reactionOnReceive: "👀",
  reactionOnComplete: "✅",
  typingWhileWorking: true,
};

/**
 * Telegram default feedback. Identical to the shared defaults except the
 * completion reaction: ✅ is not a Telegram-valid reaction emoji (the Bot
 * API rejects it with REACTION_INVALID), so Telegram defaults to 👍.
 * Operators can still explicitly override with any emoji; feedback calls are
 * best-effort and Piren does not validate platform emoji availability.
 */
export const TELEGRAM_DEFAULT_FEEDBACK: TransportFeedback = {
  ...DEFAULT_FEEDBACK,
  reactionOnComplete: "👍",
};

/**
 * Normalize a raw feedback config block into a resolved object. Missing or
 * empty values fall back to the given `defaults` (shared defaults unless a
 * transport passes its own) so a bare or absent `feedback:` block enables all
 * feedback. `enabled: false` disables everything at once. Explicitly
 * configured values always pass through unchanged.
 */
export function resolveFeedback(config: TransportFeedbackConfig | undefined, defaults: TransportFeedback = DEFAULT_FEEDBACK): TransportFeedback {
  if (!config) return { ...defaults };
  const reactionOnReceive =
    typeof config.reaction_on_receive === "string" && config.reaction_on_receive.trim() !== ""
      ? config.reaction_on_receive
      : defaults.reactionOnReceive;
  const reactionOnComplete =
    typeof config.reaction_on_complete === "string" && config.reaction_on_complete.trim() !== ""
      ? config.reaction_on_complete
      : defaults.reactionOnComplete;
  return {
    enabled: config.enabled === false ? false : defaults.enabled,
    reactionOnReceive,
    reactionOnComplete,
    typingWhileWorking:
      typeof config.typing_while_working === "boolean"
        ? config.typing_while_working
        : defaults.typingWhileWorking,
  };
}
