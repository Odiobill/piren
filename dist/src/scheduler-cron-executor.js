import { isAbsolute, relative, resolve } from "node:path";
import { readCronJob, recordCronRun, } from "./cron.js";
// ---------------------------------------------------------------------------
// Claim-scoped agent-mode cron job executor (ADR-0029 / O7 S3)
// ---------------------------------------------------------------------------
//
// Cron counterpart to src/scheduler-executor.ts (S2). It executes exactly one
// *already-claimed agent-mode* cron job by building a bounded agent prompt,
// running it through an injected runner, then recording one visible cron run
// through the existing cron run machinery (which also restores the job).
//
// It deliberately does NOT implement scheduler --once, a loop, service
// lifecycle, claim planning, or cross-agent fallback. Script-mode cron jobs
// are NOT executed here: they stay on the existing direct executor
// `executeScriptCronJob` in src/cron.ts. This executor refuses script-mode
// jobs so the two paths cannot be confused.
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const CLAIMED_SUFFIX_PATTERN = /\.claimed\.([a-z][a-z0-9-]*)\.md$/;
function assertValidAgentName(agentName) {
    if (!AGENT_NAME_PATTERN.test(agentName)) {
        throw new Error("Invalid agent name. Use lowercase kebab-case, for example 'piren' or 'research-agent'.");
    }
}
/**
 * Build the bounded prompt for executing one already-claimed agent-mode cron
 * job.
 *
 * Includes the exact claimed cron job path, the job id, and the cron prompt to
 * execute. Instructs the agent to execute only this cron job and stop, and
 * forbids polling (`cron_list`/`inbox_list`), claiming (`cron_claim`/
 * `task_claim`), calling `cron_record_run` (the scheduler records the run),
 * cross-agent fallback/rerouting, and long-running loops.
 */
export function buildClaimedCronJobPrompt(options) {
    const { agentName, jobId, claimedJobPath, cronPrompt } = options;
    return [
        `You are agent ${agentName}.`,
        "",
        "A single agent-mode cron job has been atomically claimed for this device and assigned to you:",
        "",
        `    ${claimedJobPath}`,
        "",
        `Cron job id: ${jobId}`,
        "",
        "Execute exactly this one cron job and then stop.",
        "",
        "Cron prompt to execute:",
        "",
        "----",
        cronPrompt,
        "----",
        "",
        "Hard limits:",
        "- Execute only this cron job. Do not claim or execute any other cron job or inbox task.",
        "- Do not poll for work (do not call cron_list or inbox_list).",
        "- Do not claim work (do not call cron_claim or task_claim).",
        "- Do not call cron_record_run; the scheduler records this run visibly on your behalf.",
        "- Do not perform cross-agent fallback or rerouting.",
        "- Do not start any long-running loop.",
        "- Stop after this one work item is complete.",
        "",
        "Reply with a concise summary of what you did, then stop.",
    ].join("\n");
}
/**
 * Parse and validate a claimed agent-mode cron job path.
 *
 * Accepts exactly:
 *   - `cron/jobs/<job>.claimed.<device-id>.md` (shared), or
 *   - `team/<agentName>/cron/jobs/<job>.claimed.<device-id>.md` (scoped).
 *
 * Throws on absolute paths (including absolute paths inside the vault),
 * traversal/outside-vault paths, unclaimed paths, non-cron paths, and
 * team-scoped paths belonging to a different agent.
 */
export function parseClaimedCronJobPath(options) {
    assertValidAgentName(options.agentName);
    if (isAbsolute(options.claimedJobPath)) {
        throw new Error(`Claimed cron job path must be vault-relative, not absolute: ${options.claimedJobPath}`);
    }
    const root = resolve(options.vaultRoot);
    const absolutePath = resolve(root, options.claimedJobPath);
    const rel = relative(root, absolutePath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`Claimed cron job path resolves outside the vault: ${options.claimedJobPath}`);
    }
    const parts = rel.split(/[\\/]+/);
    let scope;
    let fileName;
    if (parts.length === 3 && parts[0] === "cron" && parts[1] === "jobs") {
        scope = "shared";
        fileName = parts[2] ?? "";
    }
    else if (parts.length === 5 &&
        parts[0] === "team" &&
        parts[2] === "cron" &&
        parts[3] === "jobs") {
        const pathAgent = parts[1] ?? "";
        assertValidAgentName(pathAgent);
        if (pathAgent !== options.agentName) {
            throw new Error(`Claimed cron job path belongs to agent '${pathAgent}', not selected agent '${options.agentName}'.`);
        }
        scope = pathAgent;
        fileName = parts[4] ?? "";
    }
    else {
        throw new Error("Claimed cron job path must be under cron/jobs/ or team/<agent>/cron/jobs/.");
    }
    const match = fileName.match(CLAIMED_SUFFIX_PATTERN);
    if (!match) {
        throw new Error(`Claimed cron job path must end with .claimed.<device-id>.md: ${options.claimedJobPath}`);
    }
    const deviceId = match[1] ?? "";
    const jobId = fileName.replace(CLAIMED_SUFFIX_PATTERN, "");
    return {
        scope,
        agentName: options.agentName,
        deviceId,
        jobId,
        fileName: `${jobId}.md`,
        claimedJobPath: rel,
    };
}
function formatAgentCronRunResult(options) {
    const lines = [
        "mode: agent",
        `job_id: ${options.job.id}`,
        `exit_code: ${options.exitCode}`,
        "",
        "## Cron prompt",
        "",
        options.job.prompt || "(no prompt)",
        "",
        "## Assistant summary",
        "",
        options.assistantText || "(empty)",
    ];
    if (options.error !== undefined) {
        lines.push("", "## Error", "", options.error);
    }
    return lines.join("\n");
}
/**
 * Execute exactly one already-claimed agent-mode cron job.
 *
 * The claimed job path is validated first; if it is rejected the runner is
 * never called and no run is recorded. The job is then read with the existing
 * cron parser and must be in `agent` mode with a frontmatter `agent` matching
 * `agentName`; script-mode jobs and agent mismatches are refused before any
 * runner call (script-mode belongs to `executeScriptCronJob`).
 *
 * The spawned agent is instructed NOT to call `cron_record_run`; this function
 * records exactly one visible run through `recordCronRun` after the runner
 * returns or throws. `recordCronRun` also restores the job from claimed to
 * unclaimed on both success and failure. Runner failures (thrown errors or
 * non-zero exit codes) are recorded as `failed` runs, not rethrown.
 */
export async function executeClaimedAgentCronJob(options) {
    const info = parseClaimedCronJobPath({
        vaultRoot: options.vaultRoot,
        agentName: options.agentName,
        claimedJobPath: options.claimedJobPath,
    });
    const job = await readCronJob({
        vaultRoot: options.vaultRoot,
        path: info.claimedJobPath,
    });
    if (job.mode !== "agent") {
        throw new Error(`Claimed cron job is not in agent mode (mode: ${job.mode}): ${info.claimedJobPath}. Script-mode jobs use executeScriptCronJob.`);
    }
    if (job.agent !== options.agentName) {
        throw new Error(`Claimed cron job frontmatter agent '${job.agent}' does not match selected agent '${options.agentName}': ${info.claimedJobPath}`);
    }
    const prompt = buildClaimedCronJobPrompt({
        agentName: info.agentName,
        jobId: job.id,
        claimedJobPath: info.claimedJobPath,
        cronPrompt: job.prompt,
    });
    const now = options.now ?? (() => new Date());
    const startedAt = now();
    let assistantText = "";
    let exitCode = 0;
    let errorSummary;
    try {
        const runResult = await options.runner.run({
            agentName: info.agentName,
            vaultRoot: resolve(options.vaultRoot),
            prompt,
        });
        assistantText = runResult.assistantText;
        exitCode = runResult.exitCode;
    }
    catch (error) {
        exitCode = 1;
        errorSummary = error instanceof Error ? error.message : String(error);
    }
    const finishedAt = now();
    const ok = exitCode === 0 && errorSummary === undefined;
    const status = ok ? "completed" : "failed";
    const record = await recordCronRun({
        vaultRoot: options.vaultRoot,
        jobPath: info.claimedJobPath,
        agentName: info.agentName,
        deviceId: info.deviceId,
        status,
        result: formatAgentCronRunResult({
            job,
            exitCode,
            assistantText,
            ...(errorSummary !== undefined ? { error: errorSummary } : {}),
        }),
        startedAt,
        finishedAt,
    });
    const result = {
        agentName: info.agentName,
        deviceId: info.deviceId,
        jobId: job.id,
        claimedJobPath: info.claimedJobPath,
        restoredJobPath: record.restoredJobPath,
        runRecordPath: record.runPath,
        status,
        exitCode,
        assistantText,
        ok,
    };
    if (errorSummary !== undefined)
        result.error = errorSummary;
    return result;
}
//# sourceMappingURL=scheduler-cron-executor.js.map