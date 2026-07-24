import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evaluateReleaseEligibility,
  releaseCompletedClaimedTask,
} from "../src/scheduler-release.js";
import type { RetryTransitionIo } from "../src/scheduler-retry.js";
import {
  evaluateTaskDependencyEligibility,
  loadSchedulerInboxState,
} from "../src/scheduler-dependencies.js";

// ---------------------------------------------------------------------------
// Scheduler completion release (ADR-0038 revision 2, R3)
//
// A successfully scheduler-executed inbox task is released from its claimed
// filename back to the ordinary inbox filename byte-for-byte, so a completed
// prerequisite can satisfy `depends_on` and dependent chains advance. The
// transition reuses the R2 fail-closed two-step no-clobber protocol.
// ---------------------------------------------------------------------------

function taskFile(opts: {
  id: string;
  status?: string;
  extraFrontmatter?: string[];
  body?: string;
  result?: string;
}): string {
  const lines = [
    "---",
    "type: Task",
    `id: ${opts.id}`,
    "from: sam",
    "to: kimi",
    "priority: normal",
    `status: ${opts.status ?? "completed"}`,
    "created: 2026-07-24T10:00:00.000Z",
    "updated: 2026-07-24T11:00:00.000Z",
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
    opts.result ?? "Done.",
    "",
  ];
  return lines.join("\n");
}

const TASK_ID = "20260724T100000000Z-release-me";
const CLAIMED_NAME = `${TASK_ID}.claimed.heimdall.md`;
const ORDINARY_NAME = `${TASK_ID}.md`;

async function seedClaimedTask(vault: string, content: string, name: string = CLAIMED_NAME): Promise<string> {
  const inbox = join(vault, "team", "kimi", "inbox");
  await mkdir(inbox, { recursive: true });
  await writeFile(join(inbox, name), content);
  return `team/kimi/inbox/${name}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("evaluateReleaseEligibility", () => {
  it("is eligible when the task status is exactly completed", () => {
    const r = evaluateReleaseEligibility({ content: taskFile({ id: TASK_ID }) });
    expect(r).toEqual({ eligible: true });
  });

  for (const status of ["pending", "in_progress", "cancelled"] as const) {
    it(`is not eligible when the task status is ${status}`, () => {
      const r = evaluateReleaseEligibility({ content: taskFile({ id: TASK_ID, status }) });
      expect(r.eligible).toBe(false);
      expect(r.reason).toContain(`status is '${status}'`);
      expect(r.reason).toContain("remains claimed");
    });
  }

  it("is not eligible for an unknown status value", () => {
    const r = evaluateReleaseEligibility({ content: taskFile({ id: TASK_ID, status: "done" }) });
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("status is 'done'");
  });

  it("is not eligible when the status field is missing", () => {
    const content = taskFile({ id: TASK_ID }).replace("status: completed\n", "");
    const r = evaluateReleaseEligibility({ content });
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("missing a valid status field");
  });

  it("is not eligible when the file has no frontmatter", () => {
    const r = evaluateReleaseEligibility({ content: "# no frontmatter\n" });
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("frontmatter");
  });

  it("is not eligible when the frontmatter YAML is unparseable", () => {
    const r = evaluateReleaseEligibility({ content: "---\n: [unterminated\n---\nbody\n" });
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("frontmatter");
  });

  it("never infers completion from the result body when the status is not completed", () => {
    const r = evaluateReleaseEligibility({
      content: taskFile({ id: TASK_ID, status: "pending", result: "Everything succeeded." }),
    });
    expect(r.eligible).toBe(false);
  });
});

describe("releaseCompletedClaimedTask (real fs)", () => {
  let vault: string;
  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), "piren-release-"));
  });
  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
  });

  it("releases a validated completed claimed task to its ordinary filename byte-for-byte", async () => {
    const content = taskFile({ id: TASK_ID });
    const claimedPath = await seedClaimedTask(vault, content);
    const result = await releaseCompletedClaimedTask({
      vaultRoot: vault,
      agentName: "kimi",
      claimedTaskPath: claimedPath,
      expectedDeviceId: "heimdall",
    });
    expect(result.action).toBe("released");
    if (result.action !== "released") return;
    expect(result.restoredPath).toBe(`team/kimi/inbox/${ORDINARY_NAME}`);
    // Ordinary file is byte-for-byte identical; claimed file is gone.
    expect(await readFile(join(vault, result.restoredPath), "utf8")).toBe(content);
    expect(await pathExists(join(vault, claimedPath))).toBe(false);
  });

  it("preserves prior retry_state byte-for-byte when a retried task finally completes", async () => {
    const content = taskFile({
      id: TASK_ID,
      extraFrontmatter: [
        "retry:",
        "  safe_to_retry: true",
        "  max_attempts: 2",
        "  backoff_seconds: 300",
        "retry_state:",
        "  attempts: 1",
        '  last_attempt_at: "2026-07-24T09:00:00.000Z"',
        '  next_eligible_at: "2026-07-24T09:05:00.000Z"',
        "  last_failure: launch_failure",
      ],
    });
    const claimedPath = await seedClaimedTask(vault, content);
    const result = await releaseCompletedClaimedTask({
      vaultRoot: vault,
      agentName: "kimi",
      claimedTaskPath: claimedPath,
      expectedDeviceId: "heimdall",
    });
    expect(result.action).toBe("released");
    if (result.action !== "released") return;
    expect(await readFile(join(vault, result.restoredPath), "utf8")).toBe(content);
  });

  it("holds and preserves the claim when the claiming device is not this scheduler device", async () => {
    const content = taskFile({ id: TASK_ID });
    const claimedPath = await seedClaimedTask(vault, content);
    const result = await releaseCompletedClaimedTask({
      vaultRoot: vault,
      agentName: "kimi",
      claimedTaskPath: claimedPath,
      expectedDeviceId: "thor",
    });
    expect(result.action).toBe("held");
    if (result.action !== "held") return;
    expect(result.reason).toContain("heimdall");
    expect(result.reason).toContain("thor");
    expect(await readFile(join(vault, claimedPath), "utf8")).toBe(content);
    expect(await pathExists(join(vault, "team", "kimi", "inbox", ORDINARY_NAME))).toBe(false);
  });

  for (const status of ["pending", "in_progress", "cancelled"] as const) {
    it(`holds and preserves the claim when the task status is ${status}`, async () => {
      const content = taskFile({ id: TASK_ID, status });
      const claimedPath = await seedClaimedTask(vault, content);
      const result = await releaseCompletedClaimedTask({
        vaultRoot: vault,
        agentName: "kimi",
        claimedTaskPath: claimedPath,
        expectedDeviceId: "heimdall",
      });
      expect(result.action).toBe("held");
      if (result.action !== "held") return;
      expect(result.reason).toContain(`status is '${status}'`);
      expect(await readFile(join(vault, claimedPath), "utf8")).toBe(content);
      expect(await pathExists(join(vault, "team", "kimi", "inbox", ORDINARY_NAME))).toBe(false);
    });
  }

  it("holds when the claimed file is already gone", async () => {
    await mkdir(join(vault, "team", "kimi", "inbox"), { recursive: true });
    const result = await releaseCompletedClaimedTask({
      vaultRoot: vault,
      agentName: "kimi",
      claimedTaskPath: `team/kimi/inbox/${CLAIMED_NAME}`,
      expectedDeviceId: "heimdall",
    });
    expect(result.action).toBe("held");
    if (result.action !== "held") return;
    expect(result.reason).toContain("not found");
  });

  it("holds without clobbering when the ordinary file already exists (concurrent claim or duplicate)", async () => {
    const content = taskFile({ id: TASK_ID });
    const conflicting = taskFile({ id: TASK_ID, body: "Conflicting duplicate." });
    const claimedPath = await seedClaimedTask(vault, content);
    await writeFile(join(vault, "team", "kimi", "inbox", ORDINARY_NAME), conflicting);
    const result = await releaseCompletedClaimedTask({
      vaultRoot: vault,
      agentName: "kimi",
      claimedTaskPath: claimedPath,
      expectedDeviceId: "heimdall",
    });
    expect(result.action).toBe("held");
    if (result.action !== "held") return;
    expect(result.reason).toContain("already exists");
    // Both files preserved byte-for-byte.
    expect(await readFile(join(vault, claimedPath), "utf8")).toBe(content);
    expect(await readFile(join(vault, "team", "kimi", "inbox", ORDINARY_NAME), "utf8")).toBe(conflicting);
  });

  it("rejects a non-claimed task path", async () => {
    const ordinary = await seedClaimedTask(vault, taskFile({ id: TASK_ID }), ORDINARY_NAME);
    await expect(
      releaseCompletedClaimedTask({
        vaultRoot: vault,
        agentName: "kimi",
        claimedTaskPath: ordinary,
        expectedDeviceId: "heimdall",
      }),
    ).rejects.toThrow(/claimed/);
  });

  it("rejects a claimed path belonging to another agent", async () => {
    const claimedPath = await seedClaimedTask(vault, taskFile({ id: TASK_ID }));
    await expect(
      releaseCompletedClaimedTask({
        vaultRoot: vault,
        agentName: "zai",
        claimedTaskPath: claimedPath,
        expectedDeviceId: "heimdall",
      }),
    ).rejects.toThrow(/belongs to agent/);
  });

  it("a released completed prerequisite satisfies a dependent task on the next load", async () => {
    const DEPENDENT_ID = "20260724T100001000Z-dependent-task";
    const claimedPath = await seedClaimedTask(vault, taskFile({ id: TASK_ID }));
    const dependent = taskFile({
      id: DEPENDENT_ID,
      status: "pending",
      extraFrontmatter: ["depends_on:", `  - ${TASK_ID}`],
    });
    await writeFile(join(vault, "team", "kimi", "inbox", `${DEPENDENT_ID}.md`), dependent);

    // Before release: the claimed prerequisite never satisfies (ADR-0038 R1).
    const before = await loadSchedulerInboxState({ vaultRoot: vault, enabledAgents: ["kimi"] });
    const blockedCandidate = before.pendingTasks.find((t) => t.id === DEPENDENT_ID);
    expect(blockedCandidate).toBeDefined();
    const blocked = evaluateTaskDependencyEligibility(
      { id: DEPENDENT_ID, status: "pending", dependsOn: [TASK_ID], path: "x" },
      before.dependencyNodes,
      before.duplicateIds,
    );
    expect(blocked.eligible).toBe(false);
    expect(blocked.reason).toContain("(claimed)");

    const released = await releaseCompletedClaimedTask({
      vaultRoot: vault,
      agentName: "kimi",
      claimedTaskPath: claimedPath,
      expectedDeviceId: "heimdall",
    });
    expect(released.action).toBe("released");

    // After release: the completed prerequisite satisfies; the dependent is a
    // pending candidate and passes the dependency gate.
    const after = await loadSchedulerInboxState({ vaultRoot: vault, enabledAgents: ["kimi"] });
    expect(after.pendingTasks.map((t) => t.id)).toEqual([DEPENDENT_ID]);
    const eligible = evaluateTaskDependencyEligibility(
      { id: DEPENDENT_ID, status: "pending", dependsOn: [TASK_ID], path: "x" },
      after.dependencyNodes,
      after.duplicateIds,
    );
    expect(eligible).toEqual({ eligible: true });
  });

  it("the duplicate-ID crash window stays fail-closed: R1 blocks the dependent until triage", async () => {
    const DEPENDENT_ID = "20260724T100001000Z-dependent-task";
    const content = taskFile({ id: TASK_ID });
    // Simulate a crash between the no-clobber link and the claimed unlink:
    // BOTH the ordinary restored file and the claimed file are visible.
    await seedClaimedTask(vault, content);
    await writeFile(join(vault, "team", "kimi", "inbox", ORDINARY_NAME), content);
    await writeFile(
      join(vault, "team", "kimi", "inbox", `${DEPENDENT_ID}.md`),
      taskFile({ id: DEPENDENT_ID, status: "pending", extraFrontmatter: ["depends_on:", `  - ${TASK_ID}`] }),
    );

    const state = await loadSchedulerInboxState({ vaultRoot: vault, enabledAgents: ["kimi"] });
    expect(state.duplicateIds.has(TASK_ID)).toBe(true);
    expect(state.dependencyNodes.has(TASK_ID)).toBe(false);
    const blocked = evaluateTaskDependencyEligibility(
      { id: DEPENDENT_ID, status: "pending", dependsOn: [TASK_ID], path: "x" },
      state.dependencyNodes,
      state.duplicateIds,
    );
    expect(blocked.eligible).toBe(false);
    expect(blocked.reason).toContain("duplicate task id");
  });
});

// ---------------------------------------------------------------------------
// Injected fake-I/O seam (deterministic transition protocol)
// ---------------------------------------------------------------------------

class FakeReleaseIo implements RetryTransitionIo {
  readonly files = new Map<string, string>();
  readonly ops: string[] = [];
  private counter = 0;
  failLinkWith?: Error;
  failReadWith?: Error;
  failRemoveClaimed = false;

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
    if (this.failReadWith !== undefined) throw this.failReadWith;
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
    if (this.failLinkWith !== undefined) throw this.failLinkWith;
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
    if (this.failRemoveClaimed && absolutePath.endsWith(".md") && !absolutePath.includes(".fake-tmp-")) {
      throw this.coded("EIO", absolutePath);
    }
    this.files.delete(absolutePath);
  }

  tempFiles(): string[] {
    return [...this.files.keys()].filter((k) => k.includes(".fake-tmp-"));
  }
}

describe("releaseCompletedClaimedTask: injected fake-I/O seam", () => {
  const VAULT = "/fake-vault";
  const CLAIMED = `team/kimi/inbox/${CLAIMED_NAME}`;
  const CLAIMED_ABS = `${VAULT}/${CLAIMED}`;
  const ORDINARY_ABS = `${VAULT}/team/kimi/inbox/${ORDINARY_NAME}`;
  const COMPLETED = taskFile({ id: TASK_ID });

  function seed(): FakeReleaseIo {
    const io = new FakeReleaseIo();
    io.files.set(CLAIMED_ABS, COMPLETED);
    return io;
  }

  it("releases through read -> temp create -> no-clobber link -> temp cleanup -> claimed unlink", async () => {
    const io = seed();
    const result = await releaseCompletedClaimedTask({
      vaultRoot: VAULT,
      agentName: "kimi",
      claimedTaskPath: CLAIMED,
      expectedDeviceId: "heimdall",
      io,
    });
    expect(result.action).toBe("released");
    if (result.action !== "released") return;
    const temp = `${ORDINARY_ABS}.fake-tmp-0`;
    expect(io.ops).toEqual([
      `read ${CLAIMED_ABS}`,
      `create ${temp}`,
      `link ${temp} -> ${ORDINARY_ABS}`,
      `remove ${temp}`,
      `remove ${CLAIMED_ABS}`,
    ]);
    expect(io.files.get(ORDINARY_ABS)).toBe(COMPLETED);
    expect(io.files.has(CLAIMED_ABS)).toBe(false);
    expect(io.tempFiles()).toEqual([]);
  });

  it("a not-completed task performs no write operations at all", async () => {
    const io = new FakeReleaseIo();
    io.files.set(CLAIMED_ABS, taskFile({ id: TASK_ID, status: "in_progress" }));
    const result = await releaseCompletedClaimedTask({
      vaultRoot: VAULT,
      agentName: "kimi",
      claimedTaskPath: CLAIMED,
      expectedDeviceId: "heimdall",
      io,
    });
    expect(result.action).toBe("held");
    expect(io.ops).toEqual([`read ${CLAIMED_ABS}`]);
    expect(io.files.has(CLAIMED_ABS)).toBe(true);
  });

  it("a device mismatch performs no I/O at all", async () => {
    const io = seed();
    const result = await releaseCompletedClaimedTask({
      vaultRoot: VAULT,
      agentName: "kimi",
      claimedTaskPath: CLAIMED,
      expectedDeviceId: "thor",
      io,
    });
    expect(result.action).toBe("held");
    expect(io.ops).toEqual([]);
  });

  it("a missing claimed file holds without any write operations", async () => {
    const io = new FakeReleaseIo();
    const result = await releaseCompletedClaimedTask({
      vaultRoot: VAULT,
      agentName: "kimi",
      claimedTaskPath: CLAIMED,
      expectedDeviceId: "heimdall",
      io,
    });
    expect(result.action).toBe("held");
    if (result.action !== "held") return;
    expect(result.reason).toContain("not found");
    expect(io.ops).toEqual([`read ${CLAIMED_ABS}`]);
  });

  it("a non-ENOENT claimed-read failure (EACCES) holds with the actual error and performs no writes", async () => {
    const io = seed();
    const eacces = new Error("EACCES: permission denied");
    (eacces as { code?: string }).code = "EACCES";
    io.failReadWith = eacces;
    const result = await releaseCompletedClaimedTask({
      vaultRoot: VAULT,
      agentName: "kimi",
      claimedTaskPath: CLAIMED,
      expectedDeviceId: "heimdall",
      io,
    });
    expect(result.action).toBe("held");
    if (result.action !== "held") return;
    // The actual error is reported; it is NOT misreported as a concurrent
    // transition ("not found").
    expect(result.reason).toContain("EACCES");
    expect(result.reason).not.toContain("not found");
    expect(io.ops).toEqual([`read ${CLAIMED_ABS}`]);
    // Claimed file preserved; nothing written.
    expect(io.files.get(CLAIMED_ABS)).toBe(COMPLETED);
    expect(io.files.has(ORDINARY_ABS)).toBe(false);
    expect(io.tempFiles()).toEqual([]);
  });

  it("a no-clobber link collision holds, preserves both files, and cleans the temp", async () => {
    const io = seed();
    const conflicting = taskFile({ id: TASK_ID, body: "Conflicting duplicate." });
    io.files.set(ORDINARY_ABS, conflicting);
    const result = await releaseCompletedClaimedTask({
      vaultRoot: VAULT,
      agentName: "kimi",
      claimedTaskPath: CLAIMED,
      expectedDeviceId: "heimdall",
      io,
    });
    expect(result.action).toBe("held");
    if (result.action !== "held") return;
    expect(result.reason).toContain("already exists");
    expect(io.files.get(CLAIMED_ABS)).toBe(COMPLETED);
    expect(io.files.get(ORDINARY_ABS)).toBe(conflicting);
    expect(io.tempFiles()).toEqual([]);
  });

  it("a non-collision link failure holds with the error, preserves the claim, and cleans the temp", async () => {
    const io = seed();
    io.failLinkWith = new Error("EACCES: permission denied");
    const result = await releaseCompletedClaimedTask({
      vaultRoot: VAULT,
      agentName: "kimi",
      claimedTaskPath: CLAIMED,
      expectedDeviceId: "heimdall",
      io,
    });
    expect(result.action).toBe("held");
    if (result.action !== "held") return;
    expect(result.reason).toContain("EACCES");
    expect(io.files.get(CLAIMED_ABS)).toBe(COMPLETED);
    expect(io.files.has(ORDINARY_ABS)).toBe(false);
    expect(io.tempFiles()).toEqual([]);
  });

  it("a claimed-unlink failure after the restore retains BOTH files as the duplicate-ID recovery state", async () => {
    const io = seed();
    io.failRemoveClaimed = true;
    const result = await releaseCompletedClaimedTask({
      vaultRoot: VAULT,
      agentName: "kimi",
      claimedTaskPath: CLAIMED,
      expectedDeviceId: "heimdall",
      io,
    });
    expect(result.action).toBe("held");
    if (result.action !== "held") return;
    expect(result.reason).toContain("duplicate visible task id");
    // The restored ordinary file is never deleted (it may already be observed).
    expect(io.files.get(ORDINARY_ABS)).toBe(COMPLETED);
    expect(io.files.get(CLAIMED_ABS)).toBe(COMPLETED);
  });
});
