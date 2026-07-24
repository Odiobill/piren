import { type RetryTransitionIo } from "./scheduler-retry.js";
/**
 * Scheduler completion release (ADR-0038 revision 2, Slice R3).
 *
 * A successfully scheduler-executed inbox task stays claimed after execution
 * (`<task>.claimed.<device>.md`). A claimed prerequisite NEVER satisfies
 * `depends_on` (ADR-0038 R1), so without an explicit release, dependent
 * chains never advance. This module performs exactly that release: after a
 * validated successful execution, restore the claimed file to its ordinary
 * inbox filename BYTE-FOR-BYTE through the R2 fail-closed two-step no-clobber
 * protocol (exclusive temp file, hard link to the ordinary name, then unlink
 * the claimed file — never a single atomic rename).
 *
 * Release gates (all fail closed; the claimed file is preserved for explicit
 * coordinator/steward triage with an exact reason):
 *
 *   1. Device ownership: the device id in the claimed suffix must equal the
 *      releasing scheduler's device id, so a release never touches another
 *      device's claim.
 *   2. The claimed file re-reads with `status: completed`. Completion is
 *      never inferred from the result body, the assistant summary, or the
 *      runner exit code alone. Cancelled, malformed, missing, or
 *      non-completed tasks remain claimed.
 *
 * Crash window: a crash between the link and the unlink leaves BOTH files
 * visible, i.e. a duplicate visible task ID. That is intentional fail-closed
 * state — the R1 dependency loader treats duplicate IDs as invalid resolution
 * and blocks both candidates and dependency targets until triage.
 *
 * This module adds no task statuses, rewrites no task content, retries no
 * work, and keeps all state in the two visible filenames. The scheduler tick
 * receives this operation through an injected seam (see scheduler-once.ts);
 * the pure transition is deterministically testable via the injected
 * {@link RetryTransitionIo} seam shared with the R2 retry transition.
 */
/** Release eligibility verdict for one claimed task's content. */
export interface ReleaseEligibility {
    eligible: boolean;
    /** Exact human-readable reason when not eligible. */
    reason?: string;
}
/**
 * Decide whether a claimed task's content may be released. Pure and
 * deterministic. Eligible ONLY when the frontmatter parses and the `status`
 * field is exactly `completed`; every malformed, missing, or non-completed
 * state fails closed with an exact reason. The result body is never
 * machine-validated (ADR-0038 revision 2).
 */
export declare function evaluateReleaseEligibility(options: {
    content: string;
}): ReleaseEligibility;
export interface ReleaseCompletedClaimedTaskOptions {
    vaultRoot: string;
    agentName: string;
    /** Vault-relative claimed task path (`team/<agent>/inbox/<task>.claimed.<device>.md`). */
    claimedTaskPath: string;
    /** The releasing scheduler's own device id; must match the claimed suffix. */
    expectedDeviceId: string;
    /** Injected I/O seam; production uses {@link createNodeRetryTransitionIo}. */
    io?: RetryTransitionIo;
}
/** Outcome of a completion release attempt. The task files are the state. */
export type SchedulerReleaseTransition = {
    action: "released";
    claimedTaskPath: string;
    /** Vault-relative path of the restored ordinary task file. */
    restoredPath: string;
    restoredAbsolutePath: string;
} | {
    action: "held";
    claimedTaskPath: string;
    reason: string;
};
/**
 * Release a successfully scheduler-completed claimed inbox task back to its
 * ordinary filename, byte-for-byte, through the R2 two-step no-clobber
 * protocol. Throws only on an invalid claimed path (programming error);
 * every expected validation or I/O failure returns `held` with an exact
 * reason and preserves the claimed file for triage.
 */
export declare function releaseCompletedClaimedTask(options: ReleaseCompletedClaimedTaskOptions): Promise<SchedulerReleaseTransition>;
