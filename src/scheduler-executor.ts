import { isAbsolute, relative, resolve } from "node:path";
import { askAgent } from "./ask.js";
import { buildPiRunCommand, type PiRunCommand } from "./run.js";
import type { RpcSpawnTarget } from "./gateway-rpc.js";

// ---------------------------------------------------------------------------
// Claim-scoped inbox task executor (ADR-0029 / O7 S2)
// ---------------------------------------------------------------------------
//
// This is the first bounded execution seam for the O7 scheduler service MVP.
// It executes exactly one *already-claimed* inbox task by building a bounded
// agent prompt and running it through an injected runner, then stops.
//
// It deliberately does NOT implement scheduler claiming, a scheduler loop,
// polling, cron execution, or cross-agent fallback. The next scheduler slice
// is expected to claim a task first (via claimInboxTask) and then call
// executeClaimedInboxTask on the resulting claimed path.

const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const CLAIMED_SUFFIX_PATTERN = /\.claimed\.([a-z][a-z0-9-]*)\.md$/;

function assertValidAgentName(agentName: string): void {
  if (!AGENT_NAME_PATTERN.test(agentName)) {
    throw new Error("Invalid agent name. Use lowercase kebab-case, for example 'piren' or 'research-agent'.");
  }
}

export interface BuildClaimedInboxTaskPromptOptions {
  agentName: string;
  /** Vault-relative claimed task path, e.g. team/<agent>/inbox/<task>.claimed.<device>.md. */
  claimedTaskPath: string;
}

/**
 * Build the bounded prompt for executing one already-claimed inbox task.
 *
 * The prompt explicitly includes the claimed task path and instructs the
 * spawned agent to read it, execute only it, update task status/result, and
 * stop. It forbids polling, claiming/executing other tasks, and cross-agent
 * fallback or rerouting.
 */
export function buildClaimedInboxTaskPrompt(options: BuildClaimedInboxTaskPromptOptions): string {
  const { agentName, claimedTaskPath } = options;
  return [
    `You are agent ${agentName}.`,
    "",
    "A single inbox task has been atomically claimed for this device and assigned to you:",
    "",
    `    ${claimedTaskPath}`,
    "",
    "Execute exactly this one task and then stop. Do the following, in order:",
    "",
    `1. Read the claimed task file at ${claimedTaskPath} using vault_read.`,
    "2. Execute only the work described in that task. Do not claim or execute any other task.",
    "3. Update the task status and result using task_update_status (for example to in_progress while working, then completed or cancelled).",
    "4. Stop after this one work item is complete.",
    "",
    "Hard limits:",
    "- Do not poll the inbox (do not call inbox_list to look for more work).",
    "- Do not claim or execute any other task.",
    "- Do not perform cross-agent fallback or rerouting.",
    "- Do not start any long-running loop.",
    "",
    "When the one task is done, reply with a short summary and stop.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Claimed task path validation
// ---------------------------------------------------------------------------

export interface ClaimedInboxTaskPathInfo {
  /** Validated agent name from the path (matches the input agentName). */
  agentName: string;
  /** Device id parsed from the .claimed.<device-id>.md suffix. */
  deviceId: string;
  /** Base filename without the claimed suffix, e.g. "task-1.md". */
  fileName: string;
  /** The validated vault-relative claimed task path (normalized to the vault root). */
  claimedTaskPath: string;
}

export interface ParseClaimedInboxTaskPathOptions {
  vaultRoot: string;
  agentName: string;
  claimedTaskPath: string;
}

/**
 * Parse and validate a claimed inbox task path.
 *
 * Throws if the path is not a vault-relative Markdown path under exactly
 * `team/<agentName>/inbox/` with a `.claimed.<device-id>.md` suffix, or if it
 * escapes the vault, or if it belongs to a different agent.
 */
export function parseClaimedInboxTaskPath(options: ParseClaimedInboxTaskPathOptions): ClaimedInboxTaskPathInfo {
  assertValidAgentName(options.agentName);
  if (isAbsolute(options.claimedTaskPath)) {
    throw new Error(`Claimed task path must be vault-relative, not absolute: ${options.claimedTaskPath}`);
  }
  const root = resolve(options.vaultRoot);
  const absolutePath = resolve(root, options.claimedTaskPath);
  const rel = relative(root, absolutePath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Claimed task path resolves outside the vault: ${options.claimedTaskPath}`);
  }
  // Normalize backslashes for cross-platform path segments.
  const parts = rel.split(/[\\/]+/);
  if (parts.length !== 4) {
    throw new Error("Claimed task path must point to a Markdown file under team/<agent>/inbox/.");
  }
  const teamSegment = parts[0] ?? "";
  const pathAgent = parts[1] ?? "";
  const inboxSegment = parts[2] ?? "";
  const fileName = parts[3] ?? "";
  if (teamSegment !== "team") {
    throw new Error("Claimed task path must be under team/<agent>/inbox/.");
  }
  if (inboxSegment !== "inbox") {
    throw new Error("Claimed task path must be under team/<agent>/inbox/.");
  }
  assertValidAgentName(pathAgent);
  if (pathAgent !== options.agentName) {
    throw new Error(`Claimed task path belongs to agent '${pathAgent}', not selected agent '${options.agentName}'.`);
  }
  const match = fileName.match(CLAIMED_SUFFIX_PATTERN);
  if (!match) {
    throw new Error(`Claimed task path must end with .claimed.<device-id>.md: ${options.claimedTaskPath}`);
  }
  const deviceId = match[1] ?? "";
  return {
    agentName: pathAgent,
    deviceId,
    fileName: fileName.replace(CLAIMED_SUFFIX_PATTERN, ".md"),
    claimedTaskPath: rel,
  };
}

// ---------------------------------------------------------------------------
// Execution seam
// ---------------------------------------------------------------------------

export interface ClaimedInboxTaskRunInput {
  agentName: string;
  vaultRoot: string;
  prompt: string;
}

export interface ClaimedInboxTaskRunnerResult {
  assistantText: string;
  /** 0 = success, non-zero = failure. Drives the success indicator. */
  exitCode: number;
}

export interface ClaimedInboxTaskRunner {
  run(input: ClaimedInboxTaskRunInput): Promise<ClaimedInboxTaskRunnerResult>;
}

export interface ExecuteClaimedInboxTaskOptions {
  vaultRoot: string;
  agentName: string;
  claimedTaskPath: string;
  runner: ClaimedInboxTaskRunner;
}

export interface ExecuteClaimedInboxTaskResult {
  agentName: string;
  deviceId: string;
  claimedTaskPath: string;
  prompt: string;
  assistantText: string;
  exitCode: number;
  ok: boolean;
  /** Error summary when the runner threw; absent on success. */
  error?: string;
}

/**
 * Execute exactly one already-claimed inbox task through the injected runner.
 *
 * The claimed task path is validated first; if it is rejected the runner is
 * never called and the function throws. Runner failures (thrown errors or
 * non-zero exit codes) are captured as a non-ok result rather than rethrown,
 * so scheduler integration can treat execution outcomes uniformly.
 */
export async function executeClaimedInboxTask(
  options: ExecuteClaimedInboxTaskOptions,
): Promise<ExecuteClaimedInboxTaskResult> {
  const info = parseClaimedInboxTaskPath({
    vaultRoot: options.vaultRoot,
    agentName: options.agentName,
    claimedTaskPath: options.claimedTaskPath,
  });
  const prompt = buildClaimedInboxTaskPrompt({
    agentName: info.agentName,
    claimedTaskPath: info.claimedTaskPath,
  });

  let assistantText = "";
  let exitCode = 0;
  let errorSummary: string | undefined;
  try {
    const runResult = await options.runner.run({
      agentName: info.agentName,
      vaultRoot: resolve(options.vaultRoot),
      prompt,
    });
    assistantText = runResult.assistantText;
    exitCode = runResult.exitCode;
  } catch (error) {
    exitCode = 1;
    errorSummary = error instanceof Error ? error.message : String(error);
  }

  const ok = exitCode === 0 && errorSummary === undefined;
  const result: ExecuteClaimedInboxTaskResult = {
    agentName: info.agentName,
    deviceId: info.deviceId,
    claimedTaskPath: info.claimedTaskPath,
    prompt,
    assistantText,
    exitCode,
    ok,
  };
  if (errorSummary !== undefined) result.error = errorSummary;
  return result;
}

// ---------------------------------------------------------------------------
// Production runner factory (thin glue, reused by the scheduler tick in S4)
// ---------------------------------------------------------------------------

/**
 * Build a Pi RPC spawn target for an agent run. Receives the full runner
 * input so the vault boundary the executor validated against cannot be lost
 * by a custom builder or the default production builder.
 */
export type ClaimedInboxTaskTargetBuilder = (input: ClaimedInboxTaskRunInput) => Promise<RpcSpawnTarget>;

export interface CreateAskRunnerOptions {
  targetBuilder?: ClaimedInboxTaskTargetBuilder;
}

/**
 * Create a production {@link ClaimedInboxTaskRunner} that builds a Pi RPC
 * target per agent run (via `buildPiRunCommand({ rpcMode: true })`, threaded
 * with the validated `vaultRoot` and `agentName`) and runs the bounded prompt
 * through `askAgent`. Live Pi auth is required; this is the seam S4 wires
 * into the scheduler tick. Unit tests inject a fake runner or target builder.
 */
export function createAskRunner(options: CreateAskRunnerOptions = {}): ClaimedInboxTaskRunner {
  const targetBuilder: ClaimedInboxTaskTargetBuilder =
    options.targetBuilder ??
    (async (input: ClaimedInboxTaskRunInput): Promise<RpcSpawnTarget> => {
      const command: PiRunCommand = await buildPiRunCommand({
        cliVaultRoot: input.vaultRoot,
        cliAgent: input.agentName,
        rpcMode: true,
      });
      return {
        command: command.command,
        args: command.args,
        cwd: command.cwd,
        env: command.env,
      };
    });
  return {
    async run(input) {
      const target = await targetBuilder(input);
      const assistantText = await askAgent(target, input.prompt);
      return { assistantText, exitCode: 0 };
    },
  };
}
