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
/**
 * Default-on feedback, matching ADR-0025: receipt reaction, completion
 * reaction, and typing indicator all active unless explicitly disabled.
 */
export const DEFAULT_FEEDBACK = {
    enabled: true,
    reactionOnReceive: "👀",
    reactionOnComplete: "✅",
    typingWhileWorking: true,
};
/**
 * Normalize a raw feedback config block into a resolved object. Missing or
 * empty values fall back to defaults so a bare or absent `feedback:` block
 * enables all feedback. `enabled: false` disables everything at once.
 */
export function resolveFeedback(config) {
    if (!config)
        return { ...DEFAULT_FEEDBACK };
    const reactionOnReceive = typeof config.reaction_on_receive === "string" && config.reaction_on_receive.trim() !== ""
        ? config.reaction_on_receive
        : DEFAULT_FEEDBACK.reactionOnReceive;
    const reactionOnComplete = typeof config.reaction_on_complete === "string" && config.reaction_on_complete.trim() !== ""
        ? config.reaction_on_complete
        : DEFAULT_FEEDBACK.reactionOnComplete;
    return {
        enabled: config.enabled === false ? false : DEFAULT_FEEDBACK.enabled,
        reactionOnReceive,
        reactionOnComplete,
        typingWhileWorking: typeof config.typing_while_working === "boolean"
            ? config.typing_while_working
            : DEFAULT_FEEDBACK.typingWhileWorking,
    };
}
//# sourceMappingURL=transport-feedback.js.map