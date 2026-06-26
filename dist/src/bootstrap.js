import { access, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "piren", "config.yml");
async function pathExists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
async function readYamlConfig(path) {
    if (!(await pathExists(path)))
        return {};
    const content = await readFile(path, "utf8");
    const parsed = parseYaml(content);
    if (!parsed || typeof parsed !== "object")
        return {};
    return parsed;
}
function normalizeStringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((entry) => typeof entry === "string" && entry.trim() !== "");
}
function assertValidAgentName(agentName) {
    if (!/^[a-z][a-z0-9-]*$/.test(agentName)) {
        throw new Error("Invalid agent name. Use lowercase kebab-case, for example 'piren' or 'research-agent'.");
    }
}
function resolveRequestedAgent(options, env, config) {
    const explicit = options.cliAgent ?? env.PIREN_AGENT;
    if (explicit) {
        assertValidAgentName(explicit);
        return explicit;
    }
    const allowed = normalizeStringArray(config.allowed_agents);
    const excluded = normalizeStringArray(config.excluded_agents);
    const runnable = allowed.filter((agent) => !excluded.includes(agent));
    if (runnable.length === 1)
        return runnable[0];
    if (runnable.length > 1) {
        throw new Error("Multiple runnable agents configured. Pass --agent or set PIREN_AGENT.");
    }
    return undefined;
}
export async function resolveAgentDir(options = {}) {
    const env = options.env ?? process.env;
    const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
    const config = await readYamlConfig(configPath);
    const directCandidate = options.cliAgentDir ?? env.PIREN_AGENT_DIR ?? config.agent_dir;
    if (directCandidate)
        return resolve(directCandidate);
    const vaultRoot = options.cliVaultRoot ?? config.vault_root;
    const agentName = resolveRequestedAgent(options, env, config);
    if (vaultRoot && agentName)
        return resolve(vaultRoot, "team", agentName);
    if (vaultRoot) {
        throw new Error("No Piren agent selected. Pass --agent, set PIREN_AGENT, or configure exactly one allowed_agents entry.");
    }
    throw new Error(`Missing Piren bootstrap config. Pass --agent-dir, set PIREN_AGENT_DIR, or configure vault_root in ${configPath}`);
}
async function detectVaultRoot(agentDir, config, cliVaultRoot) {
    if (cliVaultRoot)
        return resolve(cliVaultRoot);
    if (config.vault_root)
        return resolve(config.vault_root);
    let current = resolve(agentDir);
    while (true) {
        if (await pathExists(join(current, ".piren-vault")))
            return current;
        if ((await pathExists(join(current, "steward-directives.md"))) && (await pathExists(join(current, "team")))) {
            return current;
        }
        const parent = dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    throw new Error(`Could not derive vault root from agent directory: ${agentDir}`);
}
function assertRunnable(agentName, config) {
    const allowed = normalizeStringArray(config.allowed_agents);
    const excluded = normalizeStringArray(config.excluded_agents);
    if (excluded.includes(agentName)) {
        throw new Error(`Agent '${agentName}' is not allowed on this installation: excluded by policy`);
    }
    if (allowed.length > 0 && !allowed.includes(agentName)) {
        throw new Error(`Agent '${agentName}' is not allowed on this installation: not in allowed_agents`);
    }
}
export async function loadPirenContext(options = {}) {
    const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
    const config = await readYamlConfig(configPath);
    const agentDir = await resolveAgentDir(options);
    const agentName = basename(agentDir);
    assertRunnable(agentName, config);
    const vaultRoot = await detectVaultRoot(agentDir, config, options.cliVaultRoot);
    const paths = {
        stewardDirectives: join(vaultRoot, "steward-directives.md"),
        soul: join(agentDir, "SOUL.md"),
        memory: join(agentDir, "MEMORY.md"),
        config: join(agentDir, "config.yml"),
        inbox: join(agentDir, "inbox"),
        outbox: join(agentDir, "outbox"),
        logs: join(agentDir, "logs"),
        sessions: join(agentDir, "sessions"),
    };
    await Promise.all([
        mkdir(paths.inbox, { recursive: true }),
        mkdir(paths.outbox, { recursive: true }),
        mkdir(paths.logs, { recursive: true }),
        mkdir(paths.sessions, { recursive: true }),
    ]);
    const [soul, stewardDirectives] = await Promise.all([
        readFile(paths.soul, "utf8"),
        readFile(paths.stewardDirectives, "utf8"),
    ]);
    return {
        agentName,
        agentDir,
        vaultRoot,
        soul,
        stewardDirectives,
        config,
        allowedAgents: normalizeStringArray(config.allowed_agents),
        excludedAgents: normalizeStringArray(config.excluded_agents),
        packages: normalizeStringArray(config.packages),
        paths,
    };
}
//# sourceMappingURL=bootstrap.js.map