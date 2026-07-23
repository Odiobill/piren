import { link, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseClaimedInboxTaskPath } from "./scheduler-executor.js";
function isPlainMapping(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isPositiveInteger(value) {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function isNonNegativeInteger(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function isIsoTimestamp(value) {
    return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
/**
 * Parse and validate the optional `retry` policy from parsed frontmatter.
 *
 * - Absent field -> no policy, no error (automatic retry disabled).
 * - Valid policy requires `safe_to_retry: true`, a positive-integer
 *   `max_attempts`, and a non-negative-integer `backoff_seconds`.
 * - Anything else -> no policy + exact reason (ADR-0038: invalid policy is
 *   not claimable and is reported).
 */
export function parseRetryPolicy(frontmatter) {
    const raw = frontmatter["retry"];
    if (raw === undefined || raw === null)
        return {};
    if (!isPlainMapping(raw))
        return { error: "retry policy must be a mapping" };
    if (raw["safe_to_retry"] !== true) {
        return { error: "retry policy requires safe_to_retry: true" };
    }
    if (!isPositiveInteger(raw["max_attempts"])) {
        return { error: "retry.max_attempts must be a positive integer" };
    }
    if (!isNonNegativeInteger(raw["backoff_seconds"])) {
        return { error: "retry.backoff_seconds must be a non-negative integer" };
    }
    return {
        policy: {
            safeToRetry: true,
            maxAttempts: raw["max_attempts"],
            backoffSeconds: raw["backoff_seconds"],
        },
    };
}
/**
 * Parse the optional scheduler-written `retry_state` from parsed frontmatter.
 * Tolerant of absence; malformed state is reported with an exact reason so
 * the task fails closed rather than being silently treated as attempt-free.
 */
export function parseRetryState(frontmatter) {
    const raw = frontmatter["retry_state"];
    if (raw === undefined || raw === null)
        return {};
    if (!isPlainMapping(raw))
        return { error: "retry_state must be a mapping" };
    if (!isNonNegativeInteger(raw["attempts"])) {
        return { error: "retry_state.attempts must be a non-negative integer" };
    }
    if (!isIsoTimestamp(raw["last_attempt_at"])) {
        return { error: "retry_state.last_attempt_at must be an ISO timestamp" };
    }
    if (!isIsoTimestamp(raw["next_eligible_at"])) {
        return { error: "retry_state.next_eligible_at must be an ISO timestamp" };
    }
    if (raw["last_failure"] !== "launch_failure") {
        return { error: "retry_state.last_failure must be launch_failure" };
    }
    return {
        state: {
            attempts: raw["attempts"],
            lastAttemptAt: raw["last_attempt_at"],
            nextEligibleAt: raw["next_eligible_at"],
            lastFailure: "launch_failure",
        },
    };
}
/**
 * Evaluate whether a task is runnable with respect to its retry policy and
 * visible retry state. Pure and deterministic.
 *
 * A task with no retry fields is always eligible (normal one-claim task). An
 * invalid policy or malformed state is never eligible (ADR-0038). A task
 * inside its backoff window or with exhausted attempts is not eligible; the
 * exact reason is reported for planner/dry-run output (R3 wiring).
 */
export function evaluateRetryEligibility(frontmatter, now) {
    const policyParse = parseRetryPolicy(frontmatter);
    if (policyParse.error !== undefined) {
        return { eligible: false, reason: policyParse.error };
    }
    const stateParse = parseRetryState(frontmatter);
    if (stateParse.error !== undefined) {
        return { eligible: false, reason: stateParse.error };
    }
    const policy = policyParse.policy;
    const state = stateParse.state;
    if (policy === undefined || state === undefined) {
        // No policy (retry disabled) or no recorded attempts yet: nothing blocks.
        return { eligible: true };
    }
    if (state.attempts >= policy.maxAttempts) {
        return { eligible: false, reason: `retry attempts exhausted (${state.attempts}/${policy.maxAttempts})` };
    }
    const nextEligibleMs = Date.parse(state.nextEligibleAt);
    if (nextEligibleMs > now.getTime()) {
        return { eligible: false, reason: `retry backoff until ${state.nextEligibleAt}` };
    }
    return { eligible: true };
}
/** True only for the pre-spawn failure kind that may be automatically retried. */
export function isLaunchFailure(kind) {
    return kind === "launch_failure";
}
/**
 * Apply a scheduler-observed failure to an already-claimed inbox task.
 *
 * Post-start failures (timeout, non-zero exit, provider error, disconnect)
 * are never automatically retried: the claimed file is preserved untouched
 * for explicit coordinator/steward triage, even when a valid retry policy is
 * present (ADR-0038).
 */
export async function applySchedulerFailureTransition(options) {
    const info = parseClaimedInboxTaskPath({
        vaultRoot: options.vaultRoot,
        agentName: options.agentName,
        claimedTaskPath: options.claimedTaskPath,
    });
    if (!isLaunchFailure(options.failureKind)) {
        return {
            action: "held",
            claimedTaskPath: info.claimedTaskPath,
            reason: `post-start failure (${options.failureKind}) is never automatically retried; ` +
                "task remains claimed for explicit coordinator/steward triage",
        };
    }
    const root = resolve(options.vaultRoot);
    const claimedAbsolutePath = resolve(root, info.claimedTaskPath);
    let content;
    try {
        content = await readFile(claimedAbsolutePath, "utf8");
    }
    catch {
        // A concurrent transition already handled this claimed file.
        return {
            action: "held",
            claimedTaskPath: info.claimedTaskPath,
            reason: "claimed task file not found; another transition may already have handled it",
        };
    }
    const frontmatter = splitFrontmatter(content);
    if (frontmatter === undefined) {
        return {
            action: "held",
            claimedTaskPath: info.claimedTaskPath,
            reason: "cannot parse task frontmatter; task remains claimed for triage",
        };
    }
    const policyParse = parseRetryPolicy(frontmatter.fields);
    if (policyParse.error !== undefined) {
        return {
            action: "held",
            claimedTaskPath: info.claimedTaskPath,
            reason: `invalid retry policy (${policyParse.error}); task remains claimed for triage`,
        };
    }
    if (policyParse.policy === undefined) {
        return {
            action: "held",
            claimedTaskPath: info.claimedTaskPath,
            reason: "no retry policy; launch failure requires explicit coordinator/steward triage",
        };
    }
    const stateParse = parseRetryState(frontmatter.fields);
    if (stateParse.error !== undefined) {
        return {
            action: "held",
            claimedTaskPath: info.claimedTaskPath,
            reason: `malformed retry_state (${stateParse.error}); task remains claimed for triage`,
        };
    }
    const policy = policyParse.policy;
    const now = (options.now ?? (() => new Date()))();
    const nowIso = now.toISOString();
    const attempts = (stateParse.state?.attempts ?? 0) + 1;
    const retryState = {
        attempts,
        lastAttemptAt: nowIso,
        nextEligibleAt: new Date(now.getTime() + policy.backoffSeconds * 1000).toISOString(),
        lastFailure: "launch_failure",
    };
    const updated = renderWithRetryState(frontmatter, retryState, nowIso);
    if (attempts >= policy.maxAttempts) {
        // Exhausted: record the final visible state in the CLAIMED file and leave
        // it claimed. It can never enter an automatic retry loop.
        await atomicOverwrite(claimedAbsolutePath, updated);
        return {
            action: "exhausted",
            claimedTaskPath: info.claimedTaskPath,
            retryState,
            reason: `retry attempts exhausted (${attempts}/${policy.maxAttempts}); task remains claimed for triage`,
        };
    }
    // Requeue: restore the ordinary pending filename through an atomic
    // no-clobber create, then remove the claimed file. A conflicting pending
    // file (concurrent claim or duplicate) aborts the transition and the
    // claimed file is preserved for triage.
    const restoredPath = join("team", info.agentName, "inbox", info.fileName);
    const restoredAbsolutePath = resolve(root, restoredPath);
    try {
        await atomicCreateNoClobber(restoredAbsolutePath, updated);
    }
    catch {
        return {
            action: "held",
            claimedTaskPath: info.claimedTaskPath,
            reason: `pending restore target already exists (${restoredPath}); concurrent claim or duplicate, task remains claimed for triage`,
        };
    }
    await rm(claimedAbsolutePath, { force: true });
    return {
        action: "requeued",
        claimedTaskPath: info.claimedTaskPath,
        restoredPath,
        restoredAbsolutePath,
        retryState,
    };
}
function splitFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match)
        return undefined;
    let parsed;
    try {
        parsed = parseYaml(match[1] ?? "");
    }
    catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        return undefined;
    return { fields: parsed, body: match[2] ?? "" };
}
/** Re-render the task file with the retry_state and updated fields set. */
function renderWithRetryState(split, retryState, updatedIso) {
    const fields = { ...split.fields };
    fields["retry_state"] = {
        attempts: retryState.attempts,
        last_attempt_at: retryState.lastAttemptAt,
        next_eligible_at: retryState.nextEligibleAt,
        last_failure: retryState.lastFailure,
    };
    fields["updated"] = updatedIso;
    return `---\n${stringifyYaml(fields)}---\n${split.body}`;
}
function tempPathFor(target) {
    const directory = dirname(target);
    return resolve(directory, `.${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
}
async function writeTempFile(target, content) {
    const tempPath = tempPathFor(target);
    const handle = await open(tempPath, "wx", 0o600);
    try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    return tempPath;
}
/** Crash-atomic in-place rewrite via temp file + rename (overwrites target). */
async function atomicOverwrite(target, content) {
    const tempPath = await writeTempFile(target, content);
    await rename(tempPath, target);
}
/**
 * Crash-atomic create that never clobbers: temp file + hard link. The link
 * fails with EEXIST when the target already exists, so a concurrent claim or
 * duplicate pending file aborts the restore instead of being overwritten.
 */
async function atomicCreateNoClobber(target, content) {
    const tempPath = await writeTempFile(target, content);
    try {
        await link(tempPath, target);
    }
    catch (error) {
        await rm(tempPath, { force: true });
        throw error;
    }
    await rm(tempPath, { force: true });
}
//# sourceMappingURL=scheduler-retry.js.map