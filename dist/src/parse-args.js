/** Commands the CLI recognizes as the first non-flag positional. */
export const KNOWN_COMMANDS = [
    "status",
    "agents",
    "doctor",
    "init",
    "run",
    "worker",
    "setup",
    "gateway",
    "web",
    "telegram",
    "discord",
    "ask",
    "chat",
    "clean",
    "version",
];
/**
 * Parse Piren CLI arguments (typically `process.argv.slice(2)`).
 *
 * Returns the structured parse result. Does NOT validate the command: an
 * unknown first positional is returned as `command` unchanged, and the caller
 * is responsible for rejecting it (this preserves the historical "unknown
 * command" exit-2 path in the CLI).
 */
export function parseArgs(argv) {
    let agentDir;
    let vaultRoot;
    let agentName;
    let force = false;
    let apply = false;
    let port;
    let host;
    let token;
    let command = "status";
    let positionals = [];
    const passthroughIndex = argv.indexOf("--");
    const pirenArgs = passthroughIndex === -1 ? argv : argv.slice(0, passthroughIndex);
    const piArgs = passthroughIndex === -1 ? [] : argv.slice(passthroughIndex + 1);
    let commandFound = false;
    for (let index = 0; index < pirenArgs.length; index += 1) {
        const arg = pirenArgs[index];
        if (arg === "--agent-dir") {
            agentDir = pirenArgs[index + 1];
            index += 1;
        }
        else if (arg === "--vault-root" || arg === "--root") {
            vaultRoot = pirenArgs[index + 1];
            index += 1;
        }
        else if (arg === "--agent" || arg === "-a") {
            agentName = pirenArgs[index + 1];
            index += 1;
        }
        else if (arg === "--force") {
            force = true;
        }
        else if (arg === "--apply") {
            apply = true;
        }
        else if (arg === "--port") {
            port = Number(pirenArgs[index + 1]);
            index += 1;
        }
        else if (arg === "--host") {
            host = pirenArgs[index + 1];
            index += 1;
        }
        else if (arg === "--token") {
            token = pirenArgs[index + 1];
            index += 1;
        }
        else if (arg && !arg.startsWith("-")) {
            // First non-flag token is the command. After the command, every further
            // non-flag token is a positional. Flag values are consumed by the flag
            // branches above, so they never reach here.
            //
            // Do NOT break: flags may legitimately appear after the command
            // (e.g. `piren clean --force`, `piren gateway --port 7317`), and they
            // must still be scanned in the later iterations.
            if (!commandFound) {
                command = arg;
                commandFound = true;
            }
            else {
                positionals.push(arg);
            }
        }
    }
    return {
        agentDir,
        agentName,
        command,
        force,
        vaultRoot,
        piArgs,
        apply,
        port,
        host,
        token,
        positionals,
    };
}
/**
 * Build a BootstrapOptions object from parsed CLI args.
 *
 * Optional fields are only set when defined, to satisfy `exactOptionalPropertyTypes`.
 */
export function bootstrapOptions(parsed) {
    const options = { env: process.env };
    if (parsed.agentDir !== undefined)
        options.cliAgentDir = parsed.agentDir;
    if (parsed.agentName !== undefined)
        options.cliAgent = parsed.agentName;
    if (parsed.vaultRoot !== undefined)
        options.cliVaultRoot = parsed.vaultRoot;
    return options;
}
//# sourceMappingURL=parse-args.js.map