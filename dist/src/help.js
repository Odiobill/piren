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
export const HELP_TOPICS = [
    {
        command: "status",
        short: "Show the resolved agent, vault, and policy for this installation (default command).",
        example: "piren status --vault-root /path/to/vault --agent piren",
    },
    {
        command: "init",
        short: "Initialize a new Piren vault and its first agent directory.",
        flags: ["--vault-root <path>", "--agent <name>", "--force"],
        example: "piren init --vault-root /tmp/piren-vault --agent piren",
    },
    {
        command: "setup",
        short: "Interactive setup wizard, or batch scaffold with --apply.",
        flags: ["--apply", "--vault-root <path>", "--agent <name>", "--provider <id>", "--model <id>", "--thinking <level>", "--api-key <key>"],
        example: "piren setup --apply --vault-root /tmp/piren-vault --agent piren --provider anthropic --model claude-sonnet-4-6 --thinking medium",
    },
    {
        command: "agents",
        short: "List runnable agents for this installation.",
    },
    {
        command: "doctor",
        short: "Run health checks: bootstrap, vault layout, Pi runtime, packages, transports.",
    },
    {
        command: "run",
        short: "Start an interactive Pi-backed Piren agent (alias: chat).",
        flags: ["-- pi-args..."],
        example: "piren run --vault-root /tmp/piren-vault --agent piren",
    },
    {
        command: "chat",
        short: "Alias for run.",
    },
    {
        command: "worker",
        short: "Start the agent in opt-in worker mode (PIREN_WORKER=1 behavior).",
    },
    {
        command: "gateway",
        short: "Start the local web gateway (alias: web).",
        flags: ["--port <n>", "--host <addr>", "--token <token>"],
        example: "piren gateway --port 7317 --host 127.0.0.1",
    },
    {
        command: "web",
        short: "Alias for gateway.",
    },
    {
        command: "telegram",
        short: "Start the Telegram transport (requires telegram config block).",
    },
    {
        command: "discord",
        short: "Start the Discord transport (requires discord config block).",
    },
    {
        command: "ask",
        short: "Send a one-shot message and print the streamed response.",
        example: 'piren ask "Summarize the vault index"',
    },
    {
        command: "service",
        short: "Install/remove/start/stop/restart/status a service target (gateway, telegram, discord, scheduler).",
        flags: ["install", "remove", "start", "stop", "restart", "status", "<gateway|telegram|discord|scheduler>", "--method <auto|systemd|tmux-cron>"],
        example: "piren service install telegram --method tmux-cron",
    },
    {
        command: "agent",
        short: "Manage agent identities and permissions: add, remove, clone, list.",
        flags: ["add <name>", "remove <name>", "clone <source> <name>", "list", "--force", "--yes"],
        example: "piren agent add thor",
    },
    {
        command: "clean",
        short: "Dry-run (or with --force, actually remove) local Piren state.",
        flags: ["--force"],
        example: "piren clean --force",
    },
    {
        command: "version",
        short: "Print the installed Piren version.",
    },
    {
        command: "update",
        short: "Update the global Piren install from GitHub.",
        example: "piren update  # runs npm install -g --install-links github:Odiobill/piren",
    },
    {
        command: "package",
        short: "Vault-scoped package manifests: list, explain, or doctor (read-only).",
        flags: ["<list|explain|doctor>", "--agent <agent>"],
        example: "piren package list --agent piren",
    },
    {
        command: "scheduler",
        short: "Device-local scheduler. Bare runs the opt-in loop; --once runs one bounded tick; --dry-run previews planned claims (LLM-free).",
        flags: ["--once", "--dry-run"],
        example: "piren scheduler  # opt-in loop until SIGINT/SIGTERM (configure under scheduler: in config.yml)",
    },
    {
        command: "group",
        short: "Manage agent group configs (vault-owned): list, show, create, add-agent, remove-agent, fallback set, validate.",
        flags: ["<list|show|create|add-agent|remove-agent|fallback set|validate>", "<group>", "<agent>", "<candidate...>", "--force"],
        example: "piren group create developers && piren group add-agent developers dipu",
    },
    {
        command: "cron",
        short: "Manage vault-backed cron jobs: list, show, create, create-script, enable, disable, runs, validate.",
        flags: ["<list|show|create|create-script|enable|disable|runs|validate>", "<id>", "--agent <agent>", "--schedule <expr>", "--body <file>", "--script <vault-path>", "--force"],
        example: "piren cron list && piren cron create nightly-digest --agent piren --schedule '0 7 * * *'",
    },
    {
        command: "skill",
        short: "Manage vault skills: list, show, explain, create, move, promote, demote, conflicts, validate, and staged local import (inactive until a later promotion slice).",
        flags: ["<list|show|explain|create|move|promote|demote|conflicts|validate>", "import <local-file.md> --staged [--name <slug>] [--force]", "staged <list|show> <name>", "<name>", "--agent <agent>", "--group <group>", "--scope shared|group:<name>|agent:<name>", "--from <scope>", "--to <scope>", "--force"],
        example: "piren skill list --agent dipu && piren skill import ./external.md --staged && piren skill staged list",
    },
    {
        command: "task",
        short: "Human-facing inbox task CLI: list, send, show, claim, complete, cancel. No polling, no scheduler changes.",
        flags: ["<list|send|show|claim|complete|cancel>", "<agent>", "<title>", "<path-or-id>", "--agent <agent>", "--body <vault-file>", "--result <vault-file>", "--priority normal|high|urgent", "--device <id>"],
        example: "piren task send dipu \"Ship rc.4\" --priority high && piren task list --agent dipu",
    },
];
const GLOBAL_FLAGS = ["--vault-root <path>", "--agent <name>", "--agent-dir <path>", "-h, --help"];
/**
 * Detect a help request in a Piren argv slice. Respects the `--` passthrough
 * separator: anything after `--` belongs to Pi and is not a Piren help request.
 */
export function isHelpRequest(argv) {
    const passthroughIndex = argv.indexOf("--");
    const pirenArgs = passthroughIndex === -1 ? argv : argv.slice(0, passthroughIndex);
    return pirenArgs.includes("-h") || pirenArgs.includes("--help");
}
export function formatHelp() {
    const lines = [];
    lines.push("Piren: lightweight, local-first agent runtime on top of Pi Coding Agent.");
    lines.push("");
    lines.push("Usage: piren <command> [options]");
    lines.push("");
    lines.push("Commands:");
    const commandWidth = Math.max(...HELP_TOPICS.map((t) => t.command.length));
    for (const topic of HELP_TOPICS) {
        lines.push(`  ${topic.command.padEnd(commandWidth)}  ${topic.short}`);
    }
    lines.push("");
    lines.push("Global options:");
    for (const flag of GLOBAL_FLAGS) {
        lines.push(`  ${flag}`);
    }
    lines.push("");
    lines.push("Run `piren <command> --help` for command-specific usage and examples.");
    return lines.join("\n");
}
export function formatCommandHelp(command) {
    const topic = HELP_TOPICS.find((t) => t.command === command);
    if (!topic) {
        return `Unknown command: ${command}\n\nRun \`piren --help\` to see available commands.`;
    }
    const lines = [];
    lines.push(`piren ${topic.command}`);
    lines.push("");
    lines.push(topic.short);
    lines.push("");
    const flags = topic.flags ?? [];
    if (flags.length > 0) {
        lines.push("Options:");
        for (const flag of flags) {
            lines.push(`  ${flag}`);
        }
        lines.push("");
    }
    if (topic.example) {
        lines.push("Example:");
        lines.push(`  ${topic.example}`);
        lines.push("");
    }
    return lines.join("\n");
}
//# sourceMappingURL=help.js.map