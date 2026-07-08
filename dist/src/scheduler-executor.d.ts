import type { RpcSpawnTarget } from "./gateway-rpc.js";
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
export declare function buildClaimedInboxTaskPrompt(options: BuildClaimedInboxTaskPromptOptions): string;
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
export declare function parseClaimedInboxTaskPath(options: ParseClaimedInboxTaskPathOptions): ClaimedInboxTaskPathInfo;
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
export declare function executeClaimedInboxTask(options: ExecuteClaimedInboxTaskOptions): Promise<ExecuteClaimedInboxTaskResult>;
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
export declare function createAskRunner(options?: CreateAskRunnerOptions): ClaimedInboxTaskRunner;
