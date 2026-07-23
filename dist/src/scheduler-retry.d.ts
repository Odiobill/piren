/**
 * Scheduler task retry policy and visible retry state (ADR-0038, Slice R2).
 *
 * Pure core for the conservative retry state machine of scheduler-claimed
 * inbox tasks. All retry state lives in task frontmatter (`retry` policy,
 * scheduler-written `retry_state`) so every transition is inspectable and
 * survives a scheduler restart from the file alone.
 *
 * The ONLY automatic retry trigger in v1 is a pre-spawn `launch_failure`:
 * the scheduler could not start the bounded child process, so no agent work
 * began. A timeout, non-zero exit, provider error, disconnect, or any other
 * post-start failure is ambiguous and is never automatically rerun; the task
 * remains visibly claimed for explicit coordinator/steward triage.
 *
 * This module is not wired into the scheduler (that is R3). It adds no task
 * statuses, no hidden state, and no retry beyond the bounded policy.
 *
 * Restore protocol (claimed -> pending): a fail-closed, no-clobber TWO-STEP
 * protocol — write a temp file, hard-link it to the pending name (fails when
 * the target exists), then unlink the claimed file. It is NOT a single atomic
 * rename: a crash between the link and the unlink can leave both the claimed
 * and the pending file visible, i.e. duplicate visible task IDs. That is an
 * intentional fail-closed outcome — the R1 dependency loader treats duplicate
 * IDs as invalid resolution and blocks both candidates and dependency
 * targets, so recovery never silently picks a winner. The claimed file is
 * always preserved on collisions and errors.
 *
 * All filesystem/unique-name effects go through the injected
 * {@link RetryTransitionIo} seam so state transitions are deterministically
 * testable with a fake filesystem; the production adapter is
 * {@link createNodeRetryTransitionIo}.
 */
/** Validated explicit retry policy from task frontmatter. */
export interface RetryPolicy {
    safeToRetry: true;
    maxAttempts: number;
    backoffSeconds: number;
}
/** Result of parsing the optional `retry` policy field. */
export interface RetryPolicyParse {
    policy?: RetryPolicy;
    /** Exact human-readable reason when the policy is present but invalid. */
    error?: string;
}
/** The only automatically retryable failure kind in v1. */
export type RetryStateFailure = "launch_failure";
/** Scheduler-written visible retry state from task frontmatter. */
export interface RetryState {
    attempts: number;
    /** ISO timestamp of the most recent launch attempt. */
    lastAttemptAt: string;
    /** ISO timestamp before which the task must not be re-attempted. */
    nextEligibleAt: string;
    lastFailure: RetryStateFailure;
}
/** Result of parsing the optional `retry_state` field. */
export interface RetryStateParse {
    state?: RetryState;
    /** Exact human-readable reason when the state is present but malformed. */
    error?: string;
}
/** Retry eligibility verdict for one task. */
export interface RetryEligibility {
    eligible: boolean;
    /** Exact human-readable reason when not eligible. */
    reason?: string;
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
export declare function parseRetryPolicy(frontmatter: Record<string, unknown>): RetryPolicyParse;
/**
 * Parse the optional scheduler-written `retry_state` from parsed frontmatter.
 * Tolerant of absence; malformed state is reported with an exact reason so
 * the task fails closed rather than being silently treated as attempt-free.
 */
export declare function parseRetryState(frontmatter: Record<string, unknown>): RetryStateParse;
/**
 * Evaluate whether a task is runnable with respect to its retry policy and
 * visible retry state. Pure and deterministic.
 *
 * A task with no retry fields is always eligible (normal one-claim task). An
 * invalid policy or malformed state is never eligible (ADR-0038). A task
 * inside its backoff window or with exhausted attempts is not eligible; the
 * exact reason is reported for planner/dry-run output (R3 wiring).
 */
export declare function evaluateRetryEligibility(frontmatter: Record<string, unknown>, now: Date): RetryEligibility;
/**
 * Failure kinds a scheduler can observe for a claimed task. Only
 * `launch_failure` (the bounded child process never started) is eligible for
 * automatic retry; every post-start kind is ambiguous and held for triage.
 */
export type SchedulerFailureKind = "launch_failure" | "timeout" | "exit_nonzero" | "provider_error" | "disconnect";
/** True only for the pre-spawn failure kind that may be automatically retried. */
export declare function isLaunchFailure(kind: SchedulerFailureKind): boolean;
export interface ApplySchedulerFailureOptions {
    vaultRoot: string;
    agentName: string;
    /** Vault-relative claimed task path (`team/<agent>/inbox/<task>.claimed.<device>.md`). */
    claimedTaskPath: string;
    failureKind: SchedulerFailureKind;
    now?: () => Date;
    /** Injected I/O seam; production uses {@link createNodeRetryTransitionIo}. */
    io?: RetryTransitionIo;
}
/**
 * Minimal injected filesystem/unique-temp-name seam for the claimed-task
 * transition. Implementations must preserve the safety contract:
 * `createExclusive` and `linkNoClobber` reject with an error carrying
 * `code: "EEXIST"` when the path/target exists (matching node:fs), and
 * `remove` tolerates a missing path.
 */
export interface RetryTransitionIo {
    /** Read a file; rejects when it does not exist. */
    readFile(absolutePath: string): Promise<string>;
    /** Create a NEW file exclusively (fail if it exists), write content, flush. */
    createExclusive(absolutePath: string, content: string): Promise<void>;
    /** Hard-link temp to target; MUST reject when the target already exists. */
    linkNoClobber(tempPath: string, targetPath: string): Promise<void>;
    /** Rename temp over target (overwrite allowed). */
    renameOverwrite(tempPath: string, targetPath: string): Promise<void>;
    /** Remove a file, tolerating a missing path. */
    remove(absolutePath: string): Promise<void>;
    /** A unique temp path for the given final target. */
    tempPathFor(targetPath: string): string;
}
/**
 * Production {@link RetryTransitionIo} adapter over node:fs/promises. Temp
 * files are created with `wx` at mode 0o600 and fsynced before link/rename;
 * the unique temp name mixes wall time, pid, and randomness.
 */
export declare function createNodeRetryTransitionIo(): RetryTransitionIo;
/** Outcome of applying a failure to a claimed task. The task file is the state. */
export type SchedulerFailureTransition = {
    action: "requeued";
    claimedTaskPath: string;
    /** Vault-relative path of the restored ordinary pending task file. */
    restoredPath: string;
    restoredAbsolutePath: string;
    retryState: RetryState;
} | {
    action: "exhausted";
    claimedTaskPath: string;
    retryState: RetryState;
    reason: string;
} | {
    action: "held";
    claimedTaskPath: string;
    reason: string;
};
/**
 * Apply a scheduler-observed failure to an already-claimed inbox task.
 *
 * Post-start failures (timeout, non-zero exit, provider error, disconnect)
 * are never automatically retried: the claimed file is preserved untouched
 * for explicit coordinator/steward triage, even when a valid retry policy is
 * present (ADR-0038).
 */
export declare function applySchedulerFailureTransition(options: ApplySchedulerFailureOptions): Promise<SchedulerFailureTransition>;
