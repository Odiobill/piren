import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySchedulerFailureTransition,
  evaluateRetryEligibility,
  isLaunchFailure,
  parseRetryPolicy,
  parseRetryState,
  type RetryTransitionIo,
} from "../src/scheduler-retry.js";

const NOW = new Date("2026-07-23T12:00:00.000Z");

describe("parseRetryPolicy", () => {
  it("returns no policy and no error when retry is absent", () => {
    const r = parseRetryPolicy({});
    expect(r.policy).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  it("parses a valid explicit safe retry policy", () => {
    const r = parseRetryPolicy({
      retry: { safe_to_retry: true, max_attempts: 2, backoff_seconds: 300 },
    });
    expect(r.error).toBeUndefined();
    expect(r.policy).toEqual({ safeToRetry: true, maxAttempts: 2, backoffSeconds: 300 });
  });

  it("accepts backoff_seconds: 0", () => {
    const r = parseRetryPolicy({
      retry: { safe_to_retry: true, max_attempts: 1, backoff_seconds: 0 },
    });
    expect(r.policy).toEqual({ safeToRetry: true, maxAttempts: 1, backoffSeconds: 0 });
  });

  it("treats retry: null as present malformed, not absent", () => {
    const r = parseRetryPolicy({ retry: null });
    expect(r.policy).toBeUndefined();
    expect(r.error).toBe("retry policy must be a mapping");
  });

  it("rejects a non-mapping retry field with an exact reason", () => {
    const r = parseRetryPolicy({ retry: true });
    expect(r.policy).toBeUndefined();
    expect(r.error).toBe("retry policy must be a mapping");
  });

  it("rejects safe_to_retry other than true", () => {
    for (const value of [false, "true", 1, undefined]) {
      const r = parseRetryPolicy({
        retry: { safe_to_retry: value, max_attempts: 2, backoff_seconds: 300 },
      });
      expect(r.policy).toBeUndefined();
      expect(r.error).toBe("retry policy requires safe_to_retry: true");
    }
  });

  it("rejects a non-positive-integer max_attempts", () => {
    for (const value of [0, -1, 1.5, "2", undefined]) {
      const r = parseRetryPolicy({
        retry: { safe_to_retry: true, max_attempts: value, backoff_seconds: 300 },
      });
      expect(r.policy).toBeUndefined();
      expect(r.error).toBe("retry.max_attempts must be a positive integer");
    }
  });

  it("rejects a negative or non-integer backoff_seconds", () => {
    for (const value of [-1, 1.5, "300", undefined]) {
      const r = parseRetryPolicy({
        retry: { safe_to_retry: true, max_attempts: 2, backoff_seconds: value },
      });
      expect(r.policy).toBeUndefined();
      expect(r.error).toBe("retry.backoff_seconds must be a non-negative integer");
    }
  });
});

describe("parseRetryState", () => {
  const VALID = {
    attempts: 1,
    last_attempt_at: "2026-07-23T11:55:00.000Z",
    next_eligible_at: "2026-07-23T12:05:00.000Z",
    last_failure: "launch_failure",
  };

  it("returns no state and no error when retry_state is absent", () => {
    const r = parseRetryState({});
    expect(r.state).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  it("parses a valid retry_state", () => {
    const r = parseRetryState({ retry_state: VALID });
    expect(r.error).toBeUndefined();
    expect(r.state).toEqual({
      attempts: 1,
      lastAttemptAt: "2026-07-23T11:55:00.000Z",
      nextEligibleAt: "2026-07-23T12:05:00.000Z",
      lastFailure: "launch_failure",
    });
  });

  it("treats retry_state: null as present malformed, not absent", () => {
    const r = parseRetryState({ retry_state: null });
    expect(r.state).toBeUndefined();
    expect(r.error).toBe("retry_state must be a mapping");
  });

  it("rejects a non-mapping retry_state", () => {
    const r = parseRetryState({ retry_state: "launch_failure" });
    expect(r.state).toBeUndefined();
    expect(r.error).toBe("retry_state must be a mapping");
  });

  it("rejects a negative or non-integer attempts count", () => {
    const r = parseRetryState({ retry_state: { ...VALID, attempts: -1 } });
    expect(r.error).toBe("retry_state.attempts must be a non-negative integer");
  });

  it("rejects parseable-but-non-canonical timestamps (scheduler writes canonical ISO)", () => {
    const invalid = [
      "July 23, 2026", // natural language, Date.parse-compatible
      "2026-07-23", // date only
      "2026-07-23T12:00:00Z", // missing milliseconds
      "2026-07-23T12:00:00.000+02:00", // offset form, not the scheduler-written Z form
      "2026-13-45T99:99:99.999Z", // canonical shape, impossible date
      " 2026-07-23T12:00:00.000Z ", // surrounding whitespace
    ];
    for (const value of invalid) {
      const r = parseRetryState({ retry_state: { ...VALID, last_attempt_at: value } });
      expect(r.state).toBeUndefined();
      expect(r.error).toBe("retry_state.last_attempt_at must be an ISO timestamp");
    }
  });

  it("rejects an invalid last_attempt_at timestamp", () => {
    const r = parseRetryState({ retry_state: { ...VALID, last_attempt_at: "not-a-date" } });
    expect(r.error).toBe("retry_state.last_attempt_at must be an ISO timestamp");
  });

  it("rejects an invalid next_eligible_at timestamp", () => {
    const r = parseRetryState({ retry_state: { ...VALID, next_eligible_at: 42 } });
    expect(r.error).toBe("retry_state.next_eligible_at must be an ISO timestamp");
  });

  it("rejects an unknown last_failure kind", () => {
    const r = parseRetryState({ retry_state: { ...VALID, last_failure: "timeout" } });
    expect(r.error).toBe("retry_state.last_failure must be launch_failure");
  });
});

describe("evaluateRetryEligibility", () => {
  const POLICY = { safe_to_retry: true, max_attempts: 2, backoff_seconds: 300 };

  it("is eligible when no retry fields are present at all", () => {
    expect(evaluateRetryEligibility({}, NOW)).toEqual({ eligible: true });
  });

  it("is eligible with a valid policy and no prior attempts", () => {
    expect(evaluateRetryEligibility({ retry: POLICY }, NOW)).toEqual({ eligible: true });
  });

  it("is ineligible with retry: null (present malformed value)", () => {
    const r = evaluateRetryEligibility({ retry: null }, NOW);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("retry policy must be a mapping");
  });

  it("is ineligible with retry_state: null under a valid policy", () => {
    const r = evaluateRetryEligibility({ retry: POLICY, retry_state: null }, NOW);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("retry_state must be a mapping");
  });

  it("is ineligible with an invalid policy and reports the exact reason", () => {
    const r = evaluateRetryEligibility({ retry: { safe_to_retry: false } }, NOW);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("retry policy requires safe_to_retry: true");
  });

  it("is ineligible with a malformed retry_state", () => {
    const r = evaluateRetryEligibility({ retry: POLICY, retry_state: "broken" }, NOW);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("retry_state must be a mapping");
  });

  it("is ineligible while backoff has not elapsed", () => {
    const r = evaluateRetryEligibility(
      {
        retry: POLICY,
        retry_state: {
          attempts: 1,
          last_attempt_at: "2026-07-23T11:55:00.000Z",
          next_eligible_at: "2026-07-23T12:05:00.000Z",
          last_failure: "launch_failure",
        },
      },
      NOW,
    );
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("retry backoff until 2026-07-23T12:05:00.000Z");
  });

  it("is eligible once backoff has elapsed and attempts remain", () => {
    const r = evaluateRetryEligibility(
      {
        retry: POLICY,
        retry_state: {
          attempts: 1,
          last_attempt_at: "2026-07-23T11:50:00.000Z",
          next_eligible_at: "2026-07-23T11:55:00.000Z",
          last_failure: "launch_failure",
        },
      },
      NOW,
    );
    expect(r).toEqual({ eligible: true });
  });

  it("is ineligible when attempts are exhausted", () => {
    const r = evaluateRetryEligibility(
      {
        retry: POLICY,
        retry_state: {
          attempts: 2,
          last_attempt_at: "2026-07-23T11:50:00.000Z",
          next_eligible_at: "2026-07-23T11:55:00.000Z",
          last_failure: "launch_failure",
        },
      },
      NOW,
    );
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("retry attempts exhausted (2/2)");
  });
});

// ---------------------------------------------------------------------------
// Failure-kind classification and the claimed-task transition (fs seam)
// ---------------------------------------------------------------------------

function taskFile(opts: { id: string; extraFrontmatter?: string[]; body?: string }): string {
  const lines = [
    "---",
    "type: Task",
    `id: ${opts.id}`,
    "from: sam",
    "to: kimi",
    "priority: normal",
    "status: pending",
    "created: 2026-07-23T10:00:00.000Z",
    "updated: 2026-07-23T10:00:00.000Z",
    "requires_approval: false",
    ...(opts.extraFrontmatter ?? []),
    "---",
    "",
    `# ${opts.id}`,
    "",
    opts.body ?? "Do the thing.",
    "",
    "## Result",
    "",
    "Pending.",
    "",
  ];
  return lines.join("\n");
}

const TASK_ID = "20260723T100000000Z-flaky-launch";
const CLAIMED_NAME = `${TASK_ID}.claimed.ironman.md`;

async function seedClaimedTask(vault: string, content: string, name: string = CLAIMED_NAME): Promise<string> {
  const inbox = join(vault, "team", "kimi", "inbox");
  await mkdir(inbox, { recursive: true });
  await writeFile(join(inbox, name), content);
  return `team/kimi/inbox/${name}`;
}

describe("isLaunchFailure", () => {
  it("is true only for the pre-spawn launch_failure kind", () => {
    expect(isLaunchFailure("launch_failure")).toBe(true);
    for (const kind of ["timeout", "exit_nonzero", "provider_error", "disconnect"] as const) {
      expect(isLaunchFailure(kind)).toBe(false);
    }
  });
});

describe("applySchedulerFailureTransition: post-start failures", () => {
  let vault: string;
  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), "piren-retry-post-"));
  });
  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
  });

  const RETRYABLE = taskFile({
    id: TASK_ID,
    extraFrontmatter: ["retry:", "  safe_to_retry: true", "  max_attempts: 2", "  backoff_seconds: 300"],
  });

  for (const kind of ["timeout", "exit_nonzero", "provider_error", "disconnect"] as const) {
    it(`never retries after process start (${kind}) and preserves the claimed task`, async () => {
      const claimedPath = await seedClaimedTask(vault, RETRYABLE);
      const result = await applySchedulerFailureTransition({
        vaultRoot: vault,
        agentName: "kimi",
        claimedTaskPath: claimedPath,
        failureKind: kind,
        now: () => NOW,
      });
      expect(result.action).toBe("held");
      if (result.action !== "held") return;
      expect(result.reason).toContain("never automatically retried");
      expect(result.reason).toContain(kind);
      // The claimed file is preserved byte-for-byte for explicit triage.
      expect(await readFile(join(vault, claimedPath), "utf8")).toBe(RETRYABLE);
    });
  }

  it("rejects a non-claimed task path", async () => {
    const pending = await seedClaimedTask(vault, RETRYABLE, `${TASK_ID}.md`);
    await expect(
      applySchedulerFailureTransition({
        vaultRoot: vault,
        agentName: "kimi",
        claimedTaskPath: pending,
        failureKind: "launch_failure",
        now: () => NOW,
      }),
    ).rejects.toThrow(/claimed/);
  });

  it("rejects a claimed path belonging to another agent", async () => {
    const claimedPath = await seedClaimedTask(vault, RETRYABLE);
    await expect(
      applySchedulerFailureTransition({
        vaultRoot: vault,
        agentName: "zai",
        claimedTaskPath: claimedPath,
        failureKind: "launch_failure",
        now: () => NOW,
      }),
    ).rejects.toThrow(/belongs to agent/);
  });
});

/** Parse the frontmatter of a task file on disk into a plain object. */
async function readFrontmatter(vault: string, relPath: string): Promise<Record<string, unknown>> {
  const content = await readFile(join(vault, relPath), "utf8");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new Error(`missing frontmatter: ${relPath}`);
  return parseYaml(match[1] ?? "") as Record<string, unknown>;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("applySchedulerFailureTransition: launch_failure requeue", () => {
  let vault: string;
  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), "piren-retry-launch-"));
  });
  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
  });

  const RETRYABLE = taskFile({
    id: TASK_ID,
    extraFrontmatter: ["retry:", "  safe_to_retry: true", "  max_attempts: 2", "  backoff_seconds: 300"],
  });

  it("requeues on a first pre-spawn launch failure and records visible retry_state", async () => {
    const claimedPath = await seedClaimedTask(vault, RETRYABLE);
    const result = await applySchedulerFailureTransition({
      vaultRoot: vault,
      agentName: "kimi",
      claimedTaskPath: claimedPath,
      failureKind: "launch_failure",
      now: () => NOW,
    });
    expect(result.action).toBe("requeued");
    if (result.action !== "requeued") return;
    expect(result.restoredPath).toBe(`team/kimi/inbox/${TASK_ID}.md`);
    expect(result.retryState).toEqual({
      attempts: 1,
      lastAttemptAt: "2026-07-23T12:00:00.000Z",
      nextEligibleAt: "2026-07-23T12:05:00.000Z",
      lastFailure: "launch_failure",
    });

    // Claimed file is gone; the ordinary pending file exists with visible state.
    expect(await pathExists(join(vault, claimedPath))).toBe(false);
    const fields = await readFrontmatter(vault, result.restoredPath);
    expect(fields["status"]).toBe("pending");
    expect(fields["updated"]).toBe("2026-07-23T12:00:00.000Z");
    expect(fields["retry_state"]).toEqual({
      attempts: 1,
      last_attempt_at: "2026-07-23T12:00:00.000Z",
      next_eligible_at: "2026-07-23T12:05:00.000Z",
      last_failure: "launch_failure",
    });
    // The retry policy itself is preserved for the next evaluation.
    expect(fields["retry"]).toEqual({ safe_to_retry: true, max_attempts: 2, backoff_seconds: 300 });
    // Body (including the Result section) survives the transition.
    const content = await readFile(join(vault, result.restoredPath), "utf8");
    expect(content).toContain("## Result");
    expect(content).toContain("Pending.");
  });

  it("increments attempts from the persisted state and applies backoff from now", async () => {
    const withState = taskFile({
      id: TASK_ID,
      extraFrontmatter: [
        "retry:",
        "  safe_to_retry: true",
        "  max_attempts: 3",
        "  backoff_seconds: 60",
        "retry_state:",
        "  attempts: 1",
        '  last_attempt_at: "2026-07-23T11:00:00.000Z"',
        '  next_eligible_at: "2026-07-23T11:01:00.000Z"',
        "  last_failure: launch_failure",
      ],
    });
    const claimedPath = await seedClaimedTask(vault, withState);
    const result = await applySchedulerFailureTransition({
      vaultRoot: vault,
      agentName: "kimi",
      claimedTaskPath: claimedPath,
      failureKind: "launch_failure",
      now: () => NOW,
    });
    expect(result.action).toBe("requeued");
    if (result.action !== "requeued") return;
    expect(result.retryState.attempts).toBe(2);
    expect(result.retryState.nextEligibleAt).toBe("2026-07-23T12:01:00.000Z");
  });

  it("survives a scheduler restart: eligibility is recoverable from the file alone", async () => {
    const claimedPath = await seedClaimedTask(vault, RETRYABLE);
    const result = await applySchedulerFailureTransition({
      vaultRoot: vault,
      agentName: "kimi",
      claimedTaskPath: claimedPath,
      failureKind: "launch_failure",
      now: () => NOW,
    });
    if (result.action !== "requeued") throw new Error("expected requeue");

    // A fresh reader (post-restart) sees the backoff window from the file.
    const fields = await readFrontmatter(vault, result.restoredPath);
    const during = evaluateRetryEligibility(fields, new Date("2026-07-23T12:02:00.000Z"));
    expect(during.eligible).toBe(false);
    expect(during.reason).toBe("retry backoff until 2026-07-23T12:05:00.000Z");
    const after = evaluateRetryEligibility(fields, new Date("2026-07-23T12:05:00.000Z"));
    expect(after).toEqual({ eligible: true });
  });
});

describe("applySchedulerFailureTransition: exhaustion, policy gates, races", () => {
  let vault: string;
  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), "piren-retry-guard-"));
  });
  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
  });

  it("exhausts on the final allowed attempt: state recorded, task stays claimed, never restored", async () => {
    const almostDone = taskFile({
      id: TASK_ID,
      extraFrontmatter: [
        "retry:",
        "  safe_to_retry: true",
        "  max_attempts: 2",
        "  backoff_seconds: 300",
        "retry_state:",
        "  attempts: 1",
        '  last_attempt_at: "2026-07-23T11:00:00.000Z"',
        '  next_eligible_at: "2026-07-23T11:05:00.000Z"',
        "  last_failure: launch_failure",
      ],
    });
    const claimedPath = await seedClaimedTask(vault, almostDone);
    const result = await applySchedulerFailureTransition({
      vaultRoot: vault,
      agentName: "kimi",
      claimedTaskPath: claimedPath,
      failureKind: "launch_failure",
      now: () => NOW,
    });
    expect(result.action).toBe("exhausted");
    if (result.action !== "exhausted") return;
    expect(result.retryState.attempts).toBe(2);
    expect(result.reason).toContain("exhausted (2/2)");
    // Visibly claimed with the final state; no pending file was restored.
    expect(await pathExists(join(vault, claimedPath))).toBe(true);
    expect(await pathExists(join(vault, "team", "kimi", "inbox", `${TASK_ID}.md`))).toBe(false);
    const fields = await readFrontmatter(vault, claimedPath);
    expect(fields["retry_state"]).toEqual({
      attempts: 2,
      last_attempt_at: "2026-07-23T12:00:00.000Z",
      next_eligible_at: "2026-07-23T12:05:00.000Z",
      last_failure: "launch_failure",
    });
    // An exhausted file can never become eligible again.
    expect(evaluateRetryEligibility(fields, new Date("2026-07-24T12:00:00.000Z")).eligible).toBe(false);
  });

  it("holds a launch failure when no retry policy is declared", async () => {
    const noPolicy = taskFile({ id: TASK_ID });
    const claimedPath = await seedClaimedTask(vault, noPolicy);
    const result = await applySchedulerFailureTransition({
      vaultRoot: vault,
      agentName: "kimi",
      claimedTaskPath: claimedPath,
      failureKind: "launch_failure",
      now: () => NOW,
    });
    expect(result.action).toBe("held");
    if (result.action !== "held") return;
    expect(result.reason).toContain("no retry policy");
    expect(await readFile(join(vault, claimedPath), "utf8")).toBe(noPolicy);
  });

  it("holds a launch failure when the policy is unsafe or invalid, with the exact reason", async () => {
    const unsafe = taskFile({
      id: TASK_ID,
      extraFrontmatter: ["retry:", "  safe_to_retry: false", "  max_attempts: 2", "  backoff_seconds: 300"],
    });
    const claimedPath = await seedClaimedTask(vault, unsafe);
    const result = await applySchedulerFailureTransition({
      vaultRoot: vault,
      agentName: "kimi",
      claimedTaskPath: claimedPath,
      failureKind: "launch_failure",
      now: () => NOW,
    });
    expect(result.action).toBe("held");
    if (result.action !== "held") return;
    expect(result.reason).toContain("retry policy requires safe_to_retry: true");
    expect(await readFile(join(vault, claimedPath), "utf8")).toBe(unsafe);
  });

  it("holds a launch failure when persisted retry_state is malformed", async () => {
    const broken = taskFile({
      id: TASK_ID,
      extraFrontmatter: [
        "retry:",
        "  safe_to_retry: true",
        "  max_attempts: 2",
        "  backoff_seconds: 300",
        "retry_state:",
        "  attempts: -1",
        '  last_attempt_at: "2026-07-23T11:00:00.000Z"',
        '  next_eligible_at: "2026-07-23T11:05:00.000Z"',
        "  last_failure: launch_failure",
      ],
    });
    const claimedPath = await seedClaimedTask(vault, broken);
    const result = await applySchedulerFailureTransition({
      vaultRoot: vault,
      agentName: "kimi",
      claimedTaskPath: claimedPath,
      failureKind: "launch_failure",
      now: () => NOW,
    });
    expect(result.action).toBe("held");
    if (result.action !== "held") return;
    expect(result.reason).toContain("retry_state.attempts must be a non-negative integer");
    expect(await readFile(join(vault, claimedPath), "utf8")).toBe(broken);
  });

  it("refuses to clobber an existing pending file (concurrent claim/duplicate race)", async () => {
    const retryable = taskFile({
      id: TASK_ID,
      extraFrontmatter: ["retry:", "  safe_to_retry: true", "  max_attempts: 2", "  backoff_seconds: 300"],
    });
    const claimedPath = await seedClaimedTask(vault, retryable);
    // A conflicting pending file appears before the restore lands.
    const conflicting = taskFile({ id: TASK_ID, body: "Conflicting duplicate." });
    await writeFile(join(vault, "team", "kimi", "inbox", `${TASK_ID}.md`), conflicting);

    const result = await applySchedulerFailureTransition({
      vaultRoot: vault,
      agentName: "kimi",
      claimedTaskPath: claimedPath,
      failureKind: "launch_failure",
      now: () => NOW,
    });
    expect(result.action).toBe("held");
    if (result.action !== "held") return;
    expect(result.reason).toContain("pending restore target already exists");
    // Both files are preserved: the claim is intact, the conflict untouched.
    expect(await readFile(join(vault, claimedPath), "utf8")).toBe(retryable);
    expect(await readFile(join(vault, "team", "kimi", "inbox", `${TASK_ID}.md`), "utf8")).toBe(conflicting);
  });

  it("a concurrent second restore loses the race and holds without corrupting the winner", async () => {
    const retryable = taskFile({
      id: TASK_ID,
      extraFrontmatter: ["retry:", "  safe_to_retry: true", "  max_attempts: 2", "  backoff_seconds: 300"],
    });
    const claimedPath = await seedClaimedTask(vault, retryable);
    const input = {
      vaultRoot: vault,
      agentName: "kimi",
      claimedTaskPath: claimedPath,
      failureKind: "launch_failure" as const,
      now: () => NOW,
    };
    const [first, second] = await Promise.all([
      applySchedulerFailureTransition(input),
      applySchedulerFailureTransition(input),
    ]);
    const actions = [first.action, second.action].sort();
    expect(actions).toEqual(["held", "requeued"]);
    // Exactly one pending file exists with the recorded state.
    const fields = await readFrontmatter(vault, `team/kimi/inbox/${TASK_ID}.md`);
    expect((fields["retry_state"] as Record<string, unknown>)["attempts"]).toBe(1);
    expect(await pathExists(join(vault, claimedPath))).toBe(false);
  });

  it("holds when the claimed file is already gone", async () => {
    await mkdir(join(vault, "team", "kimi", "inbox"), { recursive: true });
    const result = await applySchedulerFailureTransition({
      vaultRoot: vault,
      agentName: "kimi",
      claimedTaskPath: `team/kimi/inbox/${CLAIMED_NAME}`,
      failureKind: "launch_failure",
      now: () => NOW,
    });
    expect(result.action).toBe("held");
    if (result.action !== "held") return;
    expect(result.reason).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// Injected fake-I/O seam (R2 review: deterministic state-transition tests)
// ---------------------------------------------------------------------------

/** Deterministic in-memory RetryTransitionIo fake with an operation log. */
class FakeRetryIo implements RetryTransitionIo {
  readonly files = new Map<string, string>();
  readonly ops: string[] = [];
  private counter = 0;

  tempPathFor(targetPath: string): string {
    const name = `${targetPath}.fake-tmp-${this.counter}`;
    this.counter += 1;
    return name;
  }

  private coded(code: string, path: string): Error {
    const error = new Error(`${code}: ${path}`);
    (error as { code?: string }).code = code;
    return error;
  }

  async readFile(absolutePath: string): Promise<string> {
    this.ops.push(`read ${absolutePath}`);
    const content = this.files.get(absolutePath);
    if (content === undefined) throw this.coded("ENOENT", absolutePath);
    return content;
  }

  async createExclusive(absolutePath: string, content: string): Promise<void> {
    this.ops.push(`create ${absolutePath}`);
    if (this.files.has(absolutePath)) throw this.coded("EEXIST", absolutePath);
    this.files.set(absolutePath, content);
  }

  async linkNoClobber(tempPath: string, targetPath: string): Promise<void> {
    this.ops.push(`link ${tempPath} -> ${targetPath}`);
    if (this.files.has(targetPath)) throw this.coded("EEXIST", targetPath);
    const content = this.files.get(tempPath);
    if (content === undefined) throw this.coded("ENOENT", tempPath);
    this.files.set(targetPath, content);
  }

  async renameOverwrite(tempPath: string, targetPath: string): Promise<void> {
    this.ops.push(`rename ${tempPath} -> ${targetPath}`);
    const content = this.files.get(tempPath);
    if (content === undefined) throw this.coded("ENOENT", tempPath);
    this.files.set(targetPath, content);
    this.files.delete(tempPath);
  }

  async remove(absolutePath: string): Promise<void> {
    this.ops.push(`remove ${absolutePath}`);
    this.files.delete(absolutePath);
  }

  tempFiles(): string[] {
    return [...this.files.keys()].filter((k) => k.includes(".fake-tmp-"));
  }
}

describe("applySchedulerFailureTransition: injected fake-I/O seam", () => {
  const VAULT = "/fake-vault";
  const CLAIMED = `team/kimi/inbox/${CLAIMED_NAME}`;
  const CLAIMED_ABS = `${VAULT}/${CLAIMED}`;
  const PENDING_ABS = `${VAULT}/team/kimi/inbox/${TASK_ID}.md`;
  const RETRYABLE = taskFile({
    id: TASK_ID,
    extraFrontmatter: ["retry:", "  safe_to_retry: true", "  max_attempts: 2", "  backoff_seconds: 300"],
  });

  function seed(): FakeRetryIo {
    const io = new FakeRetryIo();
    io.files.set(CLAIMED_ABS, RETRYABLE);
    return io;
  }

  it("requeues through read -> temp create -> no-clobber link -> unlink, deterministically", async () => {
    const io = seed();
    const result = await applySchedulerFailureTransition({
      vaultRoot: VAULT,
      agentName: "kimi",
      claimedTaskPath: CLAIMED,
      failureKind: "launch_failure",
      now: () => NOW,
      io,
    });
    expect(result.action).toBe("requeued");
    if (result.action !== "requeued") return;
    // Exact deterministic operation protocol, including the injected temp name.
    const temp = `${PENDING_ABS}.fake-tmp-0`;
    expect(io.ops).toEqual([
      `read ${CLAIMED_ABS}`,
      `create ${temp}`,
      `link ${temp} -> ${PENDING_ABS}`,
      `remove ${temp}`,
      `remove ${CLAIMED_ABS}`,
    ]);
    // Pending restored with visible state; claimed gone; no temp left behind.
    expect(io.files.has(PENDING_ABS)).toBe(true);
    expect(io.files.has(CLAIMED_ABS)).toBe(false);
    expect(io.tempFiles()).toEqual([]);
    const restored = io.files.get(PENDING_ABS) ?? "";
    expect(restored).toContain("attempts: 1");
    expect(restored).toContain("next_eligible_at: 2026-07-23T12:05:00.000Z");
  });

  it("a no-clobber link collision holds, preserves both files, and cleans the temp", async () => {
    const io = seed();
    const conflicting = taskFile({ id: TASK_ID, body: "Conflicting duplicate." });
    io.files.set(PENDING_ABS, conflicting);
    const result = await applySchedulerFailureTransition({
      vaultRoot: VAULT,
      agentName: "kimi",
      claimedTaskPath: CLAIMED,
      failureKind: "launch_failure",
      now: () => NOW,
      io,
    });
    expect(result.action).toBe("held");
    if (result.action !== "held") return;
    expect(result.reason).toContain("pending restore target already exists");
    expect(io.files.get(CLAIMED_ABS)).toBe(RETRYABLE);
    expect(io.files.get(PENDING_ABS)).toBe(conflicting);
    expect(io.tempFiles()).toEqual([]);
  });

  it("a missing claimed file holds without any write operations", async () => {
    const io = new FakeRetryIo();
    const result = await applySchedulerFailureTransition({
      vaultRoot: VAULT,
      agentName: "kimi",
      claimedTaskPath: CLAIMED,
      failureKind: "launch_failure",
      now: () => NOW,
      io,
    });
    expect(result.action).toBe("held");
    if (result.action !== "held") return;
    expect(result.reason).toContain("not found");
    expect(io.ops).toEqual([`read ${CLAIMED_ABS}`]);
    expect(io.files.size).toBe(0);
  });

  it("exhaustion rewrites the claimed file via temp + overwrite rename, never restores", async () => {
    const io = new FakeRetryIo();
    const almostDone = taskFile({
      id: TASK_ID,
      extraFrontmatter: [
        "retry:",
        "  safe_to_retry: true",
        "  max_attempts: 1",
        "  backoff_seconds: 300",
      ],
    });
    io.files.set(CLAIMED_ABS, almostDone);
    const result = await applySchedulerFailureTransition({
      vaultRoot: VAULT,
      agentName: "kimi",
      claimedTaskPath: CLAIMED,
      failureKind: "launch_failure",
      now: () => NOW,
      io,
    });
    expect(result.action).toBe("exhausted");
    if (result.action !== "exhausted") return;
    const temp = `${CLAIMED_ABS}.fake-tmp-0`;
    expect(io.ops).toEqual([
      `read ${CLAIMED_ABS}`,
      `create ${temp}`,
      `rename ${temp} -> ${CLAIMED_ABS}`,
    ]);
    expect(io.files.has(PENDING_ABS)).toBe(false);
    const claimed = io.files.get(CLAIMED_ABS) ?? "";
    expect(claimed).toContain("attempts: 1");
    expect(claimed).toContain("last_failure: launch_failure");
    expect(io.tempFiles()).toEqual([]);
  });

  it("an unexpected temp-write failure holds with the error and leaves the claim untouched", async () => {
    const io = seed();
    const original = io.createExclusive.bind(io);
    io.createExclusive = async (path: string, content: string): Promise<void> => {
      if (path.includes(".fake-tmp-")) throw new Error("EIO: disk full");
      return original(path, content);
    };
    const result = await applySchedulerFailureTransition({
      vaultRoot: VAULT,
      agentName: "kimi",
      claimedTaskPath: CLAIMED,
      failureKind: "launch_failure",
      now: () => NOW,
      io,
    });
    // Fail closed: held with the underlying error, claim untouched, no pending file.
    expect(result.action).toBe("held");
    if (result.action !== "held") return;
    expect(result.reason).toContain("pending restore failed");
    expect(result.reason).toContain("EIO: disk full");
    expect(io.files.get(CLAIMED_ABS)).toBe(RETRYABLE);
    expect(io.files.has(PENDING_ABS)).toBe(false);
    expect(io.tempFiles()).toEqual([]);
  });

  it("post-start holds perform no I/O at all", async () => {
    const io = seed();
    const result = await applySchedulerFailureTransition({
      vaultRoot: VAULT,
      agentName: "kimi",
      claimedTaskPath: CLAIMED,
      failureKind: "timeout",
      now: () => NOW,
      io,
    });
    expect(result.action).toBe("held");
    expect(io.ops).toEqual([]);
    expect(io.files.get(CLAIMED_ABS)).toBe(RETRYABLE);
  });
});
