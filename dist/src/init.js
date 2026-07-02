import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
async function writeNewFile(path, content, force, created) {
    await writeFile(path, content, { encoding: "utf8", flag: force ? "w" : "wx" });
    created.push(path);
}
function defaultAgentConfigContent() {
    return [
        "# Agent-local Piren preferences.",
        "# Installation authority lives in ~/.config/piren/config.yml, not here.",
        "# No model is configured yet. Add a model block here or run setup --apply with --provider and --model.",
        "# Example:",
        "# model:",
        "#   id: anthropic/claude-sonnet-4-6",
        "#   thinking: medium",
        "# Polling is used by `piren worker` only. Interactive `piren run` does not auto-poll inboxes.",
        "poll_interval_active_seconds: 60",
        "poll_interval_idle_seconds: 300",
        "",
    ].join("\n");
}
function titleCaseAgentName(agentName) {
    return agentName
        .split("-")
        .filter(Boolean)
        .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
        .join(" ");
}
function defaultSoulContent(agentTitle) {
    return [
        `# ${agentTitle}`,
        "",
        `You are ${agentTitle}, a Piren agent defined by this vault directory.`,
        "Operate from the vault, respect steward directives, and keep state human-readable.",
        "",
        "When importing existing project material, preserve project-specific working docs under Projects/<Project>/ with OKF frontmatter, but also promote reusable concepts into wiki/concepts/ and people, systems, services, or products into wiki/entities/ using wiki_update_concept and wiki_update_entity.",
        "Do not just copy an old folder tree when the steward asks for structured Piren vault import. Create linked OKF documents so the Knowledge Graph has useful nodes and edges.",
        "",
    ].join("\n");
}
export async function initVault(options) {
    const vaultRoot = resolve(options.vaultRoot);
    const agentName = options.agentName ?? "piren";
    const force = options.force ?? false;
    if (!AGENT_NAME_PATTERN.test(agentName)) {
        throw new Error("Invalid agent name. Use lowercase kebab-case, for example 'thor' or 'research-agent'.");
    }
    const agentTitle = titleCaseAgentName(agentName);
    const agentDir = join(vaultRoot, "team", agentName);
    const created = [];
    await mkdir(vaultRoot, { recursive: true });
    await mkdir(join(vaultRoot, "Projects"), { recursive: true });
    await mkdir(join(vaultRoot, "steward-inbox", "alerts"), { recursive: true });
    await mkdir(join(vaultRoot, "wiki", "concepts"), { recursive: true });
    await mkdir(join(vaultRoot, "wiki", "entities"), { recursive: true });
    await mkdir(join(vaultRoot, "wiki", "runbooks"), { recursive: true });
    await mkdir(join(vaultRoot, "wiki", "inbox"), { recursive: true });
    await mkdir(join(vaultRoot, "skills"), { recursive: true });
    await mkdir(join(vaultRoot, "templates"), { recursive: true });
    await mkdir(join(vaultRoot, "team", "groups"), { recursive: true });
    await mkdir(join(agentDir, "inbox"), { recursive: true });
    await mkdir(join(agentDir, "outbox"), { recursive: true });
    await mkdir(join(agentDir, "devices"), { recursive: true });
    await mkdir(join(agentDir, "logs"), { recursive: true });
    await mkdir(join(agentDir, "sessions"), { recursive: true });
    await mkdir(join(agentDir, "skills"), { recursive: true });
    try {
        await writeNewFile(join(vaultRoot, ".piren-vault"), "", force, created);
        await writeNewFile(join(vaultRoot, "steward-directives.md"), [
            "# Steward Directives",
            "",
            "This Piren vault is initialized for local-first agent operation.",
            "Keep actions explicit, inspectable, and boring.",
            "Use vault_read and vault_write for vault access.",
            "Use OKF frontmatter with a non-empty type field for durable Markdown knowledge.",
            "Use wiki_update_concept and wiki_update_entity when project material contains reusable concepts or named systems that should appear in the Knowledge Graph.",
            "",
        ].join("\n"), force, created);
        await writeNewFile(join(agentDir, "SOUL.md"), defaultSoulContent(agentTitle), force, created);
        await writeNewFile(join(agentDir, "MEMORY.md"), `# ${agentTitle} Memory\n\nNo durable memories yet.\n`, force, created);
        await writeNewFile(join(agentDir, "config.yml"), defaultAgentConfigContent(), force, created);
    }
    catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
            throw new Error("Piren vault file already exists. Re-run with --force to overwrite generated files.");
        }
        throw error;
    }
    return { vaultRoot, agentName, agentDir, created };
}
/**
 * Scaffold a single agent directory (team/<agent>/) inside an EXISTING vault,
 * without re-initializing the vault itself. Used by `piren agent add` so adding
 * a second agent does not trip initVault's "vault file already exists" guard.
 *
 * Creates the same subdirectories and identity files initVault writes for a
 * fresh agent: inbox/outbox/devices/logs/sessions/skills, plus SOUL.md,
 * MEMORY.md, and config.yml. Respects `force` to overwrite identity files.
 */
export async function scaffoldAgentDirectory(options) {
    const vaultRoot = resolve(options.vaultRoot);
    const agentName = options.agentName ?? "piren";
    const force = options.force ?? false;
    if (!AGENT_NAME_PATTERN.test(agentName)) {
        throw new Error("Invalid agent name. Use lowercase kebab-case, for example 'thor' or 'research-agent'.");
    }
    const agentTitle = titleCaseAgentName(agentName);
    const agentDir = join(vaultRoot, "team", agentName);
    const created = [];
    await mkdir(join(agentDir, "inbox"), { recursive: true });
    await mkdir(join(agentDir, "outbox"), { recursive: true });
    await mkdir(join(agentDir, "devices"), { recursive: true });
    await mkdir(join(agentDir, "logs"), { recursive: true });
    await mkdir(join(agentDir, "sessions"), { recursive: true });
    await mkdir(join(agentDir, "skills"), { recursive: true });
    await writeNewFile(join(agentDir, "SOUL.md"), defaultSoulContent(agentTitle), force, created);
    await writeNewFile(join(agentDir, "MEMORY.md"), `# ${agentTitle} Memory\n\nNo durable memories yet.\n`, force, created);
    await writeNewFile(join(agentDir, "config.yml"), defaultAgentConfigContent(), force, created);
    return { vaultRoot, agentName, agentDir, created };
}
//# sourceMappingURL=init.js.map