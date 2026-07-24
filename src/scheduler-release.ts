import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseClaimedInboxTaskPath } from "./scheduler-executor.js";
import {
  atomicCreateNoClobber,
  createNodeRetryTransitionIo,
  type RetryTransitionIo,
} from "./scheduler-retry.js";

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

function parseTaskFrontmatterFields(content: string): Record<string, unknown> | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return undefined;
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

/**
 * Decide whether a claimed task's content may be released. Pure and
 * deterministic. Eligible ONLY when the frontmatter parses and the `status`
 * field is exactly `completed`; every malformed, missing, or non-completed
 * state fails closed with an exact reason. The result body is never
 * machine-validated (ADR-0038 revision 2).
 */
export function evaluateReleaseEligibility(options: { content: string }): ReleaseEligibility {
  const fields = parseTaskFrontmatterFields(options.content);
  if (fields === undefined) {
    return {
      eligible: false,
      reason: "cannot parse task frontmatter; task remains claimed for triage",
    };
  }
  const status = fields["status"];
  if (typeof status !== "string" || status === "") {
    return {
      eligible: false,
      reason: "task frontmatter is missing a valid status field; task remains claimed for triage",
    };
  }
  if (status !== "completed") {
    return {
      eligible: false,
      reason: `task status is '${status}', not completed; task remains claimed for triage`,
    };
  }
  return { eligible: true };
}

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
export type SchedulerReleaseTransition =
  | {
      action: "released";
      claimedTaskPath: string;
      /** Vault-relative path of the restored ordinary task file. */
      restoredPath: string;
      restoredAbsolutePath: string;
    }
  | {
      action: "held";
      claimedTaskPath: string;
      reason: string;
    };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Release a successfully scheduler-completed claimed inbox task back to its
 * ordinary filename, byte-for-byte, through the R2 two-step no-clobber
 * protocol. Throws only on an invalid claimed path (programming error);
 * every expected validation or I/O failure returns `held` with an exact
 * reason and preserves the claimed file for triage.
 */
export async function releaseCompletedClaimedTask(
  options: ReleaseCompletedClaimedTaskOptions,
): Promise<SchedulerReleaseTransition> {
  const info = parseClaimedInboxTaskPath({
    vaultRoot: options.vaultRoot,
    agentName: options.agentName,
    claimedTaskPath: options.claimedTaskPath,
  });

  // Gate 1: device ownership. A release never touches another device's claim.
  if (info.deviceId !== options.expectedDeviceId) {
    return {
      action: "held",
      claimedTaskPath: info.claimedTaskPath,
      reason:
        `claimed by device '${info.deviceId}', not this scheduler device '${options.expectedDeviceId}'; ` +
        "refusing to release another device's claim",
    };
  }

  const root = resolve(options.vaultRoot);
  const claimedAbsolutePath = resolve(root, info.claimedTaskPath);
  const io = options.io ?? createNodeRetryTransitionIo();

  let content: string;
  try {
    content = await io.readFile(claimedAbsolutePath);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") {
      // A concurrent transition already handled this claimed file.
      return {
        action: "held",
        claimedTaskPath: info.claimedTaskPath,
        reason: "claimed task file not found; another transition may already have handled it",
      };
    }
    // Any other read failure (EACCES, EIO, ...) is reported with the actual
    // error; it is never misreported as a concurrent transition.
    return {
      action: "held",
      claimedTaskPath: info.claimedTaskPath,
      reason: `claimed task read failed (${errorMessage(error)}); task remains claimed for triage`,
    };
  }

  // Gate 2: validated completion from the task frontmatter.
  const eligibility = evaluateReleaseEligibility({ content });
  if (!eligibility.eligible) {
    return {
      action: "held",
      claimedTaskPath: info.claimedTaskPath,
      reason: eligibility.reason ?? "task is not release-eligible; task remains claimed for triage",
    };
  }

  // Release: restore the ordinary filename byte-for-byte through the
  // fail-closed no-clobber two-step protocol, then unlink the claimed file.
  const restoredPath = join("team", info.agentName, "inbox", info.fileName);
  const restoredAbsolutePath = resolve(root, restoredPath);
  try {
    await atomicCreateNoClobber(io, restoredAbsolutePath, content);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const reason =
      code === "EEXIST"
        ? `release target already exists (${restoredPath}); concurrent claim or duplicate, task remains claimed for triage`
        : `release restore failed (${errorMessage(error)}); task remains claimed for triage`;
    return { action: "held", claimedTaskPath: info.claimedTaskPath, reason };
  }
  try {
    await io.remove(claimedAbsolutePath);
  } catch (error) {
    // The ordinary file was already restored and may already be observed or
    // claimed — never delete it. Retain BOTH files: a duplicate visible task
    // id is intentional fail-closed state that R1 duplicate handling blocks
    // for both candidates and dependency targets until triage.
    return {
      action: "held",
      claimedTaskPath: info.claimedTaskPath,
      reason:
        `claimed unlink failed after release restore (${errorMessage(error)}); ` +
        `duplicate visible task id at ${restoredPath} and ${info.claimedTaskPath}; ` +
        "both files retained for fail-closed R1/R3 triage",
    };
  }

  return {
    action: "released",
    claimedTaskPath: info.claimedTaskPath,
    restoredPath,
    restoredAbsolutePath,
  };
}
