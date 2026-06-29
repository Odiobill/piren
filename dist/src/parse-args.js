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
    "service",
    "agent",
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
    let yes = false;
    let help = false;
    let port;
    let host;
    let token;
    let provider;
    let model;
    let thinking;
    let apiKey;
    let command = "status";
    let positionals = [];
    const passthroughIndex = argv.indexOf("--");
    const pirenArgs = passthroughIndex === -1 ? argv : argv.slice(0, passthroughIndex);
    const piArgs = passthroughIndex === -1 ? [] : argv.slice(passthroughIndex + 1);
    let commandFound = false;
    for (let index = 0; index < pirenArgs.length; index += 1) {
        const arg = pirenArgs[index];
        const readFlagValue = (name) => {
            const equalsPrefix = `${name}=`;
            if (arg === name) {
                index += 1;
                return pirenArgs[index];
            }
            if (arg?.startsWith(equalsPrefix))
                return arg.slice(equalsPrefix.length);
            return undefined;
        };
        const readAnyFlagValue = (names) => {
            for (const name of names) {
                const value = readFlagValue(name);
                if (value !== undefined)
                    return value;
            }
            return undefined;
        };
        const agentDirValue = readFlagValue("--agent-dir");
        const vaultRootValue = agentDirValue === undefined ? readAnyFlagValue(["--vault-root", "--root"]) : undefined;
        const agentValue = agentDirValue === undefined && vaultRootValue === undefined ? readAnyFlagValue(["--agent", "-a"]) : undefined;
        const portValue = agentDirValue === undefined && vaultRootValue === undefined && agentValue === undefined ? readFlagValue("--port") : undefined;
        const hostValue = agentDirValue === undefined && vaultRootValue === undefined && agentValue === undefined && portValue === undefined ? readFlagValue("--host") : undefined;
        const tokenValue = agentDirValue === undefined && vaultRootValue === undefined && agentValue === undefined && portValue === undefined && hostValue === undefined ? readFlagValue("--token") : undefined;
        const providerValue = agentDirValue === undefined && vaultRootValue === undefined && agentValue === undefined && portValue === undefined && hostValue === undefined && tokenValue === undefined ? readFlagValue("--provider") : undefined;
        const modelValue = agentDirValue === undefined && vaultRootValue === undefined && agentValue === undefined && portValue === undefined && hostValue === undefined && tokenValue === undefined && providerValue === undefined ? readFlagValue("--model") : undefined;
        const thinkingValue = agentDirValue === undefined && vaultRootValue === undefined && agentValue === undefined && portValue === undefined && hostValue === undefined && tokenValue === undefined && providerValue === undefined && modelValue === undefined ? readFlagValue("--thinking") : undefined;
        const apiKeyValue = agentDirValue === undefined && vaultRootValue === undefined && agentValue === undefined && portValue === undefined && hostValue === undefined && tokenValue === undefined && providerValue === undefined && modelValue === undefined && thinkingValue === undefined ? readFlagValue("--api-key") : undefined;
        if (agentDirValue !== undefined) {
            agentDir = agentDirValue;
        }
        else if (vaultRootValue !== undefined) {
            vaultRoot = vaultRootValue;
        }
        else if (agentValue !== undefined) {
            agentName = agentValue;
        }
        else if (arg === "--force") {
            force = true;
        }
        else if (arg === "--apply") {
            apply = true;
        }
        else if (arg === "--yes" || arg === "-y") {
            yes = true;
        }
        else if (arg === "-h" || arg === "--help") {
            help = true;
        }
        else if (portValue !== undefined) {
            port = Number(portValue);
        }
        else if (hostValue !== undefined) {
            host = hostValue;
        }
        else if (tokenValue !== undefined) {
            token = tokenValue;
        }
        else if (providerValue !== undefined) {
            provider = providerValue;
        }
        else if (modelValue !== undefined) {
            model = modelValue;
        }
        else if (thinkingValue !== undefined) {
            thinking = thinkingValue;
        }
        else if (apiKeyValue !== undefined) {
            apiKey = apiKeyValue;
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
        yes,
        help,
        port,
        host,
        token,
        provider,
        model,
        thinking,
        apiKey,
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