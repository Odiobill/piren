import { access, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
function uniquePreservingOrder(values) {
    return Array.from(new Set(values));
}
function sorted(values) {
    return [...values].sort((a, b) => a.localeCompare(b));
}
async function readVaultAgents(vaultRoot) {
    const teamDir = join(vaultRoot, "team");
    if (!(await pathExists(teamDir)))
        return [];
    const entries = await readdir(teamDir, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
}
async function readStaleVaultAgents(vaultRoot, vaultAgents) {
    const stale = [];
    for (const agent of vaultAgents) {
        const agentDir = join(vaultRoot, "team", agent);
        const hasSoul = await pathExists(join(agentDir, "SOUL.md"));
        const hasMemory = await pathExists(join(agentDir, "MEMORY.md"));
        if (!hasSoul || !hasMemory) {
            stale.push(agent);
        }
    }
    return stale;
}
export async function listPirenAgents(options = {}) {
    const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
    const config = await readYamlConfig(configPath);
    const vaultRoot = options.cliVaultRoot ?? config.vault_root;
    const allowedAgents = uniquePreservingOrder(normalizeStringArray(config.allowed_agents));
    const excludedAgents = uniquePreservingOrder(normalizeStringArray(config.excluded_agents));
    const resolvedVaultRoot = vaultRoot === undefined ? undefined : resolve(vaultRoot);
    const vaultAgents = resolvedVaultRoot === undefined ? [] : await readVaultAgents(resolvedVaultRoot);
    const staleVaultAgents = resolvedVaultRoot === undefined ? [] : await readStaleVaultAgents(resolvedVaultRoot, vaultAgents);
    const healthyVaultAgents = vaultAgents.filter((agent) => !staleVaultAgents.includes(agent));
    const runnableSource = allowedAgents.length > 0 ? allowedAgents : healthyVaultAgents;
    const runnableAgents = sorted(uniquePreservingOrder(runnableSource.filter((agent) => !excludedAgents.includes(agent) && healthyVaultAgents.includes(agent))));
    const missingAllowedAgents = uniquePreservingOrder(allowedAgents.filter((agent) => !vaultAgents.includes(agent)));
    const report = {
        vaultAgents,
        allowedAgents,
        excludedAgents,
        runnableAgents,
        missingAllowedAgents,
    };
    if (allowedAgents.length === 0 && vaultRoot !== undefined)
        report.unsafePolicy = true;
    if (staleVaultAgents.length > 0)
        report.staleVaultAgents = staleVaultAgents;
    if (resolvedVaultRoot !== undefined)
        report.vaultRoot = resolvedVaultRoot;
    return report;
}
export function formatAgentsReport(report) {
    const lines = ["Piren agents"];
    if (report.vaultRoot)
        lines.push(`vault_root: ${report.vaultRoot}`);
    lines.push(`allowed_agents: ${report.allowedAgents.length ? report.allowedAgents.join(", ") : "<not set>"}`);
    lines.push(`excluded_agents: ${report.excludedAgents.length ? report.excludedAgents.join(", ") : "<not set>"}`);
    if (report.unsafePolicy) {
        lines.push("");
        lines.push("WARNING: no allowed_agents configured. Any vault agent with a team/ directory can run on this installation.");
    }
    lines.push("");
    lines.push("vault-defined:");
    if (report.vaultAgents.length === 0) {
        lines.push("  <none>");
    }
    else {
        for (const agent of report.vaultAgents) {
            const isStale = report.staleVaultAgents?.includes(agent);
            const label = report.runnableAgents.includes(agent) ? "runnable" : isStale ? "stale" : "vault-only";
            lines.push(`  [${label}] ${agent}`);
        }
    }
    if (report.missingAllowedAgents.length > 0) {
        lines.push("");
        lines.push("allowed-but-missing:");
        for (const agent of report.missingAllowedAgents)
            lines.push(`  [missing] ${agent}`);
    }
    return lines.join("\n");
}
//# sourceMappingURL=agents.js.map