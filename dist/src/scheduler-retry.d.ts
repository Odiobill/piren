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
}
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
