import { link, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseClaimedInboxTaskPath } from "./scheduler-executor.js";

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

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Canonical scheduler-written ISO-8601 timestamp (`Date#toISOString()` shape:
 * `YYYY-MM-DDTHH:mm:ss.sssZ`). `Date.parse` alone is too lenient — it accepts
 * natural-language and date-only inputs — so require the exact canonical
 * shape AND a lossless round trip.
 */
function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return false;
  return new Date(ms).toISOString() === value;
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
export function parseRetryPolicy(frontmatter: Record<string, unknown>): RetryPolicyParse {
  const raw = frontmatter["retry"];
  // Only `undefined` means absent. An explicit null is a present malformed
  // value and must fail closed with an exact reason.
  if (raw === undefined) return {};
  if (!isPlainMapping(raw)) return { error: "retry policy must be a mapping" };
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
export function parseRetryState(frontmatter: Record<string, unknown>): RetryStateParse {
  const raw = frontmatter["retry_state"];
  // Only `undefined` means absent. An explicit null is a present malformed
  // value and must fail closed with an exact reason.
  if (raw === undefined) return {};
  if (!isPlainMapping(raw)) return { error: "retry_state must be a mapping" };
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
export function evaluateRetryEligibility(frontmatter: Record<string, unknown>, now: Date): RetryEligibility {
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

// ---------------------------------------------------------------------------
// Claimed-task failure transition (bounded, atomic, inspectable)
// ---------------------------------------------------------------------------

/**
 * Failure kinds a scheduler can observe for a claimed task. Only
 * `launch_failure` (the bounded child process never started) is eligible for
 * automatic retry; every post-start kind is ambiguous and held for triage.
 */
export type SchedulerFailureKind = "launch_failure" | "timeout" | "exit_nonzero" | "provider_error" | "disconnect";

/** True only for the pre-spawn failure kind that may be automatically retried. */
export function isLaunchFailure(kind: SchedulerFailureKind): boolean {
  return kind === "launch_failure";
}

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
export function createNodeRetryTransitionIo(): RetryTransitionIo {
  return {
    readFile: (absolutePath) => readFile(absolutePath, "utf8"),
    async createExclusive(absolutePath, content) {
      const handle = await open(absolutePath, "wx", 0o600);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } catch (error) {
        // A failed temp write must not leave the artifact behind. Cleanup is
        // best-effort and never masks the original write/sync error.
        await rm(absolutePath, { force: true }).catch(() => {});
        throw error;
      } finally {
        await handle.close();
      }
    },
    linkNoClobber: (tempPath, targetPath) => link(tempPath, targetPath),
    renameOverwrite: (tempPath, targetPath) => rename(tempPath, targetPath),
    remove: async (absolutePath) => {
      await rm(absolutePath, { force: true });
    },
    tempPathFor: (targetPath) =>
      resolve(
        dirname(targetPath),
        `.${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`,
      ),
  };
}

/** Outcome of applying a failure to a claimed task. The task file is the state. */
export type SchedulerFailureTransition =
  | {
      action: "requeued";
      claimedTaskPath: string;
      /** Vault-relative path of the restored ordinary pending task file. */
      restoredPath: string;
      restoredAbsolutePath: string;
      retryState: RetryState;
    }
  | {
      action: "exhausted";
      claimedTaskPath: string;
      retryState: RetryState;
      reason: string;
    }
  | {
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
export async function applySchedulerFailureTransition(
  options: ApplySchedulerFailureOptions,
): Promise<SchedulerFailureTransition> {
  const info = parseClaimedInboxTaskPath({
    vaultRoot: options.vaultRoot,
    agentName: options.agentName,
    claimedTaskPath: options.claimedTaskPath,
  });

  if (!isLaunchFailure(options.failureKind)) {
    return {
      action: "held",
      claimedTaskPath: info.claimedTaskPath,
      reason:
        `post-start failure (${options.failureKind}) is never automatically retried; ` +
        "task remains claimed for explicit coordinator/steward triage",
    };
  }

  const root = resolve(options.vaultRoot);
  const claimedAbsolutePath = resolve(root, info.claimedTaskPath);
  const io = options.io ?? createNodeRetryTransitionIo();

  let content: string;
  try {
    content = await io.readFile(claimedAbsolutePath);
  } catch {
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
  const retryState: RetryState = {
    attempts,
    lastAttemptAt: nowIso,
    nextEligibleAt: new Date(now.getTime() + policy.backoffSeconds * 1000).toISOString(),
    lastFailure: "launch_failure",
  };
  const updated = renderWithRetryState(frontmatter, retryState, nowIso);

  if (attempts >= policy.maxAttempts) {
    // Exhausted: record the final visible state in the CLAIMED file and leave
    // it claimed. It can never enter an automatic retry loop. A rewrite
    // failure is total: hold with the prior claimed state preserved.
    try {
      await atomicOverwrite(io, claimedAbsolutePath, updated);
    } catch (error) {
      return {
        action: "held",
        claimedTaskPath: info.claimedTaskPath,
        reason:
          `exhausted-state rewrite failed (${errorMessage(error)}); ` +
          "task remains claimed with its prior state for triage",
      };
    }
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
    await atomicCreateNoClobber(io, restoredAbsolutePath, updated);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const reason =
      code === "EEXIST"
        ? `pending restore target already exists (${restoredPath}); concurrent claim or duplicate, task remains claimed for triage`
        : `pending restore failed (${errorMessage(error)}); task remains claimed for triage`;
    return { action: "held", claimedTaskPath: info.claimedTaskPath, reason };
  }
  try {
    await io.remove(claimedAbsolutePath);
  } catch (error) {
    // The pending file was already restored and may already be observed or
    // claimed — never delete it. Retain BOTH files: a duplicate visible task
    // id is intentional fail-closed state that R1 duplicate handling blocks
    // for both candidates and dependency targets until triage.
    return {
      action: "held",
      claimedTaskPath: info.claimedTaskPath,
      reason:
        `claimed unlink failed after pending restore (${errorMessage(error)}); ` +
        `duplicate visible task id at ${restoredPath} and ${info.claimedTaskPath}; ` +
        "both files retained for fail-closed R1/R3 triage",
    };
  }

  return {
    action: "requeued",
    claimedTaskPath: info.claimedTaskPath,
    restoredPath,
    restoredAbsolutePath,
    retryState,
  };
}

interface SplitTaskContent {
  fields: Record<string, unknown>;
  /** Body after the closing frontmatter delimiter, preserved verbatim. */
  body: string;
}

function splitFrontmatter(content: string): SplitTaskContent | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return undefined;
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return { fields: parsed as Record<string, unknown>, body: match[2] ?? "" };
}

/** Re-render the task file with the retry_state and updated fields set. */
function renderWithRetryState(split: SplitTaskContent, retryState: RetryState, updatedIso: string): string {
  const fields: Record<string, unknown> = { ...split.fields };
  fields["retry_state"] = {
    attempts: retryState.attempts,
    last_attempt_at: retryState.lastAttemptAt,
    next_eligible_at: retryState.nextEligibleAt,
    last_failure: retryState.lastFailure,
  };
  fields["updated"] = updatedIso;
  return `---\n${stringifyYaml(fields)}---\n${split.body}`;
}

function tempPathFor(io: RetryTransitionIo, target: string): string {
  return io.tempPathFor(target);
}

async function writeTempFile(io: RetryTransitionIo, target: string, content: string): Promise<string> {
  const tempPath = tempPathFor(io, target);
  await io.createExclusive(tempPath, content);
  return tempPath;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Crash-atomic in-place rewrite via temp file + rename (overwrites target). */
async function atomicOverwrite(io: RetryTransitionIo, target: string, content: string): Promise<void> {
  const tempPath = await writeTempFile(io, target, content);
  try {
    await io.renameOverwrite(tempPath, target);
  } catch (error) {
    // Best-effort temp cleanup; never mask the original rename error.
    await io.remove(tempPath).catch(() => {});
    throw error;
  }
}

/**
 * Fail-closed no-clobber TWO-STEP create: temp file + hard link (rejects when
 * the target exists), then temp cleanup. NOT a single atomic rename — see the
 * module header for the intentional duplicate-ID crash window.
 */
async function atomicCreateNoClobber(io: RetryTransitionIo, target: string, content: string): Promise<void> {
  const tempPath = await writeTempFile(io, target, content);
  try {
    await io.linkNoClobber(tempPath, target);
  } catch (error) {
    // Best-effort temp cleanup; never mask the original link error.
    await io.remove(tempPath).catch(() => {});
    throw error;
  }
  // Best-effort temp cleanup on the success path too: a leftover dot-temp
  // artifact is not a visible task id and never justifies failing a restore
  // whose link already succeeded. The claimed unlink (checked by the caller)
  // is the step whose failure produces the duplicate-recovery held result.
  await io.remove(tempPath).catch(() => {});
}
