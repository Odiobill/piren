import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildClaimedInboxTaskPrompt,
  createAskRunner,
  executeClaimedInboxTask,
  parseClaimedInboxTaskPath,
  type ClaimedInboxTaskRunInput,
  type ClaimedInboxTaskRunner,
  type ClaimedInboxTaskRunnerResult,
} from "../src/scheduler-executor.js";

describe("buildClaimedInboxTaskPrompt", () => {
  it("includes the exact claimed task path", () => {
    const prompt = buildClaimedInboxTaskPrompt({
      agentName: "codex",
      claimedTaskPath: "team/codex/inbox/task-1.claimed.heimdall.md",
    });
    expect(prompt).toContain("team/codex/inbox/task-1.claimed.heimdall.md");
  });

  it("names the selected agent", () => {
    const prompt = buildClaimedInboxTaskPrompt({
      agentName: "codex",
      claimedTaskPath: "team/codex/inbox/task-1.claimed.heimdall.md",
    });
    expect(prompt).toContain("codex");
  });

  it("tells the agent to stop after one work item", () => {
    const prompt = buildClaimedInboxTaskPrompt({
      agentName: "codex",
      claimedTaskPath: "team/codex/inbox/task-1.claimed.heimdall.md",
    });
    expect(prompt).toMatch(/stop after.{0,40}one work item/i);
  });

  it("tells the agent not to poll the inbox", () => {
    const prompt = buildClaimedInboxTaskPrompt({
      agentName: "codex",
      claimedTaskPath: "team/codex/inbox/task-1.claimed.heimdall.md",
    });
    expect(prompt).toMatch(/do not poll/i);
  });

  it("tells the agent to update task status/result through task_update_status", () => {
    const prompt = buildClaimedInboxTaskPrompt({
      agentName: "codex",
      claimedTaskPath: "team/codex/inbox/task-1.claimed.heimdall.md",
    });
    expect(prompt).toMatch(/task_update_status/);
    expect(prompt).toMatch(/status/i);
  });
});

describe("parseClaimedInboxTaskPath validation", () => {
  const vaultRoot = resolve("/tmp/piren-vault");

  it("returns parsed info for a valid claimed task path", () => {
    const info = parseClaimedInboxTaskPath({
      vaultRoot,
      agentName: "codex",
      claimedTaskPath: "team/codex/inbox/task-1.claimed.heimdall.md",
    });
    expect(info).toEqual({
      agentName: "codex",
      deviceId: "heimdall",
      fileName: "task-1.md",
      claimedTaskPath: "team/codex/inbox/task-1.claimed.heimdall.md",
    });
  });

  it("rejects an unclaimed task path", () => {
    expect(() =>
      parseClaimedInboxTaskPath({
        vaultRoot,
        agentName: "codex",
        claimedTaskPath: "team/codex/inbox/task.md",
      }),
    ).toThrow(/\.claimed\./i);
  });

  it("rejects a claimed task path for a different agent", () => {
    expect(() =>
      parseClaimedInboxTaskPath({
        vaultRoot,
        agentName: "codex",
        claimedTaskPath: "team/thor/inbox/task-1.claimed.heimdall.md",
      }),
    ).toThrow(/belongs to agent 'thor'/);
  });

  it("rejects a path that escapes the vault via traversal", () => {
    expect(() =>
      parseClaimedInboxTaskPath({
        vaultRoot,
        agentName: "codex",
        claimedTaskPath: "../outside-vault/team/codex/inbox/task-1.claimed.heimdall.md",
      }),
    ).toThrow(/outside the vault/i);
  });

  it("rejects an absolute path outside the vault", () => {
    expect(() =>
      parseClaimedInboxTaskPath({
        vaultRoot,
        agentName: "codex",
        claimedTaskPath: resolve("/etc/team/codex/inbox/task-1.claimed.heimdall.md"),
      }),
    ).toThrow(/vault-relative, not absolute/i);
  });

  it("rejects an absolute path inside the vault", () => {
    expect(() =>
      parseClaimedInboxTaskPath({
        vaultRoot,
        agentName: "codex",
        claimedTaskPath: resolve(vaultRoot, "team/codex/inbox/task-1.claimed.heimdall.md"),
      }),
    ).toThrow(/vault-relative, not absolute/i);
  });

  it("rejects a claimed-looking path outside the inbox (different segment)", () => {
    expect(() =>
      parseClaimedInboxTaskPath({
        vaultRoot,
        agentName: "codex",
        claimedTaskPath: "team/codex/outbox/task-1.claimed.heimdall.md",
      }),
    ).toThrow(/inbox/i);
  });

  it("rejects a claimed-looking path under a different top-level directory", () => {
    expect(() =>
      parseClaimedInboxTaskPath({
        vaultRoot,
        agentName: "codex",
        claimedTaskPath: "cron/jobs/hourly-brief.claimed.heimdall.md",
      }),
    ).toThrow(/inbox/i);
  });

  it("rejects an invalid agent name in the input", () => {
    expect(() =>
      parseClaimedInboxTaskPath({
        vaultRoot,
        agentName: "Bad Agent",
        claimedTaskPath: "team/bad-agent/inbox/task-1.claimed.heimdall.md",
      }),
    ).toThrow(/invalid agent name/i);
  });
});

function fakeRunner(
  impl: (input: ClaimedInboxTaskRunInput) => Promise<ClaimedInboxTaskRunnerResult> | ClaimedInboxTaskRunnerResult,
): { runner: ClaimedInboxTaskRunner; calls: ClaimedInboxTaskRunInput[] } {
  const calls: ClaimedInboxTaskRunInput[] = [];
  const runner: ClaimedInboxTaskRunner = {
    async run(input) {
      calls.push(input);
      return await Promise.resolve(impl(input));
    },
  };
  return { runner, calls };
}

describe("executeClaimedInboxTask", () => {
  const vaultRoot = resolve("/tmp/piren-vault");

  it("calls the injected runner exactly once for a valid claimed task and returns an ok result", async () => {
    const { runner, calls } = fakeRunner(() => ({ assistantText: "done", exitCode: 0 }));

    const result = await executeClaimedInboxTask({
      vaultRoot,
      agentName: "codex",
      claimedTaskPath: "team/codex/inbox/task-1.claimed.heimdall.md",
      runner,
    });

    expect(calls).toHaveLength(1);
    expect(result.ok).toBe(true);
    expect(result.assistantText).toBe("done");
    expect(result.exitCode).toBe(0);
    expect(result.agentName).toBe("codex");
    expect(result.deviceId).toBe("heimdall");
    expect(result.claimedTaskPath).toBe("team/codex/inbox/task-1.claimed.heimdall.md");
    expect(result.prompt).toContain("team/codex/inbox/task-1.claimed.heimdall.md");
    expect("error" in result).toBe(false);
  });

  it("passes the agent name, vault root, and bounded prompt to the runner", async () => {
    const { runner, calls } = fakeRunner(() => ({ assistantText: "", exitCode: 0 }));

    await executeClaimedInboxTask({
      vaultRoot,
      agentName: "codex",
      claimedTaskPath: "team/codex/inbox/task-1.claimed.heimdall.md",
      runner,
    });

    expect(calls[0]?.agentName).toBe("codex");
    expect(calls[0]?.prompt).toMatch(/stop after.{0,40}one work item/i);
    expect(calls[0]?.prompt).toMatch(/do not poll/i);
  });

  it("does not call the runner and throws for an unclaimed task path", async () => {
    const { runner, calls } = fakeRunner(() => ({ assistantText: "done", exitCode: 0 }));

    await expect(
      executeClaimedInboxTask({
        vaultRoot,
        agentName: "codex",
        claimedTaskPath: "team/codex/inbox/task.md",
        runner,
      }),
    ).rejects.toThrow(/\.claimed\./i);

    expect(calls).toHaveLength(0);
  });

  it("does not call the runner and throws for a path outside the vault", async () => {
    const { runner, calls } = fakeRunner(() => ({ assistantText: "done", exitCode: 0 }));

    await expect(
      executeClaimedInboxTask({
        vaultRoot,
        agentName: "codex",
        claimedTaskPath: "../outside/team/codex/inbox/task-1.claimed.heimdall.md",
        runner,
      }),
    ).rejects.toThrow(/outside the vault/i);

    expect(calls).toHaveLength(0);
  });

  it("does not call the runner and throws for a task belonging to a different agent", async () => {
    const { runner, calls } = fakeRunner(() => ({ assistantText: "done", exitCode: 0 }));

    await expect(
      executeClaimedInboxTask({
        vaultRoot,
        agentName: "codex",
        claimedTaskPath: "team/thor/inbox/task-1.claimed.heimdall.md",
        runner,
      }),
    ).rejects.toThrow(/belongs to agent 'thor'/);

    expect(calls).toHaveLength(0);
  });

  it("captures a non-zero exit code as a non-ok result", async () => {
    const { runner } = fakeRunner(() => ({ assistantText: "partial", exitCode: 2 }));

    const result = await executeClaimedInboxTask({
      vaultRoot,
      agentName: "codex",
      claimedTaskPath: "team/codex/inbox/task-1.claimed.heimdall.md",
      runner,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  it("captures a thrown runner error as a non-ok result with an error summary", async () => {
    const { runner } = fakeRunner(() => {
      throw new Error("pi crashed");
    });

    const result = await executeClaimedInboxTask({
      vaultRoot,
      agentName: "codex",
      claimedTaskPath: "team/codex/inbox/task-1.claimed.heimdall.md",
      runner,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("pi crashed");
  });
});

describe("createAskRunner", () => {
  it("forwards the full run input (including vaultRoot) to the target builder", async () => {
    let captured: ClaimedInboxTaskRunInput | undefined;
    const runner = createAskRunner({
      targetBuilder: async (input) => {
        captured = input;
        throw new Error("stop-after-capture");
      },
    });

    await expect(
      runner.run({ agentName: "codex", vaultRoot: resolve("/tmp/piren-vault"), prompt: "hi" }),
    ).rejects.toThrow("stop-after-capture");

    expect(captured).toBeDefined();
    expect(captured?.vaultRoot).toBe(resolve("/tmp/piren-vault"));
    expect(captured?.agentName).toBe("codex");
    expect(captured?.prompt).toBe("hi");
  });
});
