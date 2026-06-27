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
 * Normalize a raw feedback config block into a resolved object. Missing or
 * empty values fall back to defaults so a bare or absent `feedback:` block
 * enables all feedback. `enabled: false` disables everything at once.
 */
export declare function resolveFeedback(config: TransportFeedbackConfig | undefined): TransportFeedback;
