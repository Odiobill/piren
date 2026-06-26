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

export const HELP_TOPICS: readonly CommandHelpTopic[] = [
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
    flags: ["--apply", "--vault-root <path>", "--agent <name>"],
    example: "piren setup --apply --vault-root /tmp/piren-vault --agent piren",
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
    short: "Install/remove/start/stop/restart/status a transport service.",
    flags: ["install", "remove", "start", "stop", "restart", "status", "<gateway|telegram|discord>"],
    example: "piren service install gateway",
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
];

const GLOBAL_FLAGS = ["--vault-root <path>", "--agent <name>", "--agent-dir <path>", "-h, --help"];

/**
 * Detect a help request in a Piren argv slice. Respects the `--` passthrough
 * separator: anything after `--` belongs to Pi and is not a Piren help request.
 */
export function isHelpRequest(argv: string[]): boolean {
  const passthroughIndex = argv.indexOf("--");
  const pirenArgs = passthroughIndex === -1 ? argv : argv.slice(0, passthroughIndex);
  return pirenArgs.includes("-h") || pirenArgs.includes("--help");
}

export function formatHelp(): string {
  const lines: string[] = [];
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

export function formatCommandHelp(command: string): string {
  const topic = HELP_TOPICS.find((t) => t.command === command);
  if (!topic) {
    return `Unknown command: ${command}\n\nRun \`piren --help\` to see available commands.`;
  }
  const lines: string[] = [];
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
