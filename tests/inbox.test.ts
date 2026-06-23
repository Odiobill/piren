import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimInboxTask, createInboxTask, listInboxTasks, updateInboxTaskStatus } from "../src/inbox.js";

let root: string;
let vault: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-inbox-"));
  vault = join(root, "vault");
  await mkdir(join(vault, "team", "thor", "inbox"), { recursive: true });
  await mkdir(join(vault, "team", "piren", "inbox"), { recursive: true });
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("Phase 2 inbox tasks", () => {
  it("creates one Markdown task file in the target agent inbox", async () => {
    const result = await createInboxTask({
      vaultRoot: vault,
      from: "piren",
      to: "thor",
      title: "Check disk usage",
      body: "Please check disk usage on the NAS and report anything above 80%.",
      now: () => new Date("2026-06-22T15:30:00.000Z"),
    });

    expect(result.path).toBe("team/thor/inbox/20260622T153000000Z-check-disk-usage.md");
    expect(result.taskId).toBe("20260622T153000000Z-check-disk-usage");
    expect(result.status).toBe("pending");
    expect(result.to).toBe("thor");
    expect(result.from).toBe("piren");
    expect(result.bytes).toBeGreaterThan(0);

    const content = await readFile(join(vault, result.path), "utf8");
    expect(content).toContain("id: 20260622T153000000Z-check-disk-usage");
    expect(content).toContain("from: piren");
    expect(content).toContain("to: thor");
    expect(content).toContain("status: pending");
    expect(content).toContain("created: 2026-06-22T15:30:00.000Z");
    expect(content).toContain("updated: 2026-06-22T15:30:00.000Z");
    expect(content).toContain("# Check disk usage");
    expect(content).toContain("Please check disk usage on the NAS");
    expect(content).toContain("## Result\n\nPending.");
  });

  it("rejects invalid agent names before writing a task", async () => {
    await expect(createInboxTask({
      vaultRoot: vault,
      from: "piren",
      to: "../outside",
      title: "Escape",
      body: "Nope",
      now: () => new Date("2026-06-22T15:30:00.000Z"),
    })).rejects.toThrow(/invalid agent name/i);
  });

  it("updates task status and result in the existing task file", async () => {
    const task = await createInboxTask({
      vaultRoot: vault,
      from: "piren",
      to: "thor",
      title: "Check disk usage",
      body: "Please check disk usage on the NAS.",
      now: () => new Date("2026-06-22T15:30:00.000Z"),
    });

    const result = await updateInboxTaskStatus({
      vaultRoot: vault,
      taskPath: task.path,
      status: "completed",
      result: "Disk usage is below threshold.",
      now: () => new Date("2026-06-22T16:00:00.000Z"),
    });

    expect(result.path).toBe(task.path);
    expect(result.status).toBe("completed");
    expect(result.updated).toBe("2026-06-22T16:00:00.000Z");
    expect(result.bytes).toBeGreaterThan(0);

    const content = await readFile(join(vault, task.path), "utf8");
    expect(content).toContain("status: completed");
    expect(content).toContain("created: 2026-06-22T15:30:00.000Z");
    expect(content).toContain("updated: 2026-06-22T16:00:00.000Z");
    expect(content).toContain("## Result\n\nDisk usage is below threshold.\n");
    expect(content).not.toContain("## Result\n\nPending.");
  });

  it("lists inbox tasks for one selected agent without claiming or mutating them", async () => {
    const older = await createInboxTask({
      vaultRoot: vault,
      from: "piren",
      to: "thor",
      title: "Older task",
      body: "Handle this second.",
      now: () => new Date("2026-06-22T15:00:00.000Z"),
    });
    const newer = await createInboxTask({
      vaultRoot: vault,
      from: "piren",
      to: "thor",
      title: "Newer task",
      body: "Handle this first.",
      now: () => new Date("2026-06-22T16:00:00.000Z"),
    });
    await updateInboxTaskStatus({
      vaultRoot: vault,
      taskPath: newer.path,
      status: "in_progress",
      now: () => new Date("2026-06-22T16:05:00.000Z"),
    });

    const result = await listInboxTasks({ vaultRoot: vault, agentName: "thor" });

    expect(result.agentName).toBe("thor");
    expect(result.path).toBe("team/thor/inbox");
    expect(result.tasks.map((task) => task.path)).toEqual([older.path, newer.path]);
    expect(result.tasks.map((task) => task.status)).toEqual(["pending", "in_progress"]);
    expect(result.tasks[0]).toMatchObject({
      id: older.taskId,
      title: "Older task",
      from: "piren",
      to: "thor",
      created: "2026-06-22T15:00:00.000Z",
      updated: "2026-06-22T15:00:00.000Z",
    });
    expect(result.tasks[1]).toMatchObject({
      id: newer.taskId,
      title: "Newer task",
      updated: "2026-06-22T16:05:00.000Z",
    });

    const unchanged = await readFile(join(vault, older.path), "utf8");
    expect(unchanged).toContain("status: pending");
    expect(unchanged).toContain("## Result\n\nPending.");
  });

  it("claims one pending task by atomically renaming it for a device", async () => {
    const task = await createInboxTask({
      vaultRoot: vault,
      from: "piren",
      to: "thor",
      title: "Claim me",
      body: "This should become owned by heimdall.",
      now: () => new Date("2026-06-22T17:00:00.000Z"),
    });

    const result = await claimInboxTask({
      vaultRoot: vault,
      agentName: "thor",
      taskPath: task.path,
      deviceId: "heimdall",
    });

    expect(result.originalPath).toBe(task.path);
    expect(result.path).toBe("team/thor/inbox/20260622T170000000Z-claim-me.claimed.heimdall.md");
    expect(result.agentName).toBe("thor");
    expect(result.deviceId).toBe("heimdall");
    await expect(readFile(join(vault, task.path), "utf8")).rejects.toThrow();
    const claimedContent = await readFile(join(vault, result.path), "utf8");
    expect(claimedContent).toContain("status: pending");
    expect(claimedContent).toContain("# Claim me");

    const listed = await listInboxTasks({ vaultRoot: vault, agentName: "thor" });
    expect(listed.tasks).toHaveLength(0);
  });

  it("reclaims a stale claimed task when the previous device heartbeat has expired", async () => {
    await mkdir(join(vault, "team", "thor", "devices"), { recursive: true });
    await writeFile(join(vault, "team", "thor", "devices", "heimdall.json"), JSON.stringify({
      device_id: "heimdall",
      hostname: "heimdall.local",
      priority: 10,
      status: "active",
      started_at: "2026-06-22T16:00:00.000Z",
      last_seen: "2026-06-22T16:00:00.000Z",
    }, null, 2) + "\n");
    const task = await createInboxTask({
      vaultRoot: vault,
      from: "piren",
      to: "thor",
      title: "Reclaim me",
      body: "This should become owned by thor-laptop after heimdall goes stale.",
      now: () => new Date("2026-06-22T17:00:00.000Z"),
    });
    const staleClaim = await claimInboxTask({
      vaultRoot: vault,
      agentName: "thor",
      taskPath: task.path,
      deviceId: "heimdall",
    });

    const result = await claimInboxTask({
      vaultRoot: vault,
      agentName: "thor",
      taskPath: staleClaim.path,
      deviceId: "thor-laptop",
      staleAfterMs: 5 * 60 * 1000,
      now: () => new Date("2026-06-22T16:10:01.000Z"),
    });

    expect(result.originalPath).toBe(staleClaim.path);
    expect(result.path).toBe("team/thor/inbox/20260622T170000000Z-reclaim-me.claimed.thor-laptop.md");
    expect(result.agentName).toBe("thor");
    expect(result.deviceId).toBe("thor-laptop");
    await expect(readFile(join(vault, staleClaim.path), "utf8")).rejects.toThrow();
    const reclaimedContent = await readFile(join(vault, result.path), "utf8");
    expect(reclaimedContent).toContain("# Reclaim me");
  });
});
