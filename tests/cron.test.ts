import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod } from "node:fs/promises";
import { isScheduleDue, parseSchedule } from "../src/cron.js";
import { claimCronJob, executeScriptCronJob, listCronJobs, listActiveDevices, listCronRuns, recordCronRun, readCronJob, resolveCronScriptPath, selectOwningDevice } from "../src/cron.js";

let root: string;
let vault: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-cron-io-"));
  vault = join(root, "vault");
  await mkdir(join(vault, "cron", "jobs"), { recursive: true });
  await mkdir(join(vault, "team", "piren", "cron", "jobs"), { recursive: true });
  await mkdir(join(vault, "team", "piren", "devices"), { recursive: true });
  await writeFile(join(vault, ".piren-vault"), "");
});

function deviceRecord(deviceId: string, priority: number, lastSeen: string, status = "active"): string {
  return JSON.stringify({ device_id: deviceId, hostname: deviceId + ".local", priority, status, started_at: lastSeen, last_seen: lastSeen }, null, 2) + "\n";
}

afterEach(async () => rm(root, { recursive: true, force: true }));

function sharedJob(name: string, body: string): string {
  return [
    "---",
    `id: ${name}`,
    'agent: "piren"',
    `schedule: "0 7 * * *"`,
    "enabled: true",
    "device_policy:",
    "  mode: highest_priority",
    "  allowed_devices:",
    "    - heimdall",
    "    - pi4-office",
    "stale_after_seconds: 120",
    "---",
    "",
    "# Prompt",
    "",
    body,
    "",
  ].join("\n");
}

describe("ADR-0019 cron job file reading", () => {
  it("reads a shared cron job file and parses its frontmatter and prompt", async () => {
    await writeFile(join(vault, "cron", "jobs", "nightly-digest.md"), sharedJob("nightly-digest", "Summarize project logs."));

    const job = await readCronJob({ vaultRoot: vault, path: "cron/jobs/nightly-digest.md", now: () => new Date("2026-06-25T07:00:00Z") });

    expect(job.id).toBe("nightly-digest");
    expect(job.agent).toBe("piren");
    expect(job.schedule.raw).toBe("0 7 * * *");
    expect(job.enabled).toBe(true);
    expect(job.path).toBe("cron/jobs/nightly-digest.md");
    expect(job.scope).toBe("shared");
    expect(job.prompt).toContain("Summarize project logs.");
    expect(job.devicePolicy.mode).toBe("highest_priority");
    expect(job.devicePolicy.allowedDevices).toEqual(["heimdall", "pi4-office"]);
    expect(job.staleAfterSeconds).toBe(120);
  });

  it("reads an agent-scoped cron job and marks its scope as the agent name", async () => {
    await writeFile(
      join(vault, "team", "piren", "cron", "jobs", "check-github.md"),
      [
        "---",
        'id: check-github',
        'agent: "piren"',
        'schedule: "15m"',
        "enabled: true",
        "---",
        "",
        "# Prompt",
        "",
        "Check open PRs.",
        "",
      ].join("\n"),
    );

    const job = await readCronJob({ vaultRoot: vault, path: "team/piren/cron/jobs/check-github.md", now: () => new Date("2026-06-25T07:00:00Z") });

    expect(job.scope).toBe("piren");
    expect(job.schedule.kind).toBe("interval");
    expect(job.devicePolicy.mode).toBe("highest_priority");
    expect(job.devicePolicy.allowedDevices).toEqual([]);
    expect(job.staleAfterSeconds).toBeUndefined();
  });
});

describe("ADR-0023 script-only cron job files", () => {
  it("reads a script-mode cron job with script path and optional prompt body", async () => {
    await writeFile(
      join(vault, "cron", "jobs", "disk-check.md"),
      [
        "---",
        "id: disk-check",
        'agent: "piren"',
        'schedule: "30m"',
        "mode: script",
        "script: scripts/disk-check.sh",
        "enabled: true",
        "---",
        "",
        "# Disk Check",
        "",
        "Human-readable purpose only.",
        "",
      ].join("\n"),
    );

    const job = await readCronJob({ vaultRoot: vault, path: "cron/jobs/disk-check.md" });

    expect(job.mode).toBe("script");
    expect(job.script).toBe("scripts/disk-check.sh");
    expect(job.prompt).toContain("Human-readable purpose only");
  });

  it("allows script-mode jobs to omit the prompt body", async () => {
    await writeFile(
      join(vault, "cron", "jobs", "disk-check.md"),
      [
        "---",
        "id: disk-check",
        'agent: "piren"',
        'schedule: "30m"',
        "mode: script",
        "script: scripts/disk-check.sh",
        "enabled: true",
        "---",
        "",
      ].join("\n"),
    );

    const job = await readCronJob({ vaultRoot: vault, path: "cron/jobs/disk-check.md" });

    expect(job.mode).toBe("script");
    expect(job.prompt).toBe("");
  });

  it("rejects script paths that resolve outside the vault", () => {
    expect(() => resolveCronScriptPath({ vaultRoot: vault, script: "../escape.sh" })).toThrow(/outside vault/i);
  });
});

describe("ADR-0023 script-only cron execution", () => {
  it("claims a due script job, executes the vault script without agent input, and records the run", async () => {
    await mkdir(join(vault, "scripts"), { recursive: true });
    const scriptPath = join(vault, "scripts", "disk-check.sh");
    await writeFile(scriptPath, "#!/bin/sh\necho vault=$PIREN_VAULT_ROOT\necho agent=$PIREN_AGENT\n", "utf8");
    await chmod(scriptPath, 0o755);
    await writeFile(
      join(vault, "cron", "jobs", "disk-check.md"),
      [
        "---",
        "id: disk-check",
        'agent: "piren"',
        'schedule: "30m"',
        "mode: script",
        "script: scripts/disk-check.sh",
        "enabled: true",
        "---",
        "",
        "# Disk check",
        "",
      ].join("\n"),
    );

    const result = await executeScriptCronJob({
      vaultRoot: vault,
      jobPath: "cron/jobs/disk-check.md",
      agentName: "piren",
      deviceId: "heimdall",
      timeoutMs: 2000,
      now: () => new Date("2026-06-27T10:00:00Z"),
    });

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.runPath).toBe("cron/runs/20260627T100000000Z-disk-check.md");
    const runContent = await readFile(join(vault, result.runPath), "utf8");
    expect(runContent).toContain("mode: script");
    expect(runContent).toContain("exit_code: 0");
    expect(runContent).toContain("vault=" + vault);
    expect(runContent).toContain("agent=piren");
    const restored = await readFile(join(vault, "cron", "jobs", "disk-check.md"), "utf8");
    expect(restored).toContain("last_run: 2026-06-27T10:00:00.000Z");
  });
});

describe("ADR-0019 cron job listing", () => {
  it("lists shared and agent-scoped jobs together, skipping claimed files", async () => {
    await writeFile(join(vault, "cron", "jobs", "nightly-digest.md"), sharedJob("nightly-digest", "Summarize logs."));
    await writeFile(
      join(vault, "team", "piren", "cron", "jobs", "check-github.md"),
      [
        "---",
        "id: check-github",
        'agent: "piren"',
        'schedule: "15m"',
        "enabled: true",
        "---",
        "",
        "# Prompt",
        "",
        "Check open PRs.",
        "",
      ].join("\n"),
    );
    // A claimed job in flight should be skipped from the pending list.
    await writeFile(
      join(vault, "cron", "jobs", "in-flight.claimed.heimdall.md"),
      sharedJob("in-flight", "Should be skipped while claimed."),
    );

    const result = await listCronJobs({ vaultRoot: vault, agentName: "piren", now: () => new Date("2026-06-25T07:00:00Z") });

    const ids = result.jobs.map((job) => job.id).sort();
    expect(ids).toEqual(["check-github", "nightly-digest"]);
    const shared = result.jobs.find((job) => job.id === "nightly-digest");
    expect(shared?.scope).toBe("shared");
    const scoped = result.jobs.find((job) => job.id === "check-github");
    expect(scoped?.scope).toBe("piren");
  });

  it("returns an empty job list when neither directory exists", async () => {
    const result = await listCronJobs({ vaultRoot: vault, agentName: "ghost", now: () => new Date("2026-06-25T07:00:00Z") });
    expect(result.jobs).toEqual([]);
  });
});

describe("ADR-0019 cron device ownership selection", () => {
  it("selects the highest-priority (lowest number) active device as the owner", () => {
    const owned = selectOwningDevice({
      devicePolicy: { mode: "highest_priority", allowedDevices: [] },
      activeDevices: [
        { deviceId: "pi4-office", priority: 10 },
        { deviceId: "heimdall", priority: 1 },
        { deviceId: "laptop", priority: 5 },
      ],
      deviceId: "heimdall",
    });
    expect(owned.owns).toBe(true);
    expect(owned.owner).toBe("heimdall");
  });

  it("defers when a higher-priority device is active", () => {
    const owned = selectOwningDevice({
      devicePolicy: { mode: "highest_priority", allowedDevices: [] },
      activeDevices: [
        { deviceId: "heimdall", priority: 1 },
        { deviceId: "pi4-office", priority: 10 },
      ],
      deviceId: "pi4-office",
    });
    expect(owned.owns).toBe(false);
    expect(owned.owner).toBe("heimdall");
  });

  it("restricts eligibility to allowed_devices when the list is non-empty", () => {
    const owned = selectOwningDevice({
      devicePolicy: { mode: "highest_priority", allowedDevices: ["pi4-office"] },
      activeDevices: [
        { deviceId: "heimdall", priority: 1 },
        { deviceId: "pi4-office", priority: 10 },
      ],
      deviceId: "pi4-office",
    });
    expect(owned.owns).toBe(true);
    expect(owned.owner).toBe("pi4-office");
  });

  it("owns when the current device is the only active one, even if higher numbers exist offline", () => {
    const owned = selectOwningDevice({
      devicePolicy: { mode: "highest_priority", allowedDevices: [] },
      activeDevices: [{ deviceId: "pi4-office", priority: 10 }],
      deviceId: "pi4-office",
    });
    expect(owned.owns).toBe(true);
    expect(owned.owner).toBe("pi4-office");
  });
});

describe("ADR-0019 cron active device discovery", () => {
  it("reads device heartbeats and filters out stale devices", async () => {
    await writeFile(join(vault, "team", "piren", "devices", "heimdall.json"), deviceRecord("heimdall", 1, "2026-06-25T06:59:00Z"));
    await writeFile(join(vault, "team", "piren", "devices", "pi4-office.json"), deviceRecord("pi4-office", 10, "2026-06-25T04:00:00Z"));

    const result = await listActiveDevices({
      vaultRoot: vault,
      agentName: "piren",
      staleAfterMs: 60 * 60 * 1000,
      now: () => new Date("2026-06-25T07:00:00Z"),
    });

    expect(result.devices.map((d) => d.deviceId)).toEqual(["heimdall"]);
    expect(result.devices[0]?.priority).toBe(1);
  });

  it("treats a missing devices directory as no active devices", async () => {
    const result = await listActiveDevices({
      vaultRoot: vault,
      agentName: "ghost",
      staleAfterMs: 60 * 1000,
      now: () => new Date("2026-06-25T07:00:00Z"),
    });
    expect(result.devices).toEqual([]);
  });
});

describe("ADR-0019 cron atomic job claiming", () => {
  it("atomically renames a shared job to a .claimed.<device>.md path", async () => {
    await writeFile(join(vault, "cron", "jobs", "nightly-digest.md"), sharedJob("nightly-digest", "Summarize logs."));

    const result = await claimCronJob({
      vaultRoot: vault,
      jobPath: "cron/jobs/nightly-digest.md",
      deviceId: "heimdall",
      agentName: "piren",
      now: () => new Date("2026-06-25T07:00:00Z"),
    });

    expect(result.path).toBe("cron/jobs/nightly-digest.claimed.heimdall.md");
    expect(result.originalPath).toBe("cron/jobs/nightly-digest.md");
    expect(result.deviceId).toBe("heimdall");

    await expect(readFile(join(vault, "cron", "jobs", "nightly-digest.md"), "utf8")).rejects.toThrow();
    const claimed = await readFile(result.absolutePath, "utf8");
    expect(claimed).toContain("last_claimed_by: heimdall");
    expect(claimed).toContain("Summarize logs.");
  });

  it("rejects claiming an already-claimed job from an active device without stale recovery", async () => {
    await writeFile(join(vault, "cron", "jobs", "nightly-digest.md"), sharedJob("nightly-digest", "Summarize logs."));
    await writeFile(
      join(vault, "team", "piren", "devices", "heimdall.json"),
      deviceRecord("heimdall", 1, "2026-06-25T06:59:30Z"),
    );
    await claimCronJob({
      vaultRoot: vault,
      jobPath: "cron/jobs/nightly-digest.md",
      deviceId: "heimdall",
      agentName: "piren",
      now: () => new Date("2026-06-25T07:00:00Z"),
    });

    await expect(
      claimCronJob({
        vaultRoot: vault,
        jobPath: "cron/jobs/nightly-digest.claimed.heimdall.md",
        deviceId: "pi4-office",
        agentName: "piren",
        staleAfterMs: 30 * 60 * 1000,
        now: () => new Date("2026-06-25T07:00:00Z"),
      }),
    ).rejects.toThrow(/already claimed by active device/i);
  });

  it("reclaims a stale claim when the previous device heartbeat expired", async () => {
    await writeFile(join(vault, "cron", "jobs", "nightly-digest.md"), sharedJob("nightly-digest", "Summarize logs."));
    // heimdall claimed it 1h ago but its heartbeat stopped 5min after claiming.
    await writeFile(
      join(vault, "cron", "jobs", "nightly-digest.claimed.heimdall.md"),
      sharedJob("nightly-digest", "Summarize logs.").replace("---\n", "---\nlast_claimed_by: heimdall\n"),
    );
    await writeFile(
      join(vault, "team", "piren", "devices", "heimdall.json"),
      deviceRecord("heimdall", 1, "2026-06-25T06:05:00Z"),
    );

    const result = await claimCronJob({
      vaultRoot: vault,
      jobPath: "cron/jobs/nightly-digest.claimed.heimdall.md",
      deviceId: "pi4-office",
      agentName: "piren",
      staleAfterMs: 30 * 60 * 1000,
      now: () => new Date("2026-06-25T07:00:00Z"),
    });

    expect(result.path).toBe("cron/jobs/nightly-digest.claimed.pi4-office.md");
    expect(result.deviceId).toBe("pi4-office");
  });
});

describe("ADR-0019 cron run record and last_run update", () => {
  it("writes an inspectable run record and restores the unclaimed job with last_run updated", async () => {
    await writeFile(join(vault, "cron", "jobs", "nightly-digest.md"), sharedJob("nightly-digest", "Summarize logs."));
    const claimed = await claimCronJob({
      vaultRoot: vault,
      jobPath: "cron/jobs/nightly-digest.md",
      deviceId: "heimdall",
      agentName: "piren",
      now: () => new Date("2026-06-25T07:00:00Z"),
    });

    const record = await recordCronRun({
      vaultRoot: vault,
      jobPath: claimed.path,
      agentName: "piren",
      deviceId: "heimdall",
      status: "completed",
      result: "All project logs summarized. No urgent items.",
      startedAt: new Date("2026-06-25T07:00:05Z"),
      finishedAt: new Date("2026-06-25T07:00:42Z"),
    });

    expect(record.runPath).toBe("cron/runs/20260625T070005000Z-nightly-digest.md");
    expect(record.restoredJobPath).toBe("cron/jobs/nightly-digest.md");

    const runContent = await readFile(record.runAbsolutePath, "utf8");
    expect(runContent).toContain("job_id: nightly-digest");
    expect(runContent).toContain("agent: piren");
    expect(runContent).toContain("device: heimdall");
    expect(runContent).toContain("status: completed");
    expect(runContent).toContain("started_at: 2026-06-25T07:00:05.000Z");
    expect(runContent).toContain("All project logs summarized.");

    // The claimed file is gone and the unclaimed job is restored with last_run set.
    await expect(readFile(join(vault, claimed.path), "utf8")).rejects.toThrow();
    const restored = await readFile(join(vault, "cron", "jobs", "nightly-digest.md"), "utf8");
    expect(restored).toContain("last_run: 2026-06-25T07:00:42.000Z");
    expect(restored).not.toContain("last_claimed_by: heimdall");
  });

  it("records a failed run without leaving the job claimed", async () => {
    await writeFile(join(vault, "cron", "jobs", "nightly-digest.md"), sharedJob("nightly-digest", "Summarize logs."));
    const claimed = await claimCronJob({
      vaultRoot: vault,
      jobPath: "cron/jobs/nightly-digest.md",
      deviceId: "heimdall",
      agentName: "piren",
      now: () => new Date("2026-06-25T07:00:00Z"),
    });

    const record = await recordCronRun({
      vaultRoot: vault,
      jobPath: claimed.path,
      agentName: "piren",
      deviceId: "heimdall",
      status: "failed",
      result: "Agent error: could not reach the model provider.",
      startedAt: new Date("2026-06-25T07:00:05Z"),
      finishedAt: new Date("2026-06-25T07:00:10Z"),
    });

    const runContent = await readFile(record.runAbsolutePath, "utf8");
    expect(runContent).toContain("status: failed");
    expect(runContent).toContain("could not reach the model provider");
    // Even on failure the job is restored so it can be retried next cycle.
    await expect(readFile(join(vault, "cron", "jobs", "nightly-digest.md"), "utf8")).resolves.toBeDefined();
  });
});

describe("ADR-0019 cron run history listing", () => {
  it("lists run records newest-first across shared and agent-scoped run dirs", async () => {
    await mkdir(join(vault, "cron", "runs"), { recursive: true });
    await mkdir(join(vault, "team", "piren", "cron", "runs"), { recursive: true });
    await writeFile(
      join(vault, "cron", "runs", "20260624T070005000Z-nightly-digest.md"),
      ["---", "job_id: nightly-digest", "agent: piren", "device: heimdall", "status: completed", "started_at: 2026-06-24T07:00:05.000Z", "finished_at: 2026-06-24T07:00:42.000Z", "---", "", "# Old run", "", "Yesterday summary.", ""].join("\n"),
    );
    await writeFile(
      join(vault, "team", "piren", "cron", "runs", "20260625T070005000Z-check-github.md"),
      ["---", "job_id: check-github", "agent: piren", "device: heimdall", "status: completed", "started_at: 2026-06-25T07:00:05.000Z", "finished_at: 2026-06-25T07:00:10.000Z", "---", "", "# Today run", "", "3 open PRs.", ""].join("\n"),
    );

    const result = await listCronRuns({ vaultRoot: vault, agentName: "piren" });

    expect(result.runs.map((r) => r.jobId)).toEqual(["check-github", "nightly-digest"]);
    const newest = result.runs[0];
    expect(newest?.status).toBe("completed");
    expect(newest?.path).toBe("team/piren/cron/runs/20260625T070005000Z-check-github.md");
  });

  it("filters run records by job_id when provided", async () => {
    await mkdir(join(vault, "cron", "runs"), { recursive: true });
    await writeFile(join(vault, "cron", "runs", "20260624T070005000Z-nightly-digest.md"), ["---", "job_id: nightly-digest", "agent: piren", "device: heimdall", "status: completed", "started_at: 2026-06-24T07:00:05.000Z", "finished_at: 2026-06-24T07:00:42.000Z", "---", "", "x", ""].join("\n"));
    await writeFile(join(vault, "cron", "runs", "20260625T070005000Z-other.md"), ["---", "job_id: other", "agent: piren", "device: heimdall", "status: failed", "started_at: 2026-06-25T07:00:05.000Z", "finished_at: 2026-06-25T07:00:08.000Z", "---", "", "y", ""].join("\n"));

    const result = await listCronRuns({ vaultRoot: vault, agentName: "piren", jobId: "nightly-digest" });
    expect(result.runs.map((r) => r.jobId)).toEqual(["nightly-digest"]);
  });
});

describe("ADR-0019 cron schedule parsing", () => {
  it("parses a five-field cron string into a schedule", () => {
    const schedule = parseSchedule("0 7 * * *");
    expect(schedule.raw).toBe("0 7 * * *");
    expect(schedule.describe()).toBe("0 7 * * *");
  });

  it("parses an interval string into a schedule", () => {
    const schedule = parseSchedule("30m");
    expect(schedule.kind).toBe("interval");
    expect(schedule.raw).toBe("30m");
  });

  it("rejects an invalid schedule", () => {
    expect(() => parseSchedule("not a schedule")).toThrow(/invalid cron schedule/i);
  });
});

describe("ADR-0019 cron due detection", () => {
  it("marks an interval job due when elapsed time exceeds the interval", () => {
    const schedule = parseSchedule("30m");
    expect(isScheduleDue({ schedule, now: new Date("2026-06-25T07:31:00Z"), lastRun: new Date("2026-06-25T07:00:00Z") })).toBe(true);
  });

  it("does not mark an interval job due within the interval", () => {
    const schedule = parseSchedule("30m");
    expect(isScheduleDue({ schedule, now: new Date("2026-06-25T07:10:00Z"), lastRun: new Date("2026-06-25T07:00:00Z") })).toBe(false);
  });

  it("marks an interval job due when there is no previous run", () => {
    const schedule = parseSchedule("6h");
    expect(isScheduleDue({ schedule, now: new Date("2026-06-25T07:00:00Z") })).toBe(true);
  });

  it("marks a cron job due at the matching minute with no prior run", () => {
    const schedule = parseSchedule("0 7 * * *");
    expect(isScheduleDue({ schedule, now: new Date("2026-06-25T07:00:00Z") })).toBe(true);
  });

  it("does not re-fire a cron job in the same minute it already ran", () => {
    const schedule = parseSchedule("0 7 * * *");
    expect(
      isScheduleDue({ schedule, now: new Date("2026-06-25T07:00:30Z"), lastRun: new Date("2026-06-25T07:00:00Z") }),
    ).toBe(false);
  });

  it("does not fire a cron job at a non-matching minute", () => {
    const schedule = parseSchedule("0 7 * * *");
    expect(
      isScheduleDue({ schedule, now: new Date("2026-06-25T08:00:00Z"), lastRun: new Date("2026-06-25T07:00:00Z") }),
    ).toBe(false);
  });
});
