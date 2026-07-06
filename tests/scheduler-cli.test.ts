import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("scheduler dry-run CLI", () => {
  it("prints a claim proposal for a pending inbox task", async () => {
    // Write local config allowing thor
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\n`);

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
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\n`);

    const output = await schedulerDryRun({ configPath });

    expect(output).toContain("SCHEDULER DRY-RUN");
    expect(output).not.toContain("[CLAIM]");
  });

  it("respects allowed_agents from local config", async () => {
    // Allow codex but tasks exist for thor only
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - codex\n`);

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

  it("shows cron jobs owned by this device", async () => {
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\n`);

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
});
