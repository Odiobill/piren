import { describe, expect, it } from "vitest";
import { planSchedulerTick, type PlannerTask, type PlannerCronJob, type PlannerActiveDevice } from "../src/scheduler.js";
import type { DependencyTaskNode } from "../src/scheduler-dependencies.js";

const IMPL = "20260721T120000000Z-implement-slice";
const REVIEW = "20260721T130000000Z-review-slice";

function depNode(opts: { id: string; status?: DependencyTaskNode["status"]; dependsOn?: string[]; path?: string }): DependencyTaskNode {
  return {
    id: opts.id,
    status: opts.status ?? "pending",
    dependsOn: opts.dependsOn ?? [],
    path: opts.path ?? `team/codex/inbox/${opts.id}.md`,
  };
}

const deviceId = "heimdall";
const staleAfterMs = 300_000;
const now = new Date("2026-07-05T10:00:00Z");

describe("scheduler planner", () => {
  it("returns empty array when no enabled agents", () => {
    const result = planSchedulerTick({
      enabledAgents: [],
      pendingTasks: [],
      dueCronJobs: [],
      activeDevices: new Map(),
      deviceId,
      staleAfterMs,
      now,
    });
    expect(result).toEqual([]);
  });

  it("returns empty array when no pending work", () => {
    const result = planSchedulerTick({
      enabledAgents: ["codex"],
      pendingTasks: [],
      dueCronJobs: [],
      activeDevices: new Map(),
      deviceId,
      staleAfterMs,
      now,
    });
    expect(result).toEqual([]);
  });

  it("proposes a claim for a pending inbox task of an enabled agent", () => {
    const result = planSchedulerTick({
      enabledAgents: ["codex"],
      pendingTasks: [
        { path: "team/codex/inbox/task-1.md", agentName: "codex", status: "pending" },
      ],
      dueCronJobs: [],
      activeDevices: new Map(),
      deviceId,
      staleAfterMs,
      now,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      agentName: "codex",
      itemType: "inbox_task",
      itemPath: "team/codex/inbox/task-1.md",
      deviceId: "heimdall",
    });
    expect(result[0]!.rationale).toContain("unclaimed");
  });

  it("ignores tasks for agents not in enabledAgents", () => {
    const result = planSchedulerTick({
      enabledAgents: ["codex"],
      pendingTasks: [
        { path: "team/thor/inbox/task-1.md", agentName: "thor", status: "pending" },
      ],
      dueCronJobs: [],
      activeDevices: new Map(),
      deviceId,
      staleAfterMs,
      now,
    });

    expect(result).toEqual([]);
  });

  it("proposes a claim for a due cron job where this device is the owner", () => {
    const activeDevices = new Map<string, PlannerActiveDevice[]>();
    activeDevices.set("codex", [
      { deviceId: "heimdall", priority: 1 },
      { deviceId: "ironman", priority: 5 },
    ]);

    const result = planSchedulerTick({
      enabledAgents: ["codex"],
      pendingTasks: [],
      dueCronJobs: [
        {
          path: "cron/jobs/hourly-brief.md",
          agentName: "codex",
          devicePolicy: { mode: "highest_priority" as const, allowedDevices: ["heimdall", "ironman"] },
        },
      ],
      activeDevices,
      deviceId,
      staleAfterMs,
      now,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      agentName: "codex",
      itemType: "cron_job",
      itemPath: "cron/jobs/hourly-brief.md",
      deviceId: "heimdall",
    });
    expect(result[0]!.rationale).toContain("owns");
  });

  it("skips a cron job where this device is not the owner", () => {
    const activeDevices = new Map<string, PlannerActiveDevice[]>();
    activeDevices.set("codex", [
      { deviceId: "heimdall", priority: 10 },
      { deviceId: "ironman", priority: 1 },
    ]);

    const result = planSchedulerTick({
      enabledAgents: ["codex"],
      pendingTasks: [],
      dueCronJobs: [
        {
          path: "cron/jobs/hourly-brief.md",
          agentName: "codex",
          devicePolicy: { mode: "highest_priority" as const, allowedDevices: ["heimdall", "ironman"] },
        },
      ],
      activeDevices,
      deviceId,
      staleAfterMs,
      now,
    });

    // ironman has priority 1 (higher than heimdall's 10), so ironman owns it
    expect(result).toEqual([]);
  });

  it("proposes reclaim for a claimed task where the claiming device is stale", () => {
    // heimdall is NOT in active devices (stale), so reclaim is proposed
    const result = planSchedulerTick({
      enabledAgents: ["codex"],
      pendingTasks: [
        { path: "team/codex/inbox/task-1.claimed.stale-device.md", agentName: "codex", status: "claimed", claimedBy: "stale-device" },
      ],
      dueCronJobs: [],
      activeDevices: new Map(),
      deviceId,
      staleAfterMs,
      now,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      agentName: "codex",
      itemType: "inbox_task",
      itemPath: "team/codex/inbox/task-1.claimed.stale-device.md",
      deviceId: "heimdall",
    });
    expect(result[0]!.rationale).toContain("stale");
  });

  it("skips a claimed task where the claiming device is still active", () => {
    const activeDevices = new Map<string, PlannerActiveDevice[]>();
    activeDevices.set("codex", [{ deviceId: "ironman", priority: 5 }]);

    const result = planSchedulerTick({
      enabledAgents: ["codex"],
      pendingTasks: [
        { path: "team/codex/inbox/task-1.claimed.ironman.md", agentName: "codex", status: "claimed", claimedBy: "ironman" },
      ],
      dueCronJobs: [],
      activeDevices,
      deviceId,
      staleAfterMs,
      now,
    });

    expect(result).toEqual([]);
  });

  it("sorts claims by priority (lower priority = higher precedence)", () => {
    const activeDevices = new Map<string, PlannerActiveDevice[]>();
    activeDevices.set("codex", [{ deviceId: "heimdall", priority: 1 }]);
    activeDevices.set("thor", [{ deviceId: "heimdall", priority: 10 }]);

    const result = planSchedulerTick({
      enabledAgents: ["codex", "thor"],
      pendingTasks: [
        { path: "team/codex/inbox/task-1.md", agentName: "codex", status: "pending" },
        { path: "team/thor/inbox/task-2.md", agentName: "thor", status: "pending" },
      ],
      dueCronJobs: [],
      activeDevices,
      deviceId,
      staleAfterMs,
      now,
    });

    expect(result).toHaveLength(2);
    // codex has device priority 1, thor has 10: codex should sort first
    expect(result[0]!.agentName).toBe("codex");
    expect(result[1]!.agentName).toBe("thor");
  });

  it("handles multiple pending tasks and cron jobs together", () => {
    const activeDevices = new Map<string, PlannerActiveDevice[]>();
    activeDevices.set("codex", [{ deviceId: "heimdall", priority: 10 }]);

    const result = planSchedulerTick({
      enabledAgents: ["codex"],
      pendingTasks: [
        { path: "team/codex/inbox/task-1.md", agentName: "codex", status: "pending" },
        { path: "team/codex/inbox/task-2.md", agentName: "codex", status: "pending" },
      ],
      dueCronJobs: [
        {
          path: "cron/jobs/daily-digest.md",
          agentName: "codex",
          devicePolicy: { mode: "highest_priority" as const, allowedDevices: ["heimdall"] },
        },
      ],
      activeDevices,
      deviceId,
      staleAfterMs,
      now,
    });

    expect(result).toHaveLength(3);
    expect(result.map((c: { itemType: string }) => c.itemType).sort()).toEqual(["cron_job", "inbox_task", "inbox_task"]);
  });

  it("skips cron jobs for agents not in enabledAgents", () => {
    const activeDevices = new Map<string, PlannerActiveDevice[]>();
    activeDevices.set("thor", [{ deviceId: "heimdall", priority: 10 }]);

    const result = planSchedulerTick({
      enabledAgents: ["codex"],
      pendingTasks: [],
      dueCronJobs: [
        {
          path: "cron/jobs/daily-digest.md",
          agentName: "thor",
          devicePolicy: { mode: "highest_priority" as const, allowedDevices: ["heimdall"] },
        },
      ],
      activeDevices,
      deviceId,
      staleAfterMs,
      now,
    });

    expect(result).toEqual([]);
  });

  it("includes agent's device priority in the proposed claim", () => {
    const activeDevices = new Map<string, PlannerActiveDevice[]>();
    activeDevices.set("codex", [{ deviceId: "heimdall", priority: 3 }]);

    const result = planSchedulerTick({
      enabledAgents: ["codex"],
      pendingTasks: [
        { path: "team/codex/inbox/task-1.md", agentName: "codex", status: "pending" },
      ],
      dueCronJobs: [],
      activeDevices,
      deviceId,
      staleAfterMs,
      now,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.priority).toBe(3);
  });
});

describe("scheduler planner dependency eligibility (ADR-0038 R1)", () => {
  it("proposes no claim for a task whose prerequisite is unsatisfied", () => {
    const dependencyNodes = new Map<string, DependencyTaskNode>([
      [IMPL, depNode({ id: IMPL, status: "pending" })],
      [REVIEW, depNode({ id: REVIEW, dependsOn: [IMPL] })],
    ]);

    const result = planSchedulerTick({
      enabledAgents: ["codex"],
      pendingTasks: [
        { path: "team/codex/inbox/review.md", agentName: "codex", status: "pending", id: REVIEW, dependsOn: [IMPL] },
        { path: "team/codex/inbox/impl.md", agentName: "codex", status: "pending", id: IMPL },
      ],
      dueCronJobs: [],
      activeDevices: new Map(),
      deviceId,
      staleAfterMs,
      now,
      dependencyNodes,
    });

    // impl (no deps) is claimable; review (blocked) is not.
    expect(result.map((c) => c.itemPath)).toEqual(["team/codex/inbox/impl.md"]);
  });

  it("proposes a claim once the prerequisite is completed", () => {
    const dependencyNodes = new Map<string, DependencyTaskNode>([
      [IMPL, depNode({ id: IMPL, status: "completed" })],
      [REVIEW, depNode({ id: REVIEW, dependsOn: [IMPL] })],
    ]);

    const result = planSchedulerTick({
      enabledAgents: ["codex"],
      pendingTasks: [
        { path: "team/codex/inbox/review.md", agentName: "codex", status: "pending", id: REVIEW, dependsOn: [IMPL] },
      ],
      dueCronJobs: [],
      activeDevices: new Map(),
      deviceId,
      staleAfterMs,
      now,
      dependencyNodes,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.itemPath).toBe("team/codex/inbox/review.md");
  });

  it("fails closed when a task declares deps but no dependencyNodes are provided", () => {
    const result = planSchedulerTick({
      enabledAgents: ["codex"],
      pendingTasks: [
        { path: "team/codex/inbox/review.md", agentName: "codex", status: "pending", id: REVIEW, dependsOn: [IMPL] },
      ],
      dueCronJobs: [],
      activeDevices: new Map(),
      deviceId,
      staleAfterMs,
      now,
      // dependencyNodes intentionally omitted
    });

    expect(result).toEqual([]);
  });

  it("resolves a cross-agent prerequisite through dependencyNodes", () => {
    // review belongs to dipu; impl belongs to codex and is completed.
    const dependencyNodes = new Map<string, DependencyTaskNode>([
      [IMPL, depNode({ id: IMPL, status: "completed", path: "team/codex/inbox/impl.md" })],
      [REVIEW, depNode({ id: REVIEW, dependsOn: [IMPL], path: "team/dipu/inbox/review.md" })],
    ]);

    const result = planSchedulerTick({
      enabledAgents: ["dipu"],
      pendingTasks: [
        { path: "team/dipu/inbox/review.md", agentName: "dipu", status: "pending", id: REVIEW, dependsOn: [IMPL] },
      ],
      dueCronJobs: [],
      activeDevices: new Map(),
      deviceId,
      staleAfterMs,
      now,
      dependencyNodes,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.itemPath).toBe("team/dipu/inbox/review.md");
  });

  it("keeps a self-dependent task out of claim proposals", () => {
    const dependencyNodes = new Map<string, DependencyTaskNode>([
      [REVIEW, depNode({ id: REVIEW, dependsOn: [REVIEW] })],
    ]);

    const result = planSchedulerTick({
      enabledAgents: ["codex"],
      pendingTasks: [
        { path: "team/codex/inbox/review.md", agentName: "codex", status: "pending", id: REVIEW, dependsOn: [REVIEW] },
      ],
      dueCronJobs: [],
      activeDevices: new Map(),
      deviceId,
      staleAfterMs,
      now,
      dependencyNodes,
    });

    expect(result).toEqual([]);
  });

  it("leaves tasks without depends_on unaffected (backward compatible)", () => {
    const result = planSchedulerTick({
      enabledAgents: ["codex"],
      pendingTasks: [
        { path: "team/codex/inbox/plain.md", agentName: "codex", status: "pending" },
      ],
      dueCronJobs: [],
      activeDevices: new Map(),
      deviceId,
      staleAfterMs,
      now,
      // no dependencyNodes, no id/dependsOn: unchanged behavior
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.itemPath).toBe("team/codex/inbox/plain.md");
  });
});
