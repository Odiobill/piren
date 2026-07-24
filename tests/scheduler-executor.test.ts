import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PiRpcClientLike } from "../src/ask.js";
import type { RpcEvent } from "../src/gateway-rpc.js";
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

  it("preserves a typed failure returned by the runner", async () => {
    const { runner } = fakeRunner(() => ({
      assistantText: "",
      exitCode: 1,
      failure: { kind: "launch_failure" as const, milestone: "target_build" as const, detail: "no local config" },
    }));

    const result = await executeClaimedInboxTask({
      vaultRoot,
      agentName: "codex",
      claimedTaskPath: "team/codex/inbox/task-1.claimed.heimdall.md",
      runner,
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ kind: "launch_failure", milestone: "target_build", detail: "no local config" });
  });

  it("classifies a nonzero exit without a typed failure as ambiguous", async () => {
    const { runner } = fakeRunner(() => ({ assistantText: "partial", exitCode: 2 }));

    const result = await executeClaimedInboxTask({
      vaultRoot,
      agentName: "codex",
      claimedTaskPath: "team/codex/inbox/task-1.claimed.heimdall.md",
      runner,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.failure?.kind).toBe("ambiguous");
  });

  it("NEGATIVE: a legacy thrown runner error mentioning 'spawn'/'launch' is ambiguous, never launch_failure", async () => {
    const { runner } = fakeRunner(() => {
      throw new Error("Failed to launch agent: spawn pi ENOENT");
    });

    const result = await executeClaimedInboxTask({
      vaultRoot,
      agentName: "codex",
      claimedTaskPath: "team/codex/inbox/task-1.claimed.heimdall.md",
      runner,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Failed to launch agent: spawn pi ENOENT");
    expect(result.failure?.kind).toBe("ambiguous");
    // Legacy/uninstrumented runners carry no milestone.
    expect(result.failure?.milestone).toBeUndefined();
  });
});

/**
 * Fake classified-ask client for the ADR-0038 revision 3 seam. Mirrors the
 * production `PiRpcClient` contract: `start()` may reject (start_rejection),
 * `prompt()` may reject (prompt_handoff), and termination fires exit
 * listeners on BOTH the exit and the error path.
 */
interface FakeAskClientOptions {
  startError?: Error;
  promptError?: Error;
  events?: RpcEvent[];
  terminate?: "none" | "exit" | "error";
}

class FakeAskClient implements PiRpcClientLike {
  private readonly startError: Error | undefined;
  private readonly promptError: Error | undefined;
  private readonly events: RpcEvent[];
  private readonly terminate: "none" | "exit" | "error";

  private eventListeners: Array<(event: RpcEvent) => void> = [];
  private exitListeners: Array<() => void> = [];

  constructor(options: FakeAskClientOptions = {}) {
    this.startError = options.startError;
    this.promptError = options.promptError;
    this.events = options.events ?? [];
    this.terminate = options.terminate ?? "none";
  }

  async start(): Promise<void> {
    if (this.startError !== undefined) throw this.startError;
  }

  async stop(): Promise<void> {}

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== listener);
    };
  }

  onExit(listener: () => void): () => void {
    this.exitListeners.push(listener);
    return () => {
      this.exitListeners = this.exitListeners.filter((l) => l !== listener);
    };
  }

  async prompt(_message: string): Promise<void> {
    if (this.promptError !== undefined) throw this.promptError;
    for (const event of this.events) {
      for (const listener of [...this.eventListeners]) listener(event);
    }
    if (this.terminate !== "none") {
      for (const listener of [...this.exitListeners]) listener();
    }
  }
}

describe("createAskRunner", () => {
  it("forwards the full run input (including vaultRoot) to the target builder", async () => {
    let captured: ClaimedInboxTaskRunInput | undefined;
    const runner = createAskRunner({
      targetBuilder: async (input) => {
        captured = input;
        throw new Error("stop-after-capture");
      },
    });

    // ADR-0038 revision 3: a target-builder throw is a typed launch_failure
    // outcome, not a rejection.
    const result = await runner.run({ agentName: "codex", vaultRoot: resolve("/tmp/piren-vault"), prompt: "hi" });

    expect(captured).toBeDefined();
    expect(captured?.vaultRoot).toBe(resolve("/tmp/piren-vault"));
    expect(captured?.agentName).toBe("codex");
    expect(captured?.prompt).toBe("hi");
    expect(result.exitCode).toBe(1);
    expect(result.failure?.kind).toBe("launch_failure");
    expect(result.failure?.milestone).toBe("target_build");
    expect(result.failure?.detail).toContain("stop-after-capture");
  });

  it("classifies a client start() rejection as launch_failure at start_rejection", async () => {
    const runner = createAskRunner({
      targetBuilder: async () => ({ command: "fake", args: [], cwd: "/tmp", env: {} }),
      clientFactory: () => new FakeAskClient({ startError: new Error("Failed to spawn agent: ENOENT") }),
    });

    const result = await runner.run({ agentName: "codex", vaultRoot: resolve("/tmp/piren-vault"), prompt: "hi" });

    expect(result.exitCode).toBe(1);
    expect(result.failure?.kind).toBe("launch_failure");
    expect(result.failure?.milestone).toBe("start_rejection");
  });

  it("NEGATIVE: a prompt-handoff failure containing 'spawn' is ambiguous, never launch_failure", async () => {
    const runner = createAskRunner({
      targetBuilder: async () => ({ command: "fake", args: [], cwd: "/tmp", env: {} }),
      clientFactory: () => new FakeAskClient({ promptError: new Error("Failed to spawn agent: write EPIPE") }),
    });

    const result = await runner.run({ agentName: "codex", vaultRoot: resolve("/tmp/piren-vault"), prompt: "hi" });

    expect(result.exitCode).toBe(1);
    expect(result.failure?.kind).toBe("ambiguous");
    expect(result.failure?.milestone).toBe("prompt_handoff");
  });

  it("returns the assistant text on success", async () => {
    const runner = createAskRunner({
      targetBuilder: async () => ({ command: "fake", args: [], cwd: "/tmp", env: {} }),
      clientFactory: () =>
        new FakeAskClient({
          events: [
            { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } },
            { type: "agent_end" },
          ],
        }),
    });

    const result = await runner.run({ agentName: "codex", vaultRoot: resolve("/tmp/piren-vault"), prompt: "hi" });

    expect(result.exitCode).toBe(0);
    expect(result.assistantText).toBe("done");
    expect(result.failure).toBeUndefined();
  });
});
