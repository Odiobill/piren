import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  sanitizeDeviceId,
  schedulerOnce,
  type CronAgentExecuteInput,
  type CronScriptExecuteInput,
  type InboxExecuteInput,
  type SchedulerOnceClaims,
  type SchedulerOnceExecutors,
} from "../src/scheduler-once.js";

let root: string;
let vault: string;
let configPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-scheduler-once-"));
  vault = join(root, "vault");
  configPath = join(root, "config.yml");
  await mkdir(join(vault, "cron", "jobs"), { recursive: true });
  await mkdir(join(vault, "cron", "runs"), { recursive: true });
  await mkdir(join(vault, "team", "codex", "inbox"), { recursive: true });
  await mkdir(join(vault, "team", "codex", "devices"), { recursive: true });
  await mkdir(join(vault, "team", "codex", "cron", "jobs"), { recursive: true });
  await mkdir(join(vault, "team", "codex", "cron", "runs"), { recursive: true });
  await writeFile(join(vault, ".piren-vault"), "");
});

afterEach(async () => rm(root, { recursive: true, force: true }));

async function writeConfig(opts: { allowed?: string[]; excluded?: string[] }): Promise<void> {
  const lines = [`vault_root: ${vault}`];
  if (opts.allowed && opts.allowed.length > 0) {
    lines.push("allowed_agents:");
    for (const a of opts.allowed) lines.push(`  - ${a}`);
  }
  if (opts.excluded && opts.excluded.length > 0) {
    lines.push("excluded_agents:");
    for (const a of opts.excluded) lines.push(`  - ${a}`);
  }
  await writeFile(configPath, lines.join("\n") + "\n");
}

async function writeInboxTask(agent: string, name: string): Promise<string> {
  await mkdir(join(vault, "team", agent, "inbox"), { recursive: true });
  const path = `team/${agent}/inbox/${name}.md`;
  await writeFile(join(vault, path), [
    "---",
    `id: ${name}`,
    "status: pending",
    "from: nora",
    `to: ${agent}`,
    "created: 2026-07-07T08:00:00Z",
    "updated: 2026-07-07T08:00:00Z",
    "---",
    "",
    `# ${name}`,
    "",
    "Do the work.",
    "",
  ].join("\n"));
  return path;
}

async function writeCronJob(opts: {
  id: string;
  agent: string;
  mode?: "agent" | "script";
  scope?: "shared" | "agent";
  script?: string;
  prompt?: string;
}): Promise<string> {
  const mode = opts.mode ?? "agent";
  const dir = opts.scope === "agent" ? join(vault, "team", opts.agent, "cron", "jobs") : join(vault, "cron", "jobs");
  await mkdir(dir, { recursive: true });
  const lines = ["---", `id: ${opts.id}`, `agent: ${opts.agent}`, 'schedule: "30m"', `mode: ${mode}`];
  if (opts.script) lines.push(`script: ${opts.script}`);
  lines.push("enabled: true", "device_policy:", "  mode: highest_priority", "  allowed_devices: []", "---", "");
  if (mode === "script") {
    lines.push("# Purpose", "", opts.prompt ?? "script job");
  } else {
    lines.push("# Prompt", "", opts.prompt ?? "Run the cron job.");
  }
  lines.push("");
  await writeFile(join(dir, `${opts.id}.md`), lines.join("\n"));
  return opts.scope === "agent" ? `team/${opts.agent}/cron/jobs/${opts.id}.md` : `cron/jobs/${opts.id}.md`;
}

function throwingExecutors(): SchedulerOnceExecutors {
  const boom = (): never => {
    throw new Error("executor should not be called");
  };
  return {
    executeInboxTask: boom,
    executeAgentCronJob: boom,
    executeScriptCronJob: boom,
  };
}

const tick = () => new Date("2026-07-07T08:00:00Z");

describe("schedulerOnce no-work and policy", () => {
  it("reports no-work and does not execute when no agents are enabled", async () => {
    await writeConfig({ allowed: [] });

    const result = await schedulerOnce({
      configPath,
      deviceId: "heimdall",
      now: tick,
      executors: throwingExecutors(),
    });

    expect(result.executed).toBe(false);
    expect(result.noWork).toBe(true);
    expect(result.enabledAgents).toEqual([]);
    expect(result.plannedCount).toBe(0);
    expect(result.summary).toMatch(/no work/i);
  });

  it("reports no-work when enabled agents have no pending tasks or due cron jobs", async () => {
    await writeConfig({ allowed: ["codex"] });

    const result = await schedulerOnce({
      configPath,
      deviceId: "heimdall",
      now: tick,
      executors: throwingExecutors(),
    });

    expect(result.executed).toBe(false);
    expect(result.noWork).toBe(true);
    expect(result.enabledAgents).toEqual(["codex"]);
    expect(result.plannedCount).toBe(0);
  });

  it("requires vault_root and reports no-work without executing", async () => {
    await writeFile(configPath, "allowed_agents:\n  - codex\n");

    const result = await schedulerOnce({
      configPath,
      deviceId: "heimdall",
      now: tick,
      executors: throwingExecutors(),
    });

    expect(result.executed).toBe(false);
    expect(result.noWork).toBe(true);
    expect(result.summary).toMatch(/vault root/i);
  });

  it("excludes excluded_agents from enabled agents before planning", async () => {
    // codex allowed but excluded; thor allowed and has a task.
    await writeConfig({ allowed: ["codex", "thor"], excluded: ["codex"] });
    await mkdir(join(vault, "team", "thor", "inbox"), { recursive: true });
    await mkdir(join(vault, "team", "thor", "devices"), { recursive: true });
    await writeInboxTask("thor", "thor-task");

    const result = await schedulerOnce({
      configPath,
      deviceId: "heimdall",
      now: tick,
      executors: throwingExecutors(),
    });

    expect(result.enabledAgents).toEqual(["thor"]);
    expect(result.noWork).toBe(false);
    // thor's task is planned but we use throwing executors only to prove policy;
    // the throw surfaces as an execution failure, not a no-work state.
  });
});

function recordingExecutors(): {
  executors: SchedulerOnceExecutors;
  inboxCalls: InboxExecuteInput[];
  cronAgentCalls: CronAgentExecuteInput[];
  cronScriptCalls: CronScriptExecuteInput[];
} {
  const inboxCalls: InboxExecuteInput[] = [];
  const cronAgentCalls: CronAgentExecuteInput[] = [];
  const cronScriptCalls: CronScriptExecuteInput[] = [];
  return {
    executors: {
      async executeInboxTask(input) {
        inboxCalls.push(input);
        return {
          agentName: input.agentName,
          deviceId: "heimdall",
          claimedTaskPath: input.claimedTaskPath,
          prompt: "",
          assistantText: "inbox done",
          exitCode: 0,
          ok: true,
        };
      },
      async executeAgentCronJob(input) {
        cronAgentCalls.push(input);
        return {
          agentName: input.agentName,
          deviceId: "heimdall",
          jobId: "",
          claimedJobPath: input.claimedJobPath,
          restoredJobPath: "",
          runRecordPath: "cron/runs/x.md",
          status: "completed",
          exitCode: 0,
          assistantText: "cron done",
          ok: true,
        };
      },
      async executeScriptCronJob(input) {
        cronScriptCalls.push(input);
        return {
          status: "completed",
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "script ok",
          stderr: "",
          runPath: "cron/runs/x.md",
          restoredJobPath: input.jobPath,
        };
      },
    },
    inboxCalls,
    cronAgentCalls,
    cronScriptCalls,
  };
}

function fakeClaims(opts: {
  inboxThrow?: (path: string) => boolean;
  cronThrow?: (path: string) => boolean;
}): {
  claims: SchedulerOnceClaims;
  inboxClaimCalls: string[];
  cronClaimCalls: string[];
} {
  const inboxClaimCalls: string[] = [];
  const cronClaimCalls: string[] = [];
  return {
    claims: {
      async claimInboxTask(o) {
        inboxClaimCalls.push(o.taskPath);
        if (opts.inboxThrow?.(o.taskPath)) throw new Error("already claimed by another device");
        const claimed = o.taskPath.replace(/\.md$/, `.claimed.${o.deviceId}.md`);
        return { agentName: o.agentName, deviceId: o.deviceId, originalPath: o.taskPath, path: claimed, absolutePath: "" };
      },
      async claimCronJob(o) {
        cronClaimCalls.push(o.jobPath);
        if (opts.cronThrow?.(o.jobPath)) throw new Error("already claimed by another device");
        const claimed = o.jobPath.replace(/\.md$/, `.claimed.${o.deviceId}.md`);
        return { originalPath: o.jobPath, path: claimed, absolutePath: "", deviceId: o.deviceId };
      },
    },
    inboxClaimCalls,
    cronClaimCalls,
  };
}

describe("schedulerOnce execution routing", () => {
  it("claims an inbox task via claimInboxTask then executes the claimed path once", async () => {
    await writeConfig({ allowed: ["codex"] });
    const taskPath = await writeInboxTask("codex", "task-a");
    const { executors, inboxCalls } = recordingExecutors();

    const result = await schedulerOnce({
      configPath,
      deviceId: "heimdall",
      now: tick,
      executors,
    });

    expect(result.executed).toBe(true);
    expect(result.executedItemType).toBe("inbox_task");
    expect(result.executedAgentName).toBe("codex");
    expect(inboxCalls).toHaveLength(1);
    expect(inboxCalls[0]?.claimedTaskPath).toMatch(/\.claimed\.heimdall\.md$/);
    expect(result.executedItemPath).toBe(inboxCalls[0]?.claimedTaskPath);
    // Real claim renamed the task file to the claimed path.
    await expect(readFile(join(vault, taskPath), "utf8")).rejects.toThrow();
    await expect(readFile(join(vault, inboxCalls[0]?.claimedTaskPath ?? "/none"), "utf8")).resolves.toBeDefined();
  });

  it("skips a failed claim attempt and continues to the next planned claim", async () => {
    await writeConfig({ allowed: ["codex"] });
    await writeInboxTask("codex", "task-a");
    await writeInboxTask("codex", "task-b");
    const { executors, inboxCalls } = recordingExecutors();
    const { claims } = fakeClaims({ inboxThrow: (p) => p.includes("task-a") });

    const result = await schedulerOnce({
      configPath,
      deviceId: "heimdall",
      now: tick,
      executors,
      claims,
    });

    expect(result.executed).toBe(true);
    expect(result.claimAttempts).toHaveLength(2);
    expect(result.claimAttempts[0]?.outcome).toBe("claim_failed");
    expect(result.claimAttempts[1]?.outcome).toBe("executed");
    expect(inboxCalls).toHaveLength(1);
    expect(inboxCalls[0]?.claimedTaskPath).toContain("task-b");
  });

  it("executes at most one work item even when multiple are eligible", async () => {
    await writeConfig({ allowed: ["codex"] });
    await writeInboxTask("codex", "task-a");
    await writeInboxTask("codex", "task-b");
    const { executors, inboxCalls } = recordingExecutors();

    const result = await schedulerOnce({
      configPath,
      deviceId: "heimdall",
      now: tick,
      executors,
    });

    expect(result.executed).toBe(true);
    expect(inboxCalls).toHaveLength(1);
    expect(inboxCalls[0]?.claimedTaskPath).toContain("task-a");
    // The second task was never claimed (still pending at its original path).
    await expect(readFile(join(vault, "team/codex/inbox/task-b.md"), "utf8")).resolves.toContain("status: pending");
  });

  it("claims an agent-mode cron job via claimCronJob then executes the claimed path", async () => {
    await writeConfig({ allowed: ["codex"] });
    const jobPath = await writeCronJob({ id: "nightly-digest", agent: "codex", mode: "agent", prompt: "Summarize logs." });
    const { executors, cronAgentCalls } = recordingExecutors();

    const result = await schedulerOnce({
      configPath,
      deviceId: "heimdall",
      now: tick,
      executors,
    });

    expect(result.executed).toBe(true);
    expect(result.executedItemType).toBe("cron_job");
    expect(cronAgentCalls).toHaveLength(1);
    expect(cronAgentCalls[0]?.claimedJobPath).toMatch(/\.claimed\.heimdall\.md$/);
    expect(result.executedItemPath).toBe(cronAgentCalls[0]?.claimedJobPath);
    await expect(readFile(join(vault, jobPath), "utf8")).rejects.toThrow();
  });

  it("delegates a script-mode cron job to executeScriptCronJob WITHOUT pre-claiming it", async () => {
    await writeConfig({ allowed: ["codex"] });
    const jobPath = await writeCronJob({ id: "disk-check", agent: "codex", mode: "script", script: "scripts/disk-check.sh" });
    const { executors, cronScriptCalls } = recordingExecutors();
    const { claims, cronClaimCalls } = fakeClaims({});

    const result = await schedulerOnce({
      configPath,
      deviceId: "heimdall",
      now: tick,
      executors,
      claims,
    });

    expect(result.executed).toBe(true);
    expect(result.executedItemType).toBe("cron_job");
    expect(cronScriptCalls).toHaveLength(1);
    // The script executor received the UNCLAIMED path (no .claimed. suffix).
    expect(cronScriptCalls[0]?.jobPath).toBe(jobPath);
    expect(cronScriptCalls[0]?.jobPath).not.toMatch(/\.claimed\./);
    // The scheduler tick did NOT call claimCronJob for the script job.
    expect(cronClaimCalls).toHaveLength(0);
    // The job file is still unclaimed (the fake executor did not claim it).
    await expect(readFile(join(vault, jobPath), "utf8")).resolves.toContain("mode: script");
  });

  it("does not execute when the only planned claim fails", async () => {
    await writeConfig({ allowed: ["codex"] });
    await writeInboxTask("codex", "task-a");
    const { executors, inboxCalls } = recordingExecutors();
    const { claims } = fakeClaims({ inboxThrow: () => true });

    const result = await schedulerOnce({
      configPath,
      deviceId: "heimdall",
      now: tick,
      executors,
      claims,
    });

    expect(result.executed).toBe(false);
    expect(result.claimAttempts).toHaveLength(1);
    expect(result.claimAttempts[0]?.outcome).toBe("claim_failed");
    expect(inboxCalls).toHaveLength(0);
    expect(result.summary).toContain("[SKIP]");
  });
});

describe("sanitizeDeviceId (default device id normalization)", () => {
  it("lowercases and kebab-cases an uppercase dotted hostname", () => {
    expect(sanitizeDeviceId("Ironman.local")).toBe("ironman-local");
  });
  it("lowercases a simple uppercase hostname", () => {
    expect(sanitizeDeviceId("Ironman")).toBe("ironman");
  });
  it("passes through already-valid lowercase kebab ids", () => {
    expect(sanitizeDeviceId("heimdall")).toBe("heimdall");
    expect(sanitizeDeviceId("thor-pi4")).toBe("thor-pi4");
  });
  it("prefixes ids that start with a digit so they begin with a letter", () => {
    expect(sanitizeDeviceId("123box")).toBe("device-123box");
  });
  it("replaces runs of non-alphanumeric characters with a single hyphen", () => {
    expect(sanitizeDeviceId("My_Device 01")).toBe("my-device-01");
  });
  it("trims leading/trailing hyphens", () => {
    expect(sanitizeDeviceId("...weird...")).toBe("weird");
  });
  it("falls back to local-device for empty or all-symbol input", () => {
    expect(sanitizeDeviceId("")).toBe("local-device");
    expect(sanitizeDeviceId("...!!!...")).toBe("local-device");
  });
  it("always produces a value matching the device-id validator /^[a-z][a-z0-9-]*$/", () => {
    const pattern = /^[a-z][a-z0-9-]*$/;
    const samples = ["Ironman", "Ironman.local", "thor", "123box", "", "...!!!...", "My_Device 01", "1", "host.name.with.dots"];
    for (const raw of samples) {
      expect(pattern.test(sanitizeDeviceId(raw))).toBe(true);
    }
  });
});

describe("schedulerOnce default device id", () => {
  it("derives a safe device id from an uppercase/dotted hostname and claims/executes", async () => {
    await writeConfig({ allowed: ["codex"] });
    await writeInboxTask("codex", "task-a");
    const { executors, inboxCalls } = recordingExecutors();

    const result = await schedulerOnce({
      configPath,
      hostname: "Ironman.local",
      now: tick,
      executors,
    });

    expect(result.executed).toBe(true);
    expect(result.deviceId).toBe("ironman-local");
    expect(inboxCalls[0]?.claimedTaskPath).toMatch(/\.claimed\.ironman-local\.md$/);
  });

  it("uses an explicit deviceId as-is without sanitizing", async () => {
    await writeConfig({ allowed: ["codex"] });
    await writeInboxTask("codex", "task-a");
    const { executors, inboxCalls } = recordingExecutors();

    const result = await schedulerOnce({
      configPath,
      deviceId: "heimdall",
      hostname: "Ironman.local",
      now: tick,
      executors,
    });

    expect(result.deviceId).toBe("heimdall");
    expect(inboxCalls[0]?.claimedTaskPath).toMatch(/\.claimed\.heimdall\.md$/);
  });
});

describe("schedulerOnce dependency eligibility (ADR-0038 R1)", () => {
  it("does not claim or execute a task whose prerequisite is unsatisfied", async () => {
    await writeConfig({ allowed: ["codex"] });
    await mkdir(join(vault, "team", "codex", "inbox"), { recursive: true });
    // A pending implementation task (no deps) AND a pending review that depends
    // on the still-pending implementation. Only the implementation is runnable.
    await writeFile(
      join(vault, "team", "codex", "inbox", "20260721T120000000Z-implement-slice.md"),
      ["---", "id: 20260721T120000000Z-implement-slice", "status: pending", "from: nora", "to: codex", "created: 2026-07-21T09:00:00Z", "updated: 2026-07-21T09:00:00Z", "---", "", "# Impl", "", "Do it."].join("\n"),
    );
    await writeFile(
      join(vault, "team", "codex", "inbox", "20260721T130000000Z-review-slice.md"),
      ["---", "id: 20260721T130000000Z-review-slice", "status: pending", "depends_on:", "  - 20260721T120000000Z-implement-slice", "from: nora", "to: codex", "created: 2026-07-21T09:00:00Z", "updated: 2026-07-21T09:00:00Z", "---", "", "# Review", "", "Review it."].join("\n"),
    );

    const { executors, inboxCalls } = recordingExecutors();

    const result = await schedulerOnce({
      configPath,
      deviceId: "heimdall",
      now: tick,
      executors,
    });

    // Only the runnable implementation is planned (review is filtered out).
    expect(result.plannedCount).toBe(1);
    expect(result.executed).toBe(true);
    expect(result.executedItemPath).toMatch(/implement-slice\.claimed\.heimdall\.md$/);
    // The review was never claimed or executed.
    expect(inboxCalls).toHaveLength(1);
    expect(inboxCalls[0]?.claimedTaskPath).toMatch(/implement-slice/);
    // The review file is untouched (still pending, unclaimed).
    const review = await readFile(join(vault, "team", "codex", "inbox", "20260721T130000000Z-review-slice.md"), "utf8");
    expect(review).toContain("status: pending");
  });

  it("does not claim or execute a task whose own id is duplicated", async () => {
    await writeConfig({ allowed: ["codex"] });
    await mkdir(join(vault, "team", "codex", "inbox"), { recursive: true });
    // Two files share the same id; both are pending. Neither should be claimable.
    await writeFile(
      join(vault, "team", "codex", "inbox", "20260721T120000000Z-implement-slice.md"),
      ["---", "id: 20260721T120000000Z-implement-slice", "status: pending", "from: nora", "to: codex", "created: 2026-07-21T09:00:00Z", "updated: 2026-07-21T09:00:00Z", "---", "", "# Impl A", "", "Do it."].join("\n"),
    );
    await writeFile(
      join(vault, "team", "codex", "inbox", "20260721T120000000Z-implement-slice-dup.md"),
      ["---", "id: 20260721T120000000Z-implement-slice", "status: pending", "from: nora", "to: codex", "created: 2026-07-21T09:00:00Z", "updated: 2026-07-21T09:00:00Z", "---", "", "# Impl B", "", "Do it."].join("\n"),
    );

    const { executors, inboxCalls } = recordingExecutors();

    const result = await schedulerOnce({
      configPath,
      deviceId: "heimdall",
      now: tick,
      executors,
    });

    // Duplicated ids are never claimable, so nothing is planned or executed.
    expect(result.plannedCount).toBe(0);
    expect(result.executed).toBe(false);
    expect(result.noWork).toBe(true);
    expect(inboxCalls).toHaveLength(0);
  });
});
