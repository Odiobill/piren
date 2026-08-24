import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initVault } from "../src/init.js";
import { schedulerDryRun } from "../src/scheduler-cli.js";

let root: string;
let vault: string;
let configPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-scheduler-cli-"));
  vault = join(root, "vault");
  configPath = join(root, "config.yml");
  await initVault({ vaultRoot: vault, agentName: "thor" });
});

afterEach(async () => rm(root, { recursive: true, force: true }));

/** Fully-enabled scheduler block (0.2.0 S2): pre-S2 dry-run tests exercise
 * proposals, so their local config fixtures explicitly enable every class. */
const SCHEDULER_ENABLED = "scheduler:\n  enabled: true\n  automation:\n    inbox_tasks: true\n    agent_cron: true\n    script_cron: true\n";

describe("scheduler dry-run CLI", () => {
  it("prints a claim proposal for a pending inbox task", async () => {
    // Write local config allowing thor
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\n${SCHEDULER_ENABLED}`);

    // Create a pending inbox task for thor
    await mkdir(join(vault, "team", "thor", "inbox"), { recursive: true });
    await writeFile(
      join(vault, "team", "thor", "inbox", "task-1.md"),
      "---\nid: task-1\nstatus: pending\nfrom: nora\nto: thor\ncreated: 2026-07-05T09:00:00Z\nupdated: 2026-07-05T09:00:00Z\n---\n\n# Test task\n\nDo something.",
    );

    const output = await schedulerDryRun({ configPath });

    expect(output).toContain("SCHEDULER DRY-RUN");
    expect(output).toContain("thor");
    expect(output).toContain("inbox_task");
    expect(output).toContain("task-1.md");
  });

  it("shows no claims when there is no pending work", async () => {
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\n${SCHEDULER_ENABLED}`);

    const output = await schedulerDryRun({ configPath });

    expect(output).toContain("SCHEDULER DRY-RUN");
    expect(output).not.toContain("[CLAIM]");
  });

  it("respects allowed_agents from local config", async () => {
    // Allow codex but tasks exist for thor only
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - codex\n${SCHEDULER_ENABLED}`);

    await mkdir(join(vault, "team", "codex"), { recursive: true });
    await mkdir(join(vault, "team", "thor", "inbox"), { recursive: true });
    await writeFile(
      join(vault, "team", "thor", "inbox", "task-1.md"),
      "---\nid: task-1\nstatus: pending\nfrom: nora\nto: thor\ncreated: 2026-07-05T09:00:00Z\nupdated: 2026-07-05T09:00:00Z\n---\n\n# Thor task\n\nDo something.",
    );

    const output = await schedulerDryRun({ configPath });

    // thor is not in allowed_agents, so no claim for its task
    expect(output).not.toContain("thor");
    expect(output).not.toContain("[CLAIM]");
  });

  it("excludes excluded_agents and remains claim-free (LLM-free)", async () => {
    // codex allowed but excluded; thor allowed and has a task.
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - codex\n  - thor\nexcluded_agents:\n  - codex\n${SCHEDULER_ENABLED}`);

    await mkdir(join(vault, "team", "thor", "inbox"), { recursive: true });
    await writeFile(
      join(vault, "team", "thor", "inbox", "task-1.md"),
      "---\nid: task-1\nstatus: pending\nfrom: nora\nto: thor\ncreated: 2026-07-05T09:00:00Z\nupdated: 2026-07-05T09:00:00Z\n---\n\n# Thor task\n\nDo something.",
    );

    const output = await schedulerDryRun({ configPath });

    // codex excluded: only thor is enabled.
    expect(output).not.toContain("agent: codex");
    expect(output).toContain("thor");
    expect(output).toContain("[CLAIM]");
    // Dry-run never claims or executes: the task file is still pending/unclaimed.
    const stillUnclaimed = await readFile(join(vault, "team", "thor", "inbox", "task-1.md"), "utf8");
    expect(stillUnclaimed).toContain("status: pending");
  });

  it("shows cron jobs owned by this device", async () => {
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\n${SCHEDULER_ENABLED}`);

    // Register a device so it appears as active
    const { registerDevice } = await import("../src/devices.js");
    await registerDevice({
      vaultRoot: vault,
      agentName: "thor",
      deviceId: "test-device",
      hostname: "test.local",
      priority: 1,
      now: () => new Date("2026-07-05T09:00:00Z"),
    });

    // Create a cron job that allows this device
    await mkdir(join(vault, "cron", "jobs"), { recursive: true });
    await writeFile(
      join(vault, "cron", "jobs", "hourly-brief.md"),
      `---
id: hourly-brief
agent: thor
schedule: "0 * * * *"
enabled: true
mode: agent
prompt: "Brief me"
device_policy:
  mode: highest_priority
  allowed_devices:
    - test-device
---

Run the hourly briefing.`,
    );

    const output = await schedulerDryRun({ configPath, deviceId: "test-device", staleAfterMs: 86_400_000, now: new Date("2026-07-05T10:00:00Z") });

    expect(output).toContain("cron_job");
    expect(output).toContain("hourly-brief.md");
    expect(output).toContain("[CLAIM]");
  });

  it("reports a dependency-blocked task with its reason and proposes no claim for it", async () => {
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\n${SCHEDULER_ENABLED}`);
    await mkdir(join(vault, "team", "thor", "inbox"), { recursive: true });

    // Implementation task (pending, no deps) -> claimable.
    await writeFile(
      join(vault, "team", "thor", "inbox", "20260721T120000000Z-implement-slice.md"),
      ["---", "id: 20260721T120000000Z-implement-slice", "status: pending", "from: nora", "to: thor", "created: 2026-07-21T09:00:00Z", "updated: 2026-07-21T09:00:00Z", "---", "", "# Impl", "", "Do it."].join("\n"),
    );
    // Review task (pending, depends on the still-pending impl) -> blocked.
    await writeFile(
      join(vault, "team", "thor", "inbox", "20260721T130000000Z-review-slice.md"),
      ["---", "id: 20260721T130000000Z-review-slice", "status: pending", "depends_on:", "  - 20260721T120000000Z-implement-slice", "from: nora", "to: thor", "created: 2026-07-21T09:00:00Z", "updated: 2026-07-21T09:00:00Z", "---", "", "# Review", "", "Review it."].join("\n"),
    );

    const output = await schedulerDryRun({ configPath });

    // The runnable impl is proposed for a claim.
    expect(output).toContain("[CLAIM]");
    expect(output).toContain("implement-slice");
    // The review is dependency-blocked with an exact reason, not claimed.
    expect(output).toContain("[BLOCK]");
    expect(output).toContain("review-slice");
    expect(output).toContain("unsatisfied");
    // Dry-run never mutates vault state.
    const review = await readFile(join(vault, "team", "thor", "inbox", "20260721T130000000Z-review-slice.md"), "utf8");
    expect(review).toContain("status: pending");
  });

  it("proposes a claim for a task once its prerequisite is completed", async () => {
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\n${SCHEDULER_ENABLED}`);
    await mkdir(join(vault, "team", "thor", "inbox"), { recursive: true });

    await writeFile(
      join(vault, "team", "thor", "inbox", "20260721T120000000Z-implement-slice.md"),
      ["---", "id: 20260721T120000000Z-implement-slice", "status: completed", "from: nora", "to: thor", "created: 2026-07-21T09:00:00Z", "updated: 2026-07-21T09:00:00Z", "---", "", "# Impl", "", "Done."].join("\n"),
    );
    await writeFile(
      join(vault, "team", "thor", "inbox", "20260721T130000000Z-review-slice.md"),
      ["---", "id: 20260721T130000000Z-review-slice", "status: pending", "depends_on:", "  - 20260721T120000000Z-implement-slice", "from: nora", "to: thor", "created: 2026-07-21T09:00:00Z", "updated: 2026-07-21T09:00:00Z", "---", "", "# Review", "", "Review it."].join("\n"),
    );

    const output = await schedulerDryRun({ configPath });

    // The completed impl is not a pending candidate; the review is now runnable.
    expect(output).toContain("[CLAIM]");
    expect(output).toContain("review-slice");
    expect(output).not.toContain("[BLOCK]");
  });

  it("resolves a claimed prerequisite as unsatisfied, not missing", async () => {
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\n${SCHEDULER_ENABLED}`);
    await mkdir(join(vault, "team", "thor", "inbox"), { recursive: true });

    // The prerequisite is claimed (pending, claimed filename) by another device.
    await writeFile(
      join(vault, "team", "thor", "inbox", "20260721T120000000Z-implement-slice.claimed.ironman.md"),
      ["---", "id: 20260721T120000000Z-implement-slice", "status: pending", "from: nora", "to: thor", "created: 2026-07-21T09:00:00Z", "updated: 2026-07-21T09:00:00Z", "---", "", "# Impl", "", "In progress."].join("\n"),
    );
    await writeFile(
      join(vault, "team", "thor", "inbox", "20260721T130000000Z-review-slice.md"),
      ["---", "id: 20260721T130000000Z-review-slice", "status: pending", "depends_on:", "  - 20260721T120000000Z-implement-slice", "from: nora", "to: thor", "created: 2026-07-21T09:00:00Z", "updated: 2026-07-21T09:00:00Z", "---", "", "# Review", "", "Review it."].join("\n"),
    );

    const output = await schedulerDryRun({ configPath });

    // The claimed prerequisite blocks the review as unsatisfied (pending), and
    // is NOT reported as missing because the claimed file is still visible.
    expect(output).toContain("[BLOCK]");
    expect(output).toContain("review-slice");
    expect(output).toContain("unsatisfied");
    expect(output).not.toContain("missing");
    // The claimed prerequisite is itself not a pending candidate.
    expect(output).not.toContain("[CLAIM]");
  });

  it("blocks a review whose prerequisite is a completed but claimed task (ADR-0038)", async () => {
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\n${SCHEDULER_ENABLED}`);
    await mkdir(join(vault, "team", "thor", "inbox"), { recursive: true });

    // The prerequisite was claimed and marked completed; it keeps its claimed
    // filename. A claimed target must never satisfy, even when completed.
    await writeFile(
      join(vault, "team", "thor", "inbox", "20260721T120000000Z-implement-slice.claimed.ironman.md"),
      ["---", "id: 20260721T120000000Z-implement-slice", "status: completed", "from: nora", "to: thor", "created: 2026-07-21T09:00:00Z", "updated: 2026-07-21T09:00:00Z", "---", "", "# Impl", "", "Done."].join("\n"),
    );
    await writeFile(
      join(vault, "team", "thor", "inbox", "20260721T130000000Z-review-slice.md"),
      ["---", "id: 20260721T130000000Z-review-slice", "status: pending", "depends_on:", "  - 20260721T120000000Z-implement-slice", "from: nora", "to: thor", "created: 2026-07-21T09:00:00Z", "updated: 2026-07-21T09:00:00Z", "---", "", "# Review", "", "Review it."].join("\n"),
    );

    const output = await schedulerDryRun({ configPath });

    expect(output).toContain("[BLOCK]");
    expect(output).toContain("review-slice");
    expect(output).toContain("claimed");
    // A completed-but-claimed prerequisite must not satisfy.
    expect(output).not.toContain("[CLAIM]");
  });

  it("blocks claims and reports an exact reason when task ids are duplicated", async () => {
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\n${SCHEDULER_ENABLED}`);
    await mkdir(join(vault, "team", "thor", "inbox"), { recursive: true });

    // Two ordinary files share the same id (one completed, one pending).
    await writeFile(
      join(vault, "team", "thor", "inbox", "20260721T120000000Z-implement-slice.md"),
      ["---", "id: 20260721T120000000Z-implement-slice", "status: completed", "from: nora", "to: thor", "created: 2026-07-21T09:00:00Z", "updated: 2026-07-21T09:00:00Z", "---", "", "# Impl A", "", "Done."].join("\n"),
    );
    await writeFile(
      join(vault, "team", "thor", "inbox", "20260721T120000000Z-implement-slice-dup.md"),
      ["---", "id: 20260721T120000000Z-implement-slice", "status: pending", "from: nora", "to: thor", "created: 2026-07-21T09:00:00Z", "updated: 2026-07-21T09:00:00Z", "---", "", "# Impl B", "", "Do it."].join("\n"),
    );

    const output = await schedulerDryRun({ configPath });

    // The duplicated id is never claimable and is reported with an exact reason.
    expect(output).not.toContain("[CLAIM]");
    expect(output).toContain("[BLOCK]");
    expect(output).toContain("duplicate task id");
    expect(output).toContain("implement-slice");
  });

  it("reports a retry-backoff task with the exact R2 reason and proposes no claim for it", async () => {
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\n${SCHEDULER_ENABLED}`);
    await mkdir(join(vault, "team", "thor", "inbox"), { recursive: true });

    await writeFile(
      join(vault, "team", "thor", "inbox", "20260721T140000000Z-retryable-task.md"),
      [
        "---",
        "id: 20260721T140000000Z-retryable-task",
        "status: pending",
        "from: nora",
        "to: thor",
        "created: 2026-07-21T09:00:00Z",
        "updated: 2026-07-21T09:00:00Z",
        "retry:",
        "  safe_to_retry: true",
        "  max_attempts: 2",
        "  backoff_seconds: 300",
        "retry_state:",
        "  attempts: 1",
        '  last_attempt_at: "2026-07-05T09:56:00.000Z"',
        '  next_eligible_at: "2026-07-05T10:05:00.000Z"',
        "  last_failure: launch_failure",
        "---",
        "",
        "# Retryable",
        "",
        "Do it.",
      ].join("\n"),
    );

    const output = await schedulerDryRun({ configPath, now: new Date("2026-07-05T10:00:00.000Z") });

    expect(output).not.toContain("[CLAIM]");
    expect(output).toContain("[BLOCK]");
    expect(output).toContain("retryable-task");
    expect(output).toContain("retry backoff until 2026-07-05T10:05:00.000Z");
    // Dry-run never mutates vault state.
    const after = await readFile(join(vault, "team", "thor", "inbox", "20260721T140000000Z-retryable-task.md"), "utf8");
    expect(after).toContain("status: pending");
  });

  it("reports an exhausted-retry task with the exact R2 reason", async () => {
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\n${SCHEDULER_ENABLED}`);
    await mkdir(join(vault, "team", "thor", "inbox"), { recursive: true });

    await writeFile(
      join(vault, "team", "thor", "inbox", "20260721T140000000Z-retryable-task.md"),
      [
        "---",
        "id: 20260721T140000000Z-retryable-task",
        "status: pending",
        "from: nora",
        "to: thor",
        "created: 2026-07-21T09:00:00Z",
        "updated: 2026-07-21T09:00:00Z",
        "retry:",
        "  safe_to_retry: true",
        "  max_attempts: 1",
        "  backoff_seconds: 0",
        "retry_state:",
        "  attempts: 1",
        '  last_attempt_at: "2026-07-05T09:00:00.000Z"',
        '  next_eligible_at: "2026-07-05T09:00:00.000Z"',
        "  last_failure: launch_failure",
        "---",
        "",
        "# Retryable",
        "",
        "Do it.",
      ].join("\n"),
    );

    const output = await schedulerDryRun({ configPath, now: new Date("2026-07-05T10:00:00.000Z") });

    expect(output).not.toContain("[CLAIM]");
    expect(output).toContain("[BLOCK]");
    expect(output).toContain("retry attempts exhausted (1/1)");
  });

  it("reports an invalid retry policy with the exact R2 reason", async () => {
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\n${SCHEDULER_ENABLED}`);
    await mkdir(join(vault, "team", "thor", "inbox"), { recursive: true });

    await writeFile(
      join(vault, "team", "thor", "inbox", "20260721T140000000Z-retryable-task.md"),
      [
        "---",
        "id: 20260721T140000000Z-retryable-task",
        "status: pending",
        "from: nora",
        "to: thor",
        "created: 2026-07-21T09:00:00Z",
        "updated: 2026-07-21T09:00:00Z",
        "retry:",
        "  safe_to_retry: false",
        "  max_attempts: 2",
        "  backoff_seconds: 300",
        "---",
        "",
        "# Retryable",
        "",
        "Do it.",
      ].join("\n"),
    );

    const output = await schedulerDryRun({ configPath, now: new Date("2026-07-05T10:00:00.000Z") });

    expect(output).not.toContain("[CLAIM]");
    expect(output).toContain("[BLOCK]");
    expect(output).toContain("retry policy requires safe_to_retry: true");
  });

  it("reports malformed retry_state with the exact R2 reason", async () => {
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\n${SCHEDULER_ENABLED}`);
    await mkdir(join(vault, "team", "thor", "inbox"), { recursive: true });

    await writeFile(
      join(vault, "team", "thor", "inbox", "20260721T140000000Z-retryable-task.md"),
      [
        "---",
        "id: 20260721T140000000Z-retryable-task",
        "status: pending",
        "from: nora",
        "to: thor",
        "created: 2026-07-21T09:00:00Z",
        "updated: 2026-07-21T09:00:00Z",
        "retry:",
        "  safe_to_retry: true",
        "  max_attempts: 2",
        "  backoff_seconds: 300",
        "retry_state: not-a-mapping",
        "---",
        "",
        "# Retryable",
        "",
        "Do it.",
      ].join("\n"),
    );

    const output = await schedulerDryRun({ configPath, now: new Date("2026-07-05T10:00:00.000Z") });

    expect(output).not.toContain("[CLAIM]");
    expect(output).toContain("[BLOCK]");
    expect(output).toContain("retry_state must be a mapping");
  });

  it("proposes a claim for a retryable task whose backoff has expired", async () => {
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\n${SCHEDULER_ENABLED}`);
    await mkdir(join(vault, "team", "thor", "inbox"), { recursive: true });

    await writeFile(
      join(vault, "team", "thor", "inbox", "20260721T140000000Z-retryable-task.md"),
      [
        "---",
        "id: 20260721T140000000Z-retryable-task",
        "status: pending",
        "from: nora",
        "to: thor",
        "created: 2026-07-21T09:00:00Z",
        "updated: 2026-07-21T09:00:00Z",
        "retry:",
        "  safe_to_retry: true",
        "  max_attempts: 2",
        "  backoff_seconds: 300",
        "retry_state:",
        "  attempts: 1",
        '  last_attempt_at: "2026-07-05T09:00:00.000Z"',
        '  next_eligible_at: "2026-07-05T09:05:00.000Z"',
        "  last_failure: launch_failure",
        "---",
        "",
        "# Retryable",
        "",
        "Do it.",
      ].join("\n"),
    );

    const output = await schedulerDryRun({ configPath, now: new Date("2026-07-05T10:00:00.000Z") });

    expect(output).toContain("[CLAIM]");
    expect(output).toContain("retryable-task");
    expect(output).not.toContain("[BLOCK]");
  });
});

describe("scheduler dry-run automation gates (0.2.0 S2)", () => {
  async function writePendingTask(agent: string, name: string): Promise<void> {
    await mkdir(join(vault, "team", agent, "inbox"), { recursive: true });
    await writeFile(
      join(vault, "team", agent, "inbox", `${name}.md`),
      `---\nid: ${name}\nstatus: pending\nfrom: nora\nto: ${agent}\ncreated: 2026-07-05T09:00:00Z\nupdated: 2026-07-05T09:00:00Z\n---\n\n# ${name}\n\nDo something.`,
    );
  }

  async function registerThisDevice(agent: string): Promise<void> {
    const { registerDevice } = await import("../src/devices.js");
    await registerDevice({
      vaultRoot: vault,
      agentName: agent,
      deviceId: "test-device",
      hostname: "test.local",
      priority: 1,
      now: () => new Date("2026-07-05T09:00:00Z"),
    });
  }

  async function writeOwnedAgentCron(agent: string, id: string): Promise<void> {
    await mkdir(join(vault, "cron", "jobs"), { recursive: true });
    await writeFile(
      join(vault, "cron", "jobs", `${id}.md`),
      `---\nid: ${id}\nagent: ${agent}\nschedule: "0 * * * *"\nenabled: true\nmode: agent\ndevice_policy:\n  mode: highest_priority\n  allowed_devices:\n    - test-device\n---\n\nRun it.`,
    );
  }

  it("emits bounded [SKIPPED] lines for disabled classes and proposes only enabled classes", async () => {
    await writeFile(
      configPath,
      `vault_root: ${vault}\nallowed_agents:\n  - thor\nscheduler:\n  enabled: true\n  automation:\n    inbox_tasks: false\n    agent_cron: true\n    script_cron: false\n`,
    );
    await writePendingTask("thor", "gated-task");
    await registerThisDevice("thor");
    await writeOwnedAgentCron("thor", "owned-job");

    const output = await schedulerDryRun({
      configPath,
      deviceId: "test-device",
      staleAfterMs: 86_400_000,
      now: new Date("2026-07-05T10:00:00Z"),
    });

    expect(output).toContain("automation: inbox_tasks=off agent_cron=on script_cron=off");
    expect(output).toContain("[SKIPPED] script_cron - automation disabled");
    expect(output).not.toContain("[SKIPPED] agent_cron");
    // enabled:true is inert-to-ignore: bounded legacy notice, no execution.
    expect(output).toMatch(/inert-to-ignore/i);
    // Only the enabled class is proposed; the gated inbox task is listed as
    // [DISABLED] discovery (never a claim).
    expect(output).toContain("[CLAIM]");
    expect(output).toContain("owned-job");
    expect(output).toContain("[DISABLED] inbox_task   team/thor/inbox/gated-task.md - inbox automation disabled (no claim proposed)");
    expect(output).not.toMatch(/\[CLAIM\].*gated-task/);
    // Read-only: the pending task stays pending and unclaimed.
    const task = await readFile(join(vault, "team", "thor", "inbox", "gated-task.md"), "utf8");
    expect(task).toContain("status: pending");
  });

  it("legacy-gated config (enabled:false) proposes nothing, shows the gate notice, and lists inbox tasks as [DISABLED]", async () => {
    await writeFile(
      configPath,
      `vault_root: ${vault}\nallowed_agents:\n  - thor\nscheduler:\n  enabled: false\n  automation:\n    inbox_tasks: true\n    agent_cron: true\n    script_cron: true\n`,
    );
    await writePendingTask("thor", "gated-task");

    const output = await schedulerDryRun({ configPath });

    expect(output).toContain("automation: inbox_tasks=off agent_cron=off script_cron=off");
    expect(output).toMatch(/legacy gate: .*fail closed/i);
    expect(output).not.toContain("[CLAIM]");
    expect(output).toContain("[DISABLED] inbox_task   team/thor/inbox/gated-task.md - inbox automation disabled (no claim proposed)");
    const task = await readFile(join(vault, "team", "thor", "inbox", "gated-task.md"), "utf8");
    expect(task).toContain("status: pending");
  });

  it("fresh install (no scheduler block): no proposals, [SKIPPED] for cron classes, [DISABLED] for inbox tasks", async () => {
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\n`);
    await writePendingTask("thor", "fresh-task");

    const output = await schedulerDryRun({ configPath });

    expect(output).toContain("automation: inbox_tasks=off agent_cron=off script_cron=off");
    expect(output).toContain("[SKIPPED] agent_cron - automation disabled");
    expect(output).toContain("[SKIPPED] script_cron - automation disabled");
    expect(output).not.toContain("[CLAIM]");
    expect(output).toContain("[DISABLED] inbox_task   team/thor/inbox/fresh-task.md - inbox automation disabled (no claim proposed)");
  });

  it("discovery-complete: lists unclaimed inbox tasks with [DISABLED] when inbox automation is off", async () => {
    await writeFile(
      configPath,
      `vault_root: ${vault}\nallowed_agents:\n  - thor\nscheduler:\n  automation:\n    inbox_tasks: false\n    agent_cron: true\n    script_cron: false\n`,
    );
    await writePendingTask("thor", "discover-task");

    const output = await schedulerDryRun({ configPath });

    // Automation summary line always present.
    expect(output).toContain("automation: inbox_tasks=off agent_cron=on script_cron=off");
    // Every unclaimed pending inbox task is still listed with a bounded
    // [DISABLED] status; no claim is proposed for it.
    expect(output).toContain(
      "[DISABLED] inbox_task   team/thor/inbox/discover-task.md - inbox automation disabled (no claim proposed)",
    );
    expect(output).not.toContain("[CLAIM]");
    // Disabled cron stays class-level [SKIPPED].
    expect(output).toContain("[SKIPPED] script_cron - automation disabled");
    expect(output).not.toContain("[SKIPPED] agent_cron");
    // Read-only: the pending task stays pending and unclaimed.
    const task = await readFile(join(vault, "team", "thor", "inbox", "discover-task.md"), "utf8");
    expect(task).toContain("status: pending");
  });

  it("legacy-gated config (enabled:false) proposes nothing and lists inbox tasks as [DISABLED] with the gate notice", async () => {
    await writeFile(
      configPath,
      `vault_root: ${vault}\nallowed_agents:\n  - thor\nscheduler:\n  enabled: false\n  automation:\n    inbox_tasks: true\n    agent_cron: true\n    script_cron: true\n`,
    );
    await writePendingTask("thor", "gated-task");

    const output = await schedulerDryRun({ configPath });

    expect(output).toContain("automation: inbox_tasks=off agent_cron=off script_cron=off");
    expect(output).toMatch(/legacy gate/i);
    expect(output).toContain(
      "[DISABLED] inbox_task   team/thor/inbox/gated-task.md - inbox automation disabled (no claim proposed)",
    );
    expect(output).not.toContain("[CLAIM]");
    const task = await readFile(join(vault, "team", "thor", "inbox", "gated-task.md"), "utf8");
    expect(task).toContain("status: pending");
  });

  it("legacy block without an enabled key keeps class-driven proposals and emits no migration notice", async () => {
    await writeFile(
      configPath,
      `vault_root: ${vault}\nallowed_agents:\n  - thor\nscheduler:\n  poll_interval_seconds: 45\n  automation:\n    inbox_tasks: true\n    agent_cron: true\n    script_cron: true\n`,
    );
    await writePendingTask("thor", "legacy-task");

    const output = await schedulerDryRun({ configPath });

    expect(output).toContain("automation: inbox_tasks=on agent_cron=on script_cron=on");
    expect(output).not.toMatch(/migration:/i);
    expect(output).toContain("[CLAIM]");
    expect(output).toContain("legacy-task");
    // Read-only: no config write ever happens.
    const after = await readFile(configPath, "utf8");
    expect(after).not.toContain("enabled: true");
  });
});
