/**
 * CLI argument parser for Piren.
 *
 * Extracted from src/cli.ts so it can be unit-tested in isolation. The parser
 * is intentionally pure: it takes argv and returns a structured result, with no
 * filesystem, process.env, or side effects.
 *
 * Parsing rules:
 * - Flags can appear before OR after the command name.
 * - `--` splits Piren args from Pi passthrough args. Everything after `--` goes
 *   into `piArgs` untouched.
 * - A known command name starts positional collection. Subsequent non-flag
 *   tokens become positionals (used by `ask` and `clean`).
 *
 * IMPORTANT: flag scanning must not stop at the command name. Earlier versions
 * broke out of the scan loop on the command token, which caused flags after the
 * command (e.g. `piren clean --force`) to be silently ignored. This module
 * scans the full Piren-args array for flags regardless of position.
 */
import type { BootstrapOptions } from "./bootstrap.js";
export interface ParsedArgs {
    agentDir: string | undefined;
    agentName: string | undefined;
    vaultRoot: string | undefined;
    force: boolean;
    apply: boolean;
    yes: boolean;
    help: boolean;
    port: number | undefined;
    host: string | undefined;
    token: string | undefined;
    command: string;
    positionals: string[];
    piArgs: string[];
}
/** Commands the CLI recognizes as the first non-flag positional. */
export declare const KNOWN_COMMANDS: readonly ["status", "agents", "doctor", "init", "run", "worker", "setup", "gateway", "web", "telegram", "discord", "ask", "chat", "service", "agent", "clean", "version"];
/**
 * Parse Piren CLI arguments (typically `process.argv.slice(2)`).
 *
 * Returns the structured parse result. Does NOT validate the command: an
 * unknown first positional is returned as `command` unchanged, and the caller
 * is responsible for rejecting it (this preserves the historical "unknown
 * command" exit-2 path in the CLI).
 */
export declare function parseArgs(argv: string[]): ParsedArgs;
/**
 * Build a BootstrapOptions object from parsed CLI args.
 *
 * Optional fields are only set when defined, to satisfy `exactOptionalPropertyTypes`.
 */
export declare function bootstrapOptions(parsed: ParsedArgs): BootstrapOptions;
