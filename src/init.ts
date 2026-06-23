import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface InitVaultOptions {
  vaultRoot: string;
  agentName?: string;
  force?: boolean;
}

export interface InitVaultResult {
  vaultRoot: string;
  agentName: string;
  agentDir: string;
  created: string[];
}

const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

async function writeNewFile(path: string, content: string, force: boolean, created: string[]): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", flag: force ? "w" : "wx" });
  created.push(path);
}

function titleCaseAgentName(agentName: string): string {
  return agentName
    .split("-")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function initVault(options: InitVaultOptions): Promise<InitVaultResult> {
  const vaultRoot = resolve(options.vaultRoot);
  const agentName = options.agentName ?? "piren";
  const force = options.force ?? false;

  if (!AGENT_NAME_PATTERN.test(agentName)) {
    throw new Error("Invalid agent name. Use lowercase kebab-case, for example 'thor' or 'research-agent'.");
  }

  const agentTitle = titleCaseAgentName(agentName);
  const agentDir = join(vaultRoot, "team", agentName);
  const created: string[] = [];

  await mkdir(vaultRoot, { recursive: true });
  await mkdir(join(vaultRoot, "steward-inbox", "alerts"), { recursive: true });
  await mkdir(join(vaultRoot, "wiki", "concepts"), { recursive: true });
  await mkdir(join(vaultRoot, "wiki", "entities"), { recursive: true });
  await mkdir(join(vaultRoot, "wiki", "runbooks"), { recursive: true });
  await mkdir(join(vaultRoot, "wiki", "inbox"), { recursive: true });
  await mkdir(join(vaultRoot, "skills"), { recursive: true });
  await mkdir(join(vaultRoot, "templates"), { recursive: true });
  await mkdir(join(agentDir, "inbox"), { recursive: true });
  await mkdir(join(agentDir, "outbox"), { recursive: true });
  await mkdir(join(agentDir, "devices"), { recursive: true });
  await mkdir(join(agentDir, "logs"), { recursive: true });
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await mkdir(join(agentDir, "skills"), { recursive: true });

  try {
    await writeNewFile(join(vaultRoot, ".piren-vault"), "", force, created);
    await writeNewFile(
      join(vaultRoot, "steward-directives.md"),
      [
        "# Steward Directives",
        "",
        "This Piren vault is initialized for local-first agent operation.",
        "Keep actions explicit, inspectable, and boring.",
        "Use vault_read and vault_write for vault access.",
        "",
      ].join("\n"),
      force,
      created,
    );
    await writeNewFile(
      join(agentDir, "SOUL.md"),
      [
        `# ${agentTitle}`,
        "",
        `You are ${agentTitle}, a Piren agent defined by this vault directory.`,
        "Operate from the vault, respect steward directives, and keep state human-readable.",
        "",
      ].join("\n"),
      force,
      created,
    );
    await writeNewFile(join(agentDir, "MEMORY.md"), `# ${agentTitle} Memory\n\nNo durable memories yet.\n`, force, created);
    await writeNewFile(
      join(agentDir, "config.yml"),
      [
        "# Agent-local Piren preferences.",
        "# Installation authority lives in ~/.config/piren/config.yml, not here.",
        "model: {}",
        "poll_interval_active_seconds: 60",
        "poll_interval_idle_seconds: 300",
        "",
      ].join("\n"),
      force,
      created,
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error("Piren vault file already exists. Re-run with --force to overwrite generated files.");
    }
    throw error;
  }

  return { vaultRoot, agentName, agentDir, created };
}
