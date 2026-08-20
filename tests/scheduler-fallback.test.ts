import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schedulerOnce, type SchedulerOnceExecutors, type SchedulerOnceRelease, type SchedulerOnceRetryTransition } from "../src/scheduler-once.js";
import { createAskRunner, executeClaimedInboxTask } from "../src/scheduler-executor.js";
import { executeClaimedAgentCronJob } from "../src/scheduler-cron-executor.js";
import type { BoundedRunFailure, PiRpcClientLike } from "../src/ask.js";
import type { GatewayFallbackPolicy } from "../src/model-fallback-gateway.js";
import type { RpcEvent, RpcSpawnTarget } from "../src/gateway-rpc.js";

// TB8 — bounded scheduler same-client model fallback, terminal triage, and
// visible summary (design §8 TB8, §4.2/§4.3, §5, §6.5, §7). Fake Pi clients /
// injected policy loaders; no live auth. The scheduler resolves the policy at
// the production runtime adapter boundary (createAskRunner) and reuses the
// TB5 classified-ask fallback; pure planner/retry/release cores read nothing.

const POLICY: GatewayFallbackPolicy = {
  primaryModelId: "kimi-coding/k3",
  fallback: { ok: true, present: true, config: { autoSwitch: true, models: ["openai/gpt-4.1"] } },
};

function policyWith(models: string[], autoSwitch = true): GatewayFallbackPolicy {
  return { primaryModelId: "kimi-coding/k3", fallback: { ok: true, present: true, config: { autoSwitch, models } } };
}

const NO_PRIMARY: GatewayFallbackPolicy = {
  primaryModelId: null,
  fallback: { ok: true, present: true, config: { autoSwitch: true, models: ["openai/gpt-4.1"] } },
};

const MALFORMED: GatewayFallbackPolicy = {
  primaryModelId: "kimi-coding/k3",
  fallback: { ok: false, reason: "model.fallback.models must be an array." },
};

function errorRecord(): Record<string, unknown> {
  return { role: "assistant", content: [], stopReason: "error", errorMessage: "provider error (401)" };
}

function providerErrorEvents(retryExhausted: boolean): RpcEvent[] {
  const record = errorRecord();
  const events: RpcEvent[] = [{ type: "agent_start" }];
  if (retryExhausted) {
    events.push(
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "529 overloaded" },
      { type: "auto_retry_end", attempt: 3, maxAttempts: 3, success: false, finalError: "529 overloaded" },
    );
  }
  events.push(
    { type: "message_start", message: record },
    { type: "message_end", message: record },
    { type: "turn_end", message: { ...record, toolResults: [] } },
    { type: "agent_end", messages: [record], willRetry: false },
    { type: "agent_settled" },
  );
  return events;
}

function contaminatedEvents(): RpcEvent[] {
  const record = errorRecord();
  return [
    { type: "agent_start" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial" } },
    { type: "message_start", message: record },
    { type: "message_end", message: record },
    { type: "turn_end", message: { ...record, toolResults: [] } },
    { type: "agent_end", messages: [record], willRetry: false },
    { type: "agent_settled" },
  ];
}

function normalEvents(delta: string): RpcEvent[] {
  return [
    { type: "agent_start" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } },
    { type: "agent_end", messages: [], willRetry: false },
    { type: "agent_settled" },
  ];
}

/** Scripted fake client satisfying PiRpcClientLike (setModel included). */
class SchedulerFakeClient implements PiRpcClientLike {
  prompts: string[] = [];
  scripts: RpcEvent[][] = [];
  setModelCalls: Array<{ provider: string; modelId: string }> = [];
  rejectSetModelIds: string[] = [];
  hasSetModel = true;
  startError?: Error;
  promptError?: Error;
  private listeners: Array<(event: RpcEvent) => void> = [];
  private exitListeners: Array<() => void> = [];

  async start(): Promise<void> {
    if (this.startError !== undefined) throw this.startError;
  }
  async stop(): Promise<void> {}
  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  onExit(listener: () => void): () => void {
    this.exitListeners.push(listener);
    return () => {
      this.exitListeners = this.exitListeners.filter((l) => l !== listener);
    };
  }
  async prompt(message: string): Promise<void> {
    this.prompts.push(message);
    if (this.promptError !== undefined) throw this.promptError;
    const script = this.scripts.shift() ?? [];
    for (const event of script) {
      for (const listener of [...this.listeners]) listener(event);
    }
  }
  async setModel(provider: string, modelId: string): Promise<unknown> {
    this.setModelCalls.push({ provider, modelId });
    if (!this.hasSetModel) throw new Error("RPC client does not support set_model");
    if (this.rejectSetModelIds.includes(`${provider}/${modelId}`)) throw new Error("model not found");
    return { provider, modelId };
  }
}

let root: string;
let vault: string;
let configPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-scheduler-fallback-"));
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

async function writeConfig(opts: { allowed?: string[] }): Promise<void> {
  const lines = [`vault_root: ${vault}`];
  if (opts.allowed && opts.allowed.length > 0) {
    lines.push("allowed_agents:");
    for (const a of opts.allowed) lines.push(`  - ${a}`);
  }
  // 0.2.0 S2: these tests exercise the TB8 execution machinery, so the
  // fixture explicitly enables the scheduler and every automation class
  // (fresh installs resolve fail-closed disabled).
  lines.push(
    "scheduler:",
    "  enabled: true",
    "  automation:",
    "    inbox_tasks: true",
    "    agent_cron: true",
    "    script_cron: true",
  );
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

const tick = () => new Date("2026-07-07T08:00:00Z");

function fakeTarget(): RpcSpawnTarget {
  return { command: "fake", args: [], cwd: "/tmp", env: {} };
}

function makeRunner(client: SchedulerFakeClient, policy: GatewayFallbackPolicy | "loader-absent") {
  const loaderCalls: string[] = [];
  const runner = createAskRunner({
    targetBuilder: async () => fakeTarget(),
    clientFactory: () => client,
    fallbackPolicyLoader:
      policy === "loader-absent"
        ? undefined
        : async (input) => {
            loaderCalls.push(input.agentName);
            return policy;
          },
  });
  return { runner, loaderCalls };
}

describe("TB8 scheduler fallback — executeClaimedInboxTask through createAskRunner", () => {
  it("eligible provider_error_other: one same-client switch + verbatim claimed-task handoff + bounded evidence", async () => {
    const client = new SchedulerFakeClient();
    client.scripts = [providerErrorEvents(false), normalEvents("Fbk openai/gpt-4.1")];
    const { runner, loaderCalls } = makeRunner(client, POLICY);
    const claimed = "team/codex/inbox/task-a.claimed.heimdall.md";
    await writeInboxTask("codex", "task-a");

    const result = await executeClaimedInboxTask({
      vaultRoot: vault,
      agentName: "codex",
      claimedTaskPath: claimed,
      runner,
    });

    expect(loaderCalls).toEqual(["codex"]);
    expect(result.ok).toBe(true);
    expect(result.assistantText).toBe("Fbk openai/gpt-4.1");
    expect(client.setModelCalls).toEqual([{ provider: "openai", modelId: "gpt-4.1" }]);
    expect(client.prompts).toHaveLength(2);
    // The handoff wraps the original claimed-task prompt verbatim.
    expect(client.prompts[1]).toContain("[model fallback:");
    expect(client.prompts[1]).toContain("task-a");
    expect(result.modelFallback).toEqual([
      "[model fallback: kimi-coding/k3 failed (provider_error_other) → openai/gpt-4.1]",
    ]);
  });

  it("transient-exhausted category rotates with its honest category", async () => {
    const client = new SchedulerFakeClient();
    client.scripts = [providerErrorEvents(true), normalEvents("Fbk openai/gpt-4.1")];
    const { runner } = makeRunner(client, POLICY);
    await writeInboxTask("codex", "task-a");

    const result = await executeClaimedInboxTask({
      vaultRoot: vault,
      agentName: "codex",
      claimedTaskPath: "team/codex/inbox/task-a.claimed.heimdall.md",
      runner,
    });

    expect(result.ok).toBe(true);
    expect(result.modelFallback).toEqual([
      "[model fallback: kimi-coding/k3 failed (provider_error_transient_exhausted) → openai/gpt-4.1]",
    ]);
  });

  it("multi-fallback: rejected set_model is a visible unavailable skip with no original replay", async () => {
    const client = new SchedulerFakeClient();
    client.scripts = [providerErrorEvents(false), normalEvents("Fbk openai/gpt-4.1")];
    client.rejectSetModelIds = ["bogus/x"];
    const { runner } = makeRunner(client, policyWith(["bogus/x", "openai/gpt-4.1"]));
    await writeInboxTask("codex", "task-a");

    const result = await executeClaimedInboxTask({
      vaultRoot: vault,
      agentName: "codex",
      claimedTaskPath: "team/codex/inbox/task-a.claimed.heimdall.md",
      runner,
    });

    expect(result.ok).toBe(true);
    expect(client.setModelCalls).toEqual([
      { provider: "bogus", modelId: "x" },
      { provider: "openai", modelId: "gpt-4.1" },
    ]);
    expect(client.prompts).toHaveLength(2);
    expect(result.modelFallback).toEqual([
      "[model fallback: kimi-coding/k3 failed (provider_error_other) → bogus/x]",
      "[model fallback: bogus/x unavailable; skipping]",
      "[model fallback: kimi-coding/k3 failed (provider_error_other) → openai/gpt-4.1]",
    ]);
  });

  it("terminal exhaustion: typed failure kind exhausted, safe bounded evidence, no second execution", async () => {
    const client = new SchedulerFakeClient();
    client.scripts = [providerErrorEvents(false)];
    client.rejectSetModelIds = ["bogus/x"];
    const { runner } = makeRunner(client, policyWith(["bogus/x"]));
    await writeInboxTask("codex", "task-a");

    const result = await executeClaimedInboxTask({
      vaultRoot: vault,
      agentName: "codex",
      claimedTaskPath: "team/codex/inbox/task-a.claimed.heimdall.md",
      runner,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.failure?.kind).toBe("exhausted");
    expect(result.failure?.detail).toContain("kimi-coding/k3");
    expect(result.failure?.detail).not.toContain("401");
    expect(result.failure?.detail).not.toContain("provider error (401)");
    // No loop: the original prompt ran exactly once.
    expect(client.prompts).toHaveLength(1);
    expect(result.modelFallback?.slice(-1)).toEqual([
      "[model fallback: exhausted after 1 attempt(s) on kimi-coding/k3 (provider_error_other)]",
    ]);
  });

  it("inert absent/malformed/disabled/no-primary policies never fall back and produce no evidence", async () => {
    for (const policy of [NO_PRIMARY, MALFORMED, policyWith(["openai/gpt-4.1"], false)]) {
      const client = new SchedulerFakeClient();
      client.scripts = [normalEvents("Hello")];
      const { runner } = makeRunner(client, policy);
      await writeInboxTask("codex", "task-a");
      const result = await executeClaimedInboxTask({
        vaultRoot: vault,
        agentName: "codex",
        claimedTaskPath: "team/codex/inbox/task-a.claimed.heimdall.md",
        runner,
      });
      expect(result.ok).toBe(true);
      expect(result.assistantText).toBe("Hello");
      expect(client.setModelCalls).toEqual([]);
      expect(client.prompts).toHaveLength(1);
      expect(result.modelFallback).toBeUndefined();
    }
  });

  it("no loader provided (production scheduler runner without policy) stays inert", async () => {
    const client = new SchedulerFakeClient();
    client.scripts = [providerErrorEvents(false)];
    const { runner } = makeRunner(client, "loader-absent");
    await writeInboxTask("codex", "task-a");
    const result = await executeClaimedInboxTask({
      vaultRoot: vault,
      agentName: "codex",
      claimedTaskPath: "team/codex/inbox/task-a.claimed.heimdall.md",
      runner,
    });
    // Inert: a settled provider-error run keeps existing completed semantics.
    expect(result.ok).toBe(true);
    expect(client.setModelCalls).toEqual([]);
    expect(client.prompts).toHaveLength(1);
    expect(result.modelFallback).toBeUndefined();
  });

  it("contamination never falls back and keeps existing reply semantics", async () => {
    const client = new SchedulerFakeClient();
    client.scripts = [contaminatedEvents()];
    const { runner } = makeRunner(client, POLICY);
    await writeInboxTask("codex", "task-a");
    const result = await executeClaimedInboxTask({
      vaultRoot: vault,
      agentName: "codex",
      claimedTaskPath: "team/codex/inbox/task-a.claimed.heimdall.md",
      runner,
    });
    expect(result.ok).toBe(true);
    expect(result.assistantText).toBe("Partial");
    expect(client.setModelCalls).toEqual([]);
    expect(client.prompts).toHaveLength(1);
    expect(result.modelFallback).toBeUndefined();
  });

  it("prompt rejection stays ambiguous with no fallback evidence", async () => {
    const client = new SchedulerFakeClient();
    client.promptError = new Error("Timed out waiting for agent_settled.");
    const { runner } = makeRunner(client, POLICY);
    await writeInboxTask("codex", "task-a");
    const result = await executeClaimedInboxTask({
      vaultRoot: vault,
      agentName: "codex",
      claimedTaskPath: "team/codex/inbox/task-a.claimed.heimdall.md",
      runner,
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("ambiguous");
    expect(client.setModelCalls).toEqual([]);
    expect(result.modelFallback).toBeUndefined();
  });

  it("start rejection stays launch_failure with no fallback evidence", async () => {
    const client = new SchedulerFakeClient();
    client.startError = new Error("Failed to spawn agent: ENOENT pi binary");
    const { runner } = makeRunner(client, POLICY);
    await writeInboxTask("codex", "task-a");
    const result = await executeClaimedInboxTask({
      vaultRoot: vault,
      agentName: "codex",
      claimedTaskPath: "team/codex/inbox/task-a.claimed.heimdall.md",
      runner,
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("launch_failure");
    expect(result.failure?.milestone).toBe("start_rejection");
    expect(client.prompts).toEqual([]);
    expect(result.modelFallback).toBeUndefined();
  });
});

describe("TB8 scheduler fallback — schedulerOnce terminal triage + visible summary", () => {
  function recordingRetry(): { retryTransition: SchedulerOnceRetryTransition; calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      retryTransition: async (input) => {
        calls.push(input);
        return { action: "held", claimedTaskPath: input.claimedTaskPath, reason: "no retry policy" };
      },
      calls,
    };
  }

  function recordingRelease(): { release: SchedulerOnceRelease; calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      release: async (input) => {
        calls.push(input);
        return { action: "released", claimedTaskPath: input.claimedTaskPath, restoredPath: "x", restoredAbsolutePath: "/x" };
      },
      calls,
    };
  }

  function inboxExecutors(runner: ReturnType<typeof createAskRunner>): SchedulerOnceExecutors {
    return {
      executeInboxTask: (input) =>
        executeClaimedInboxTask({
          vaultRoot: input.vaultRoot,
          agentName: input.agentName,
          claimedTaskPath: input.claimedTaskPath,
          runner,
        }),
      executeAgentCronJob: () => {
        throw new Error("not called");
      },
      executeScriptCronJob: () => {
        throw new Error("not called");
      },
    };
  }

  it("fallback exhaustion: exactly one execution, stays claimed, no retry/release, bounded summary evidence", async () => {
    await writeConfig({ allowed: ["codex"] });
    await writeInboxTask("codex", "task-a");
    const client = new SchedulerFakeClient();
    client.scripts = [providerErrorEvents(false)];
    client.rejectSetModelIds = ["bogus/x"];
    const { runner } = makeRunner(client, policyWith(["bogus/x"]));
    const retry = recordingRetry();
    const release = recordingRelease();

    const result = await schedulerOnce({
      configPath,
      deviceId: "heimdall",
      now: tick,
      executors: inboxExecutors(runner),
      retryTransition: retry.retryTransition,
      release: release.release,
    });

    // Exactly one execution of exactly one claimed item.
    expect(result.executed).toBe(true);
    expect(client.prompts).toHaveLength(1);
    expect(result.executionStatus).toBe("failed");
    // NEVER the retry/requeue seam (only launch_failure may reach it).
    expect(retry.calls).toHaveLength(0);
    // NEVER the completion-release seam (only ok releases).
    expect(release.calls).toHaveLength(0);
    // Bounded non-secret summary evidence, visible in the printed summary.
    expect(result.modelFallback).toEqual([
      "[model fallback: kimi-coding/k3 failed (provider_error_other) → bogus/x]",
      "[model fallback: bogus/x unavailable; skipping]",
      "[model fallback: exhausted after 1 attempt(s) on kimi-coding/k3 (provider_error_other)]",
    ]);
    expect(result.summary).toContain("model fallback:");
    expect(result.summary).toContain("exhausted after 1 attempt(s)");
    expect(result.summary).not.toContain("401");
  });

  it("normal completion after fallback releases exactly once and keeps the success summary", async () => {
    await writeConfig({ allowed: ["codex"] });
    await writeInboxTask("codex", "task-a");
    const client = new SchedulerFakeClient();
    client.scripts = [providerErrorEvents(false), normalEvents("Fbk openai/gpt-4.1")];
    const { runner } = makeRunner(client, POLICY);
    const release = recordingRelease();
    const retry = recordingRetry();

    const result = await schedulerOnce({
      configPath,
      deviceId: "heimdall",
      now: tick,
      executors: inboxExecutors(runner),
      release: release.release,
      retryTransition: retry.retryTransition,
    });

    expect(result.executionStatus).toBe("completed");
    expect(result.executionSummary).toBe("Fbk openai/gpt-4.1");
    expect(result.modelFallback).toEqual([
      "[model fallback: kimi-coding/k3 failed (provider_error_other) → openai/gpt-4.1]",
    ]);
    expect(release.calls).toHaveLength(1);
    expect(retry.calls).toHaveLength(0);
    expect(result.summary).toContain("model fallback:");
  });

  it("agent-mode cron uses the same shared runner semantics (fallback evidence in the run record)", async () => {
    // A cron job for codex in agent mode runs through the SAME runner, so it
    // gains the same bounded fallback behavior; the record body carries the
    // bounded evidence. Script-mode cron stays LLM-free (no fallback).
    await writeConfig({ allowed: ["codex"] });
    await mkdir(join(vault, "team", "codex", "cron", "runs"), { recursive: true });
    const jobPath = "cron/jobs/job-a.md";
    const claimedPath = "cron/jobs/job-a.claimed.heimdall.md";
    await mkdir(join(vault, "cron", "jobs"), { recursive: true });
    const jobContent = [
      "---",
      "id: job-a",
      "agent: codex",
      'schedule: "30m"',
      "mode: agent",
      "enabled: true",
      "device_policy:",
      "  mode: highest_priority",
      "  allowed_devices: []",
      "---",
      "",
      "# Prompt",
      "",
      "Run the cron job.",
      "",
    ].join("\n");
    // The executor reads the CLAIMED job file directly.
    await writeFile(join(vault, claimedPath), jobContent);
    const client = new SchedulerFakeClient();
    client.scripts = [providerErrorEvents(false), normalEvents("Fbk openai/gpt-4.1")];
    const { runner } = makeRunner(client, POLICY);

    const result = await executeClaimedAgentCronJob({
      vaultRoot: vault,
      agentName: "codex",
      claimedJobPath: claimedPath,
      runner,
      now: tick,
    });

    expect(result.ok).toBe(true);
    expect(client.setModelCalls).toEqual([{ provider: "openai", modelId: "gpt-4.1" }]);
    expect(client.prompts).toHaveLength(2);
    // The run record body carries bounded fallback evidence.
    const record = await readFile(join(vault, result.runRecordPath), "utf8");
    expect(record).toContain("[model fallback: kimi-coding/k3 failed (provider_error_other) → openai/gpt-4.1]");
    expect(record).not.toContain("401");
    expect(record).not.toContain("provider error (401)");
  });

  it("a typed launch_failure still invokes the retry seam (unchanged)", async () => {
    await writeConfig({ allowed: ["codex"] });
    await writeInboxTask("codex", "task-a");
    const client = new SchedulerFakeClient();
    client.startError = new Error("Failed to spawn agent: ENOENT pi binary");
    const { runner } = makeRunner(client, POLICY);
    const retry = recordingRetry();

    const result = await schedulerOnce({
      configPath,
      deviceId: "heimdall",
      now: tick,
      executors: inboxExecutors(runner),
      retryTransition: retry.retryTransition,
    });

    expect(retry.calls).toHaveLength(1);
    expect((retry.calls[0] as { failureKind: string }).failureKind).toBe("launch_failure");
    expect(client.prompts).toEqual([]);
  });
});
