import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  buildSchedulerConfigBlock,
  mergeSchedulerIntoConfig,
  renderSchedulerPreview,
  parsePositiveIntInput,
  parseDeviceIdInput,
} from "../src/scheduler-configure.js";
import { resolveSchedulerConfig } from "../src/scheduler-loop.js";
import type { LocalPirenConfig } from "../src/bootstrap.js";

describe("buildSchedulerConfigBlock", () => {
  it("serializes the closed typed scheduler inventory", () => {
    const block = buildSchedulerConfigBlock({
      enabled: true,
      inboxTasks: true,
      agentCron: false,
      scriptCron: true,
      pollIntervalSeconds: 30,
      staleAfterSeconds: 300,
      maxConcurrentAgents: 1,
      deviceId: "thor",
    });
    expect(block).toEqual({
      enabled: true,
      automation: {
        inbox_tasks: true,
        agent_cron: false,
        script_cron: true,
      },
      poll_interval_seconds: 30,
      stale_after_seconds: 300,
      max_concurrent_agents: 1,
      device_id: "thor",
    });
  });

  it("omits device_id when blank (sanitized-hostname fallback)", () => {
    const block = buildSchedulerConfigBlock({
      enabled: false,
      inboxTasks: false,
      agentCron: false,
      scriptCron: false,
      pollIntervalSeconds: 30,
      staleAfterSeconds: 300,
      maxConcurrentAgents: 1,
    });
    expect(block).not.toHaveProperty("device_id");
  });
});

describe("mergeSchedulerIntoConfig", () => {
  const managed = buildSchedulerConfigBlock({
    enabled: true,
    inboxTasks: true,
    agentCron: true,
    scriptCron: false,
    pollIntervalSeconds: 45,
    staleAfterSeconds: 600,
    maxConcurrentAgents: 2,
    deviceId: "thor",
  });

  it("preserves every unrelated top-level block and key", () => {
    const existing = [
      "vault_root: /srv/vault",
      "allowed_agents:",
      "  - dipu",
      "telegram:",
      "  bot_token: \"123:secret\"",
      "  allowed_chat_ids:",
      "    - 42",
      "packages:",
      "  - \"@piren/web-search\"",
      "",
    ].join("\n");
    const merged = mergeSchedulerIntoConfig(existing, managed);
    const parsed = parseYaml(merged) as Record<string, unknown>;
    expect(parsed.vault_root).toBe("/srv/vault");
    expect(parsed.allowed_agents).toEqual(["dipu"]);
    expect(parsed.telegram).toEqual({ bot_token: "123:secret", allowed_chat_ids: [42] });
    expect(parsed.packages).toEqual(["@piren/web-search"]);
    expect(parsed.scheduler).toMatchObject({ enabled: true, poll_interval_seconds: 45 });
  });

  it("preserves scheduler fields outside the declared inventory", () => {
    const existing = [
      "scheduler:",
      "  enabled: false",
      "  future_unknown_key: keep-me",
      "  automation:",
      "    inbox_tasks: false",
      "    unknown_class: true",
      "",
    ].join("\n");
    const merged = mergeSchedulerIntoConfig(existing, managed);
    const parsed = parseYaml(merged) as { scheduler: Record<string, unknown> };
    expect(parsed.scheduler.future_unknown_key).toBe("keep-me");
    expect(parsed.scheduler.enabled).toBe(true);
    expect(parsed.scheduler.automation).toMatchObject({
      inbox_tasks: true,
      agent_cron: true,
      script_cron: false,
      unknown_class: true,
    });
  });

  it("clears device_id with an explicit deletion marker and never serializes null", () => {
    const existing = "scheduler:\n  enabled: true\n  device_id: thor\n";
    const withoutDevice = buildSchedulerConfigBlock({
      enabled: true,
      inboxTasks: true,
      agentCron: true,
      scriptCron: true,
      pollIntervalSeconds: 30,
      staleAfterSeconds: 300,
      maxConcurrentAgents: 1,
    });
    const merged = mergeSchedulerIntoConfig(existing, withoutDevice);
    expect(merged).not.toContain("device_id");
    expect(merged).not.toContain("null");
  });

  it("round-trips through resolveSchedulerConfig with the intended effective state", () => {
    const merged = mergeSchedulerIntoConfig("", managed);
    const resolved = resolveSchedulerConfig(parseYaml(merged) as LocalPirenConfig);
    expect(resolved.enabled).toBe(true);
    expect(resolved.automation).toEqual({ inboxTasks: true, agentCron: true, scriptCron: false });
    expect(resolved.pollIntervalSeconds).toBe(45);
    expect(resolved.staleAfterSeconds).toBe(600);
    expect(resolved.maxConcurrentAgents).toBe(2);
    expect(resolved.deviceId).toBe("thor");
    // An explicit enabled key means no migration signal remains.
    expect(resolved.migration).toBeUndefined();
  });
});

describe("renderSchedulerPreview", () => {
  it("renders only the bounded scheduler block as exact YAML", () => {
    const block = buildSchedulerConfigBlock({
      enabled: true,
      inboxTasks: false,
      agentCron: true,
      scriptCron: true,
      pollIntervalSeconds: 30,
      staleAfterSeconds: 300,
      maxConcurrentAgents: 1,
      deviceId: "thor",
    });
    const preview = renderSchedulerPreview(block);
    expect(preview).toContain("scheduler:");
    expect(preview).toContain("enabled: true");
    expect(preview).toContain("inbox_tasks: false");
    expect(preview).toContain("device_id: thor");
    // Bounded: never the whole config document.
    expect(preview).not.toContain("vault_root");
    expect(preview).not.toContain("allowed_agents");
  });
});

describe("parsePositiveIntInput", () => {
  it("accepts a positive integer", () => {
    expect(parsePositiveIntInput("30", "poll_interval_seconds")).toEqual({ ok: true, value: 30 });
  });

  it("rejects zero, negatives, non-integers, and non-numeric input with a bounded error", () => {
    for (const raw of ["0", "-5", "1.5", "abc", ""]) {
      const result = parsePositiveIntInput(raw, "poll_interval_seconds");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("poll_interval_seconds");
    }
  });

  it("never echoes an invalid interval entry in an error", () => {
    const secret = "scheduler-secret-must-not-appear";
    const result = parsePositiveIntInput(secret, "poll_interval_seconds");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain(secret);
  });
});

describe("parseDeviceIdInput", () => {
  it("accepts a valid device id", () => {
    expect(parseDeviceIdInput("thor")).toEqual({ ok: true, value: "thor" });
    expect(parseDeviceIdInput("pi-4-2")).toEqual({ ok: true, value: "pi-4-2" });
  });

  it("treats blank as absent (sanitized-hostname fallback)", () => {
    expect(parseDeviceIdInput("")).toEqual({ ok: true, value: undefined });
    expect(parseDeviceIdInput("   ")).toEqual({ ok: true, value: undefined });
  });

  it("rejects ids the claim validators would reject", () => {
    for (const raw of ["Thor", "1thor", "thor_pi", "thor pi", "-thor"]) {
      const result = parseDeviceIdInput(raw);
      expect(result.ok).toBe(false);
    }
  });

  it("never echoes an invalid device-id entry in an error", () => {
    const secret = "scheduler-secret-must-not-appear";
    const result = parseDeviceIdInput(`${secret}!`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// Runner (injected prompt + fake IO)
// ---------------------------------------------------------------------------

import { runSchedulerConfigure, type SchedulerConfigureResult } from "../src/scheduler-configure.js";
import type { TransportConfigureIo } from "../src/transport-configure.js";
import type { WizardPrompt } from "../src/prompt.js";

interface FakePromptCalls {
  text: Array<{ message: string; defaultValue?: string }>;
  confirm: Array<{ message: string; defaultValue?: boolean }>;
}

function fakePrompt(script: {
  textAnswers?: Array<string | undefined>;
  confirmAnswers?: boolean[];
}): { prompt: WizardPrompt; calls: FakePromptCalls } {
  const textQ = [...(script.textAnswers ?? [])];
  const confirmQ = [...(script.confirmAnswers ?? [])];
  const calls: FakePromptCalls = { text: [], confirm: [] };
  const prompt: WizardPrompt = {
    async text(message: string, defaultValue?: string) {
      calls.text.push(defaultValue === undefined ? { message } : { message, defaultValue });
      const answer = textQ.shift();
      if (answer === undefined) return defaultValue ?? "";
      return answer;
    },
    async secret() {
      throw new Error("scheduler configure must never prompt for secrets");
    },
    async confirm(message: string, defaultValue?: boolean) {
      calls.confirm.push(defaultValue === undefined ? { message } : { message, defaultValue });
      const answer = confirmQ.shift();
      return answer ?? defaultValue ?? false;
    },
    async select() {
      throw new Error("scheduler configure has no select prompts");
    },
    async list() {
      throw new Error("scheduler configure has no list prompts");
    },
  };
  return { prompt, calls };
}

function fakeIo(existing?: string): { io: TransportConfigureIo; writes: Array<{ path: string; content: string }> } {
  const writes: Array<{ path: string; content: string }> = [];
  const io: TransportConfigureIo = {
    async readConfig() {
      return existing ?? null;
    },
    async writeConfigAtomic(path: string, content: string) {
      writes.push({ path, content });
    },
  };
  return { io, writes };
}

function fakeIoFailure(existing: string | undefined, failure: Error): { io: TransportConfigureIo; writes: Array<{ path: string; content: string }> } {
  const writes: Array<{ path: string; content: string }> = [];
  const io: TransportConfigureIo = {
    async readConfig() {
      return existing ?? null;
    },
    async writeConfigAtomic(path: string, content: string) {
      writes.push({ path, content });
      throw failure;
    },
  };
  return { io, writes };
}

const CONFIRM_ALL_YES = [true, true, true, true, true, true, true];

describe("runSchedulerConfigure", () => {
  it("fresh config: displays fail-closed state, prompts with false defaults, previews, confirms, writes", async () => {
    const { prompt, calls } = fakePrompt({ confirmAnswers: CONFIRM_ALL_YES });
    const { io, writes } = fakeIo(undefined);
    const logs: string[] = [];

    const result = await runSchedulerConfigure(prompt, {
      configPath: "/cfg/config.yml",
      io,
      log: (m) => logs.push(m),
    });

    // Current-state display shows the fail-closed fresh resolution.
    const shown = logs.join("\n");
    expect(shown).toContain("scheduler enabled: no");
    expect(shown).toContain("inbox_tasks=off");
    // Defaults offered consume the resolver: every gate defaults to false.
    const gatePrompts = calls.confirm.filter((c) => c.message.includes("scheduler.enabled") || c.message.includes("automation."));
    expect(gatePrompts.length).toBe(4);
    for (const gate of gatePrompts) expect(gate.defaultValue).toBe(false);
    // Preview was shown before the write confirmation, and is bounded.
    expect(shown).toContain("scheduler:");
    expect(shown).not.toContain("vault_root");
    // Written exactly once with the chosen values.
    expect(writes).toHaveLength(1);
    const written = parseYaml(writes[0]!.content) as { scheduler: Record<string, unknown> };
    expect(written.scheduler).toMatchObject({
      enabled: true,
      automation: { inbox_tasks: true, agent_cron: true, script_cron: true },
      poll_interval_seconds: 30,
      stale_after_seconds: 300,
      max_concurrent_agents: 1,
    });
    expect(result.wrote).toBe(true);
    expect(result.cancelled).toBe(false);
  });

  it("preserves unrelated blocks and never touches their contents", async () => {
    const existing = [
      "vault_root: /srv/vault",
      "allowed_agents:",
      "  - dipu",
      "telegram:",
      "  bot_token: \"123:secret-token\"",
      "  allowed_chat_ids:",
      "    - 42",
      "",
    ].join("\n");
    const { prompt } = fakePrompt({ confirmAnswers: CONFIRM_ALL_YES });
    const { io, writes } = fakeIo(existing);

    await runSchedulerConfigure(prompt, { configPath: "/cfg", io, log: () => {} });

    expect(writes).toHaveLength(1);
    const written = parseYaml(writes[0]!.content) as Record<string, unknown>;
    expect(written.telegram).toEqual({ bot_token: "123:secret-token", allowed_chat_ids: [42] });
    expect(written.vault_root).toBe("/srv/vault");
    expect(written.allowed_agents).toEqual(["dipu"]);
  });

  it("legacy block: shows effective enabled=true with migration notice and materializes enabled:true only on confirmation", async () => {
    const existing = "vault_root: /v\nscheduler:\n  poll_interval_seconds: 45\n";
    const logs: string[] = [];
    const { prompt } = fakePrompt({ confirmAnswers: CONFIRM_ALL_YES });
    const { io, writes } = fakeIo(existing);

    const result = await runSchedulerConfigure(prompt, { configPath: "/cfg", io, log: (m) => logs.push(m) });

    const shown = logs.join("\n");
    expect(shown).toContain("scheduler enabled: yes");
    expect(shown).toMatch(/migration/i);
    expect(writes).toHaveLength(1);
    const written = parseYaml(writes[0]!.content) as { scheduler: Record<string, unknown> };
    expect(written.scheduler.enabled).toBe(true);
    expect(written.scheduler.poll_interval_seconds).toBe(45);
    expect(result.materializedMigration).toBe(true);
    // Round-trip: no migration signal remains after the explicit write.
    const resolved = resolveSchedulerConfig(parseYaml(writes[0]!.content) as LocalPirenConfig);
    expect(resolved.migration).toBeUndefined();
  });

  it("legacy block + decline: no write, no materialization", async () => {
    const existing = "vault_root: /v\nscheduler:\n  poll_interval_seconds: 45\n";
    const { prompt } = fakePrompt({
      // Accept all gate defaults but decline the final write confirmation.
      confirmAnswers: [true, true, true, true, false],
    });
    const { io, writes } = fakeIo(existing);

    const result = await runSchedulerConfigure(prompt, { configPath: "/cfg", io, log: () => {} });

    expect(writes).toHaveLength(0);
    expect(result.wrote).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.materializedMigration).toBe(false);
  });

  it("decline at the write confirmation leaves a fresh config unwritten", async () => {
    const { prompt } = fakePrompt({ confirmAnswers: [false, false, false, false, false] });
    const { io, writes } = fakeIo(undefined);

    const result = await runSchedulerConfigure(prompt, { configPath: "/cfg", io, log: () => {} });

    expect(writes).toHaveLength(0);
    expect(result.cancelled).toBe(true);
  });

  it("fails closed on unparseable existing config without prompting or writing", async () => {
    const { prompt, calls } = fakePrompt({});
    const { io, writes } = fakeIo("scheduler: [unclosed\n  : : :");

    await expect(
      runSchedulerConfigure(prompt, { configPath: "/cfg", io, log: () => {} }),
    ).rejects.toThrow(/not parseable/i);
    expect(calls.confirm).toHaveLength(0);
    expect(calls.text).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it("fails closed on a non-mapping existing config", async () => {
    const { prompt } = fakePrompt({});
    const { io, writes } = fakeIo("- just\n- a\n- list\n");

    await expect(
      runSchedulerConfigure(prompt, { configPath: "/cfg", io, log: () => {} }),
    ).rejects.toThrow(/not parseable as a YAML mapping/i);
    expect(writes).toHaveLength(0);
  });

  it("re-prompts on invalid interval input and accepts a corrected value", async () => {
    const { prompt, calls } = fakePrompt({
      // poll interval: invalid, then valid; stale/concurrency/device default.
      textAnswers: ["abc", "60"],
      confirmAnswers: CONFIRM_ALL_YES,
    });
    const { io, writes } = fakeIo(undefined);

    await runSchedulerConfigure(prompt, { configPath: "/cfg", io, log: () => {} });

    const pollPrompts = calls.text.filter((t) => t.message.toLowerCase().includes("poll interval"));
    expect(pollPrompts.length).toBe(2);
    const written = parseYaml(writes[0]!.content) as { scheduler: Record<string, unknown> };
    expect(written.scheduler.poll_interval_seconds).toBe(60);
  });

  it("re-prompts on an invalid device id and omits the key when left blank", async () => {
    const { prompt } = fakePrompt({
      // intervals default; device id: invalid then blank.
      textAnswers: [undefined, undefined, undefined, "Bad_Id", ""],
      confirmAnswers: CONFIRM_ALL_YES,
    });
    const { io, writes } = fakeIo(undefined);

    await runSchedulerConfigure(prompt, { configPath: "/cfg", io, log: () => {} });

    expect(writes).toHaveLength(1);
    expect(writes[0]!.content).not.toContain("device_id");
  });

  it("a write failure propagates a bounded error and the original bytes are never replaced", async () => {
    const existing = "vault_root: /v\nscheduler:\n  enabled: false\n";
    const { prompt } = fakePrompt({ confirmAnswers: CONFIRM_ALL_YES });
    const { io, writes } = fakeIoFailure(existing, new Error("disk full"));

    await expect(
      runSchedulerConfigure(prompt, { configPath: "/cfg", io, log: () => {} }),
    ).rejects.toThrow(/disk full|write/i);
    // The atomic seam was invoked exactly once (temp+rename); the fake
    // rejects before any replacement, so the original is byte-for-byte intact
    // by construction — the runner performs no other mutation path.
    expect(writes).toHaveLength(1);
  });

  it("fails before prompting when readConfig rejects with a non-ENOENT error", async () => {
    const { prompt, calls } = fakePrompt({});
    const io: TransportConfigureIo = {
      async readConfig() {
        const error = new Error("Permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      },
      async writeConfigAtomic() {
        throw new Error("must not write");
      },
    };

    await expect(
      runSchedulerConfigure(prompt, { configPath: "/cfg", io, log: () => {} }),
    ).rejects.toThrow(/permission denied/i);
    expect(calls.confirm).toHaveLength(0);
    expect(calls.text).toHaveLength(0);
  });

  it("writes custom gate/class/interval/device values end to end", async () => {
    const { prompt } = fakePrompt({
      // enabled no; inbox no; agent yes; script no; intervals; device id.
      confirmAnswers: [false, false, true, false, true],
      textAnswers: ["10", "120", "3", "pi-4"],
    });
    const { io, writes } = fakeIo(undefined);

    await runSchedulerConfigure(prompt, { configPath: "/cfg", io, log: () => {} });

    const written = parseYaml(writes[0]!.content) as { scheduler: Record<string, unknown> };
    expect(written.scheduler).toEqual({
      enabled: false,
      automation: { inbox_tasks: false, agent_cron: true, script_cron: false },
      poll_interval_seconds: 10,
      stale_after_seconds: 120,
      max_concurrent_agents: 3,
      device_id: "pi-4",
    });
  });

  it("previews only the managed scheduler patch and never echoes preserved unknown content", async () => {
    const secret = "scheduler-secret-must-not-appear";
    const existing = [
      "scheduler:",
      `  future_unknown_key: ${secret}`,
      "  automation:",
      `    future_unknown_class: ${secret}`,
      "",
    ].join("\n");
    const { prompt } = fakePrompt({ confirmAnswers: CONFIRM_ALL_YES });
    const { io, writes } = fakeIo(existing);
    const logs: string[] = [];

    await runSchedulerConfigure(prompt, { configPath: "/cfg", io, log: (message) => logs.push(message) });

    expect(writes[0]!.content).toContain(secret);
    expect(logs.join("\n")).not.toContain(secret);
  });

  it("clears a previously configured device_id when the operator leaves it blank", async () => {
    const existing = "scheduler:\n  enabled: true\n  device_id: thor\n  automation:\n    inbox_tasks: true\n    agent_cron: true\n    script_cron: true\n";
    const { prompt } = fakePrompt({
      confirmAnswers: CONFIRM_ALL_YES,
      textAnswers: [undefined, undefined, undefined, ""],
    });
    const { io, writes } = fakeIo(existing);

    await runSchedulerConfigure(prompt, { configPath: "/cfg", io, log: () => {} });

    expect(writes[0]!.content).not.toContain("device_id");
  });

  it("never starts a service, ticks the scheduler, contacts a platform, or writes the vault (structural)", async () => {
    // The runner's only injected effect seams are the prompt, the log, and
    // the two config-file IO functions; there is no service/platform/vault/
    // scheduler dependency to invoke. Assert the exact IO surface used.
    const { prompt } = fakePrompt({ confirmAnswers: CONFIRM_ALL_YES });
    const ioCalls: string[] = [];
    const io: TransportConfigureIo = {
      async readConfig() {
        ioCalls.push("read");
        return null;
      },
      async writeConfigAtomic() {
        ioCalls.push("write");
      },
    };

    await runSchedulerConfigure(prompt, { configPath: "/cfg", io, log: () => {} });

    expect(ioCalls).toEqual(["read", "write"]);
  });
});
