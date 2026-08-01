/**
 * Readline-based interactive prompt for the setup wizard.
 *
 * Thin, injectable adapter. The wizard runner takes a `WizardPrompt` interface
 * so tests drive it with a fake prompter and the real readline implementation
 * is only used by the CLI.
 *
 * Lines are buffered through a persistent `line` listener instead of
 * sequential `rl.question()` calls: when stdin is piped, a whole script of
 * answers can arrive in a single chunk, and `rl.question()` would drop every
 * line after the first (its one-shot listener is only attached while a
 * question is pending). Buffering keeps interactive TTY behavior identical
 * while making scripted/non-TTY input work.
 */
import { type Interface } from "node:readline/promises";
export interface WizardPrompt {
    /** Prompt for a line of text. Returns the trimmed value. Resolves "" on empty. */
    text(message: string, defaultValue?: string): Promise<string>;
    /** Prompt for a secret (no echo). Returns the raw value. */
    secret(message: string): Promise<string>;
    /** Ask a yes/no question. Returns true for yes/y (case-insensitive), else false. */
    confirm(message: string, defaultValue?: boolean): Promise<boolean>;
    /** Present a numbered menu and return the selected option's index (0-based). */
    select(message: string, options: readonly string[], defaultIndex?: number): Promise<number>;
    /** Ask for a comma-separated list. Returns trimmed, non-empty values. */
    list(message: string, defaults?: string[]): Promise<string[]>;
}
export declare class ReadlinePrompt implements WizardPrompt {
    private rl;
    private buffer;
    private waiters;
    private open;
    constructor(rl?: Interface);
    /** Write the prompt text and resolve with the next buffered (or future) line. */
    private nextLine;
    text(message: string, defaultValue?: string): Promise<string>;
    secret(message: string): Promise<string>;
    confirm(message: string, defaultValue?: boolean): Promise<boolean>;
    select(message: string, options: readonly string[], defaultIndex?: number): Promise<number>;
    list(message: string, defaults?: string[]): Promise<string[]>;
    close(): void;
}
