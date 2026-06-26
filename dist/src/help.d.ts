/**
 * Help system for the Piren CLI.
 *
 * Pure and unit-tested. `isHelpRequest` detects -h/--help in a Piren argv slice
 * (respecting the `--` passthrough separator so `piren run -- --help` forwards the
 * flag to Pi). `formatHelp` renders the top-level command list; `formatCommandHelp`
 * renders per-command usage, flags, and an example.
 *
 * This module holds the single source of truth for command descriptions and flags so
 * the help text cannot drift from what the parser actually recognizes.
 */
export interface CommandHelpTopic {
    command: string;
    short: string;
    flags?: string[];
    example?: string;
}
export declare const HELP_TOPICS: readonly CommandHelpTopic[];
/**
 * Detect a help request in a Piren argv slice. Respects the `--` passthrough
 * separator: anything after `--` belongs to Pi and is not a Piren help request.
 */
export declare function isHelpRequest(argv: string[]): boolean;
export declare function formatHelp(): string;
export declare function formatCommandHelp(command: string): string;
