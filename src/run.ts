import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadPirenContext, type BootstrapOptions } from "./bootstrap.js";
import { resolvePackages, defaultPackageResolver, type PackageEntryResolver } from "./packages.js";

const thisDir = dirname(fileURLToPath(import.meta.url));

// Resolve the Pi extension relative to this module's location so it works
// whether the CLI runs from compiled dist/ (npm global install) or from
// source via tsx during smoke tests. Overridable via the `extensionPath`
// option so tests can inject a repo-relative path.
function resolveExtensionPath(): string {
  return join(thisDir, "pi-extension.js");
}

interface AgentModelConfig {
  provider?: unknown;
  id?: unknown;
  thinking?: unknown;
}

interface AgentRunConfig {
  model?: unknown;
  models?: unknown;
}

export interface BuildPiRunCommandOptions extends BootstrapOptions {
  extraArgs?: string[] | undefined;
  extensionPath?: string | undefined;
  workerMode?: boolean | undefined;
  rpcMode?: boolean | undefined;
  packageResolver?: PackageEntryResolver | undefined;
}

export interface PiRunCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: "inherit" | "pipe";
}

function normalizeThinking(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function normalizeModelId(model: AgentModelConfig): string | undefined {
  if (typeof model.id !== "string" || model.id.trim() === "") return undefined;
  const id = model.id.trim();
  if (typeof model.provider === "string" && model.provider.trim() !== "" && !id.includes("/")) {
    return `${model.provider.trim()}/${id}`;
  }
  return id;
}

export function formatPiModel(model: unknown): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  const modelConfig = model as AgentModelConfig;
  const id = normalizeModelId(modelConfig);
  if (!id) return undefined;
  const thinking = normalizeThinking(modelConfig.thinking);
  return thinking ? `${id}:${thinking}` : id;
}

function formatPiModels(models: unknown): string | undefined {
  if (!Array.isArray(models)) return undefined;
  const formatted = models.map((model) => formatPiModel(model)).filter((model): model is string => Boolean(model));
  return formatted.length > 0 ? formatted.join(",") : undefined;
}

async function readAgentRunConfig(configPath: string): Promise<AgentRunConfig> {
  const content = await readFile(configPath, "utf8");
  const parsed = parseYaml(content) as unknown;
  if (!parsed || typeof parsed !== "object") return {};
  return parsed as AgentRunConfig;
}

export async function buildPiRunCommand(options: BuildPiRunCommandOptions = {}): Promise<PiRunCommand> {
  const context = await loadPirenContext(options);
  const agentConfig = await readAgentRunConfig(context.paths.config);
  const extensionPath = options.extensionPath ?? resolveExtensionPath();
  const extraArgs = options.extraArgs ?? [];
  const rpcMode = options.rpcMode ?? false;
  const resolver = options.packageResolver ?? defaultPackageResolver;

  const args = [
    "pi",
    "--extension",
    extensionPath,
    "--vault-root",
    context.vaultRoot,
    "--agent",
    context.agentName,
  ];

  // ADR-0013: resolve declared packages to their entry points and append
  // each as an additional --extension flag. Piren's core extension loads
  // first; package extensions load after in declaration order. Missing
  // packages are skipped (piren doctor reports them separately).
  const { resolved: packageExtensions } = resolvePackages(context.packages, resolver);
  for (const pkg of packageExtensions) {
    args.push("--extension", pkg.path);
  }

  const primaryModel = formatPiModel(agentConfig.model);
  const models = formatPiModels(agentConfig.models);
  if (primaryModel) {
    args.push("--model", primaryModel);
  }
  if (models) {
    args.push("--models", models);
  }
  if (rpcMode) {
    args.push("--mode", "rpc");
  }
  args.push(...extraArgs);

  const env = options.workerMode ? { ...process.env, PIREN_WORKER: "1" } : process.env;

  return {
    command: "npx",
    args,
    cwd: process.cwd(),
    env,
    stdio: rpcMode ? "pipe" : "inherit",
  };
}

export async function spawnPiRun(options: BuildPiRunCommandOptions = {}): Promise<number> {
  const command = await buildPiRunCommand(options);
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    env: command.env,
    stdio: command.stdio,
  });

  return await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        resolve(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 0));
      } else {
        resolve(code ?? 0);
      }
    });
  });
}
