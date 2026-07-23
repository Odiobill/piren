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

function isIsoTimestamp(value: unknown): value is string {
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
export function parseRetryPolicy(frontmatter: Record<string, unknown>): RetryPolicyParse {
  const raw = frontmatter["retry"];
  if (raw === undefined || raw === null) return {};
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
  if (raw === undefined || raw === null) return {};
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

  let content: string;
  try {
    content = await readFile(claimedAbsolutePath, "utf8");
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
  } catch {
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

function tempPathFor(target: string): string {
  const directory = dirname(target);
  return resolve(directory, `.${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
}

async function writeTempFile(target: string, content: string): Promise<string> {
  const tempPath = tempPathFor(target);
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return tempPath;
}

/** Crash-atomic in-place rewrite via temp file + rename (overwrites target). */
async function atomicOverwrite(target: string, content: string): Promise<void> {
  const tempPath = await writeTempFile(target, content);
  await rename(tempPath, target);
}

/**
 * Crash-atomic create that never clobbers: temp file + hard link. The link
 * fails with EEXIST when the target already exists, so a concurrent claim or
 * duplicate pending file aborts the restore instead of being overwritten.
 */
async function atomicCreateNoClobber(target: string, content: string): Promise<void> {
  const tempPath = await writeTempFile(target, content);
  try {
    await link(tempPath, target);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  await rm(tempPath, { force: true });
}
