#!/usr/bin/env node
import { type BootstrapOptions, loadPirenContext } from "./bootstrap.js";
import { formatAgentsReport, listPirenAgents } from "./agents.js";
import { doctorPiren, formatDoctorReport } from "./doctor.js";
import { initVault } from "./init.js";
import { spawnPiRun } from "./run.js";
import { formatSetupReport, setupPiren } from "./setup.js";

function parseArgs(argv: string[]) {
  let agentDir: string | undefined;
  let vaultRoot: string | undefined;
  let agentName: string | undefined;
  let force = false;
  let apply = false;
  let command = "status";
  const passthroughIndex = argv.indexOf("--");
  const pirenArgs = passthroughIndex === -1 ? argv : argv.slice(0, passthroughIndex);
  const piArgs = passthroughIndex === -1 ? [] : argv.slice(passthroughIndex + 1);

  for (let index = 0; index < pirenArgs.length; index += 1) {
    const arg = pirenArgs[index];
    if (arg === "--agent-dir") {
      agentDir = pirenArgs[index + 1];
      index += 1;
    } else if (arg === "--vault-root" || arg === "--root") {
      vaultRoot = pirenArgs[index + 1];
      index += 1;
    } else if (arg === "--agent" || arg === "-a") {
      agentName = pirenArgs[index + 1];
      index += 1;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg && !arg.startsWith("-")) {
      command = arg;
    }
  }
  return { agentDir, agentName, command, force, vaultRoot, piArgs, apply };
}

function bootstrapOptions(parsed: { agentDir?: string | undefined; agentName?: string | undefined; vaultRoot?: string | undefined }): BootstrapOptions {
  const options: BootstrapOptions = { env: process.env };
  if (parsed.agentDir !== undefined) options.cliAgentDir = parsed.agentDir;
  if (parsed.agentName !== undefined) options.cliAgent = parsed.agentName;
  if (parsed.vaultRoot !== undefined) options.cliVaultRoot = parsed.vaultRoot;
  return options;
}

const parsed = parseArgs(process.argv.slice(2));
const { agentDir, agentName, command, force, vaultRoot, piArgs } = parsed;

if (command !== "status" && command !== "agents" && command !== "doctor" && command !== "init" && command !== "run" && command !== "worker" && command !== "setup") {
  console.error("Usage: piren [init|status|agents|doctor|setup|run|worker] [--vault-root /path/to/vault] [--agent thor] [--agent-dir /path/to/vault/team/agent] [--force] [-- pi-args...]");
  process.exit(2);
}

try {
  if (command === "init") {
    const initOptions = agentName === undefined
      ? { vaultRoot: vaultRoot ?? process.cwd(), force }
      : { vaultRoot: vaultRoot ?? process.cwd(), agentName, force };
    const result = await initVault(initOptions);
    console.log("Piren vault initialized");
    console.log(`vault_root: ${result.vaultRoot}`);
    console.log(`agent_name: ${result.agentName}`);
    console.log(`agent_dir: ${result.agentDir}`);
    console.log("");
    console.log("Configure ~/.config/piren/config.yml:");
    console.log("vault_root: " + result.vaultRoot);
    console.log("allowed_agents:");
    console.log(`  - ${result.agentName}`);
    console.log("");
    console.log("Then test with:");
    console.log(`PIREN_AGENT=${result.agentName} piren status`);
    console.log(`PIREN_AGENT=${result.agentName} piren run`);
  } else if (command === "run" || command === "worker") {
    const exitCode = await spawnPiRun({ ...bootstrapOptions(parsed), extraArgs: piArgs, workerMode: command === "worker" });
    process.exit(exitCode);
  } else if (command === "doctor") {
    const report = await doctorPiren(bootstrapOptions(parsed));
    console.log(formatDoctorReport(report));
    if (!report.ok) process.exit(1);
  } else if (command === "agents") {
    const report = await listPirenAgents(bootstrapOptions(parsed));
    console.log(formatAgentsReport(report));
  } else if (command === "setup") {
    const report = await setupPiren({ ...bootstrapOptions(parsed), apply: parsed.apply });
    console.log(formatSetupReport(report));
    if (report.checks.some((check) => check.status === "fail")) process.exit(1);
  } else {
    const context = await loadPirenContext(bootstrapOptions(parsed));
    console.log(`Piren ${command}`);
    console.log(`agent_name: ${context.agentName}`);
    console.log(`agent_dir: ${context.agentDir}`);
    console.log(`vault_root: ${context.vaultRoot}`);
    console.log(`allowed_agents: ${context.allowedAgents.length ? context.allowedAgents.join(", ") : "<not set>"}`);
    console.log(`excluded_agents: ${context.excludedAgents.length ? context.excludedAgents.join(", ") : "<not set>"}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
