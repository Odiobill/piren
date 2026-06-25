import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isScheduleDue, parseSchedule } from "../src/cron.js";
import { listCronJobs, listActiveDevices, readCronJob, selectOwningDevice } from "../src/cron.js";

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
