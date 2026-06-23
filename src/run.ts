import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { loadPirenContext, type BootstrapOptions } from "./bootstrap.js";

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
}

export interface PiRunCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
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
  const extensionPath = options.extensionPath ?? "./src/pi-extension.ts";
  const extraArgs = options.extraArgs ?? [];

  const args = [
    "pi",
    "--extension",
    extensionPath,
    "--vault-root",
    context.vaultRoot,
    "--agent",
    context.agentName,
  ];

  const primaryModel = formatPiModel(agentConfig.model);
  const models = formatPiModels(agentConfig.models);
  if (primaryModel) {
    args.push("--model", primaryModel);
  }
  if (models) {
    args.push("--models", models);
  }
  args.push(...extraArgs);

  return {
    command: "npx",
    args,
    cwd: process.cwd(),
    env: options.workerMode ? { ...process.env, PIREN_WORKER: "1" } : process.env,
  };
}

export async function spawnPiRun(options: BuildPiRunCommandOptions = {}): Promise<number> {
  const command = await buildPiRunCommand(options);
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    env: command.env,
    stdio: "inherit",
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
