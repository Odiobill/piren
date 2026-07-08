import { describe, expect, it } from "vitest";
import type { LocalPirenConfig } from "../src/bootstrap.js";
import type {
  SchedulerOnceOptions,
  SchedulerOnceResult,
  SchedulerOnceExecutors,
} from "../src/scheduler-once.js";
import {
  createSchedulerLoopController,
  createRealSchedulerLoopSleep,
  resolveSchedulerConfig,
  runSchedulerLoop,
  type SchedulerLoopController,
  type SchedulerLoopOptions,
  type SchedulerLoopSleep,
} from "../src/scheduler-loop.js";

// ---------------------------------------------------------------------------
// resolveSchedulerConfig: pure local scheduler config resolver
// ---------------------------------------------------------------------------

describe("resolveSchedulerConfig: defaults", () => {
  it("returns conservative defaults when no scheduler block is present", () => {
    const resolved = resolveSchedulerConfig({});
    expect(resolved.pollIntervalSeconds).toBe(30);
    expect(resolved.staleAfterSeconds).toBe(300);
    expect(resolved.maxConcurrentAgents).toBe(1);
    expect(resolved.effectiveConcurrency).toBe(1);
    expect(resolved.deviceId).toBeUndefined();
    expect(resolved.warnings).toEqual([]);
  });

  it("returns conservative defaults when the scheduler block is empty", () => {
    const resolved = resolveSchedulerConfig({ scheduler: {} });
    expect(resolved.pollIntervalSeconds).toBe(30);
    expect(resolved.staleAfterSeconds).toBe(300);
    expect(resolved.maxConcurrentAgents).toBe(1);
    expect(resolved.deviceId).toBeUndefined();
  });

  it("reads provided values verbatim when valid", () => {
    const config: LocalPirenConfig = {
      scheduler: {
        poll_interval_seconds: 15,
        stale_after_seconds: 120,
        max_concurrent_agents: 2,
        device_id: "thor",
      },
    };
    const resolved = resolveSchedulerConfig(config);
    expect(resolved.pollIntervalSeconds).toBe(15);
    expect(resolved.staleAfterSeconds).toBe(120);
    expect(resolved.maxConcurrentAgents).toBe(2);
    expect(resolved.deviceId).toBe("thor");
  });
});

describe("resolveSchedulerConfig: invalid values fall back deterministically", () => {
  it("falls back to default poll_interval_seconds for non-positive/non-integer values and warns", () => {
    for (const bad of [0, -5, 1.5, NaN, "30", true, null]) {
      const resolved = resolveSchedulerConfig({
        scheduler: { poll_interval_seconds: bad as unknown as number },
      });
      expect(resolved.pollIntervalSeconds).toBe(30);
      expect(resolved.warnings.some((w) => w.includes("poll_interval_seconds"))).toBe(true);
    }
  });

  it("falls back to default stale_after_seconds for non-positive/non-integer values and warns", () => {
    const resolved = resolveSchedulerConfig({
      scheduler: { stale_after_seconds: 0 },
    });
    expect(resolved.staleAfterSeconds).toBe(300);
    expect(resolved.warnings.some((w) => w.includes("stale_after_seconds"))).toBe(true);
  });

  it("falls back to default max_concurrent_agents for non-positive/non-integer values and warns", () => {
    const resolved = resolveSchedulerConfig({
      scheduler: { max_concurrent_agents: 0 },
    });
    expect(resolved.maxConcurrentAgents).toBe(1);
    expect(resolved.warnings.some((w) => w.includes("max_concurrent_agents"))).toBe(true);
  });

  it("keeps a parsed max_concurrent_agents > 1 but reports effective concurrency 1 honestly", () => {
    const resolved = resolveSchedulerConfig({
      scheduler: { max_concurrent_agents: 4 },
    });
    expect(resolved.maxConcurrentAgents).toBe(4);
    expect(resolved.effectiveConcurrency).toBe(1);
  });

  it("ignores a non-string or blank device_id and leaves it undefined", () => {
    expect(resolveSchedulerConfig({ scheduler: { device_id: 123 as unknown as string } }).deviceId).toBeUndefined();
    expect(resolveSchedulerConfig({ scheduler: { device_id: "   " } }).deviceId).toBeUndefined();
    expect(resolveSchedulerConfig({ scheduler: { device_id: "" } }).deviceId).toBeUndefined();
  });

  it("passes a valid device_id verbatim (no silent sanitization)", () => {
    // S4 uses explicit ids as-is and downstream validators reject invalid
    // forms; the resolver must not trim/lowercase/transform the value.
    expect(resolveSchedulerConfig({ scheduler: { device_id: "thor" } }).deviceId).toBe("thor");
    expect(resolveSchedulerConfig({ scheduler: { device_id: "Thor-Pi4" } }).deviceId).toBe("Thor-Pi4");
  });
});

// ---------------------------------------------------------------------------
// Loop test helpers (fakes; no real time, no real fs, no real signals)
// ---------------------------------------------------------------------------

function noWorkResult(options: SchedulerOnceOptions): SchedulerOnceResult {
  const deviceId = options.deviceId ?? "fake-device";
  return {
    deviceId,
    enabledAgents: [],
    plannedCount: 0,
    claimAttempts: [],
    executed: false,
    noWork: true,
    summary: "fake no-work tick\n",
  };
}

function throwingExecutors(): SchedulerOnceExecutors {
  const boom = (): never => {
    throw new Error("executors should not be called by the loop directly");
  };
  return { executeInboxTask: boom, executeAgentCronJob: boom, executeScriptCronJob: boom };
}

interface FakeTick {
  fn: (options: SchedulerOnceOptions) => Promise<SchedulerOnceResult>;
  calls: SchedulerOnceOptions[];
}

/** Build a fake schedulerOnce that records calls and can request shutdown after N ticks. */
function fakeTick(opts: {
  controller: SchedulerLoopController;
  shutdownAfter?: number;
  throwOn?: (call: number) => boolean;
  inFlightTracker?: { max: number };
}): FakeTick {
  const calls: SchedulerOnceOptions[] = [];
  let n = 0;
  let inFlight = 0;
  const fn = async (options: SchedulerOnceOptions): Promise<SchedulerOnceResult> => {
    n += 1;
    calls.push(options);
    if (opts.inFlightTracker) {
      inFlight += 1;
      if (inFlight > opts.inFlightTracker.max) opts.inFlightTracker.max = inFlight;
    }
    await Promise.resolve();
    if (opts.inFlightTracker) inFlight -= 1;
    if (opts.throwOn?.(n)) throw new Error(`fake tick ${n} failure`);
    if (opts.shutdownAfter !== undefined && n >= opts.shutdownAfter) {
      opts.controller.requestShutdown("test-shutdown");
    }
    return noWorkResult(options);
  };
  return { fn, calls };
}

/** A sleep that resolves immediately, recording waits and cancels. */
function immediateSleep(): { sleep: SchedulerLoopSleep; waits: number[]; state: { cancels: number } } {
  const waits: number[] = [];
  const state = { cancels: 0 };
  return {
    sleep: {
      wait(ms: number) {
        waits.push(ms);
        return Promise.resolve();
      },
      cancel() {
        state.cancels += 1;
      },
    },
    waits,
    state,
  };
}

/** A sleep that requests shutdown when waited upon (simulates SIGINT during sleep). */
function shutdownSleep(controller: SchedulerLoopController): { sleep: SchedulerLoopSleep; waits: number[]; state: { cancels: number } } {
  const waits: number[] = [];
  const state = { cancels: 0 };
  return {
    sleep: {
      wait(ms: number) {
        waits.push(ms);
        controller.requestShutdown("during-sleep");
        return Promise.resolve();
      },
      cancel() {
        state.cancels += 1;
      },
    },
    waits,
    state,
  };
}

function baseLoopOptions(overrides: Partial<SchedulerLoopOptions> & { controller: SchedulerLoopController }): SchedulerLoopOptions {
  const logs: string[] = [];
  return {
    configPath: "/tmp/fake-config.yml",
    schedulerConfig: resolveSchedulerConfig({}),
    enabledAgents: ["codex"],
    schedulerOnce: async () => noWorkResult({ executors: throwingExecutors() }),
    executors: throwingExecutors(),
    sleep: immediateSleep().sleep,
    now: () => new Date("2026-07-08T10:00:00Z"),
    log: (m) => logs.push(m),
    ...overrides,
  } as SchedulerLoopOptions;
}

// ---------------------------------------------------------------------------
// runSchedulerLoop: loop behavior
// ---------------------------------------------------------------------------

describe("runSchedulerLoop: tick and sleep cadence", () => {
  it("calls schedulerOnce once per tick and sleeps between ticks, stopping after shutdown", async () => {
    const controller = createSchedulerLoopController();
    const tick = fakeTick({ controller, shutdownAfter: 3 });
    const { sleep, waits, state } = immediateSleep();

    const result = await runSchedulerLoop(
      baseLoopOptions({ controller, schedulerOnce: tick.fn, sleep }),
    );

    expect(tick.calls).toHaveLength(3);
    // Sleep happens BETWEEN ticks, not after the last (shutdown was requested
    // during tick 3, so no sleep after it).
    expect(waits).toHaveLength(2);
    expect(result.tickCount).toBe(3);
    expect(result.executedCount).toBe(0);
    expect(state.cancels).toBe(2);
  });

  it("waits according to schedulerConfig.poll_interval_seconds (ms = seconds * 1000)", async () => {
    const controller = createSchedulerLoopController();
    const tick = fakeTick({ controller, shutdownAfter: 3 });
    const { sleep, waits } = immediateSleep();
    const schedulerConfig = resolveSchedulerConfig({ scheduler: { poll_interval_seconds: 7 } });

    await runSchedulerLoop(baseLoopOptions({ controller, schedulerOnce: tick.fn, sleep, schedulerConfig }));

    expect(waits).toEqual([7000, 7000]);
  });

  it("does not launch parallel ticks (one-at-a-time effective concurrency)", async () => {
    const controller = createSchedulerLoopController();
    const tracker = { max: 0 };
    const tick = fakeTick({ controller, shutdownAfter: 3, inFlightTracker: tracker });
    const { sleep } = immediateSleep();

    await runSchedulerLoop(baseLoopOptions({ controller, schedulerOnce: tick.fn, sleep }));

    expect(tracker.max).toBe(1);
  });
});

describe("runSchedulerLoop: config pass-through to schedulerOnce", () => {
  it("passes scheduler.device_id override to the one-shot primitive", async () => {
    const controller = createSchedulerLoopController();
    const tick = fakeTick({ controller, shutdownAfter: 1 });
    const { sleep } = immediateSleep();
    const schedulerConfig = resolveSchedulerConfig({ scheduler: { device_id: "thor" } });

    await runSchedulerLoop(baseLoopOptions({ controller, schedulerOnce: tick.fn, sleep, schedulerConfig }));

    expect(tick.calls[0]?.deviceId).toBe("thor");
  });

  it("omits deviceId when scheduler.device_id is absent (S4 sanitized-hostname fallback)", async () => {
    const controller = createSchedulerLoopController();
    const tick = fakeTick({ controller, shutdownAfter: 1 });
    const { sleep } = immediateSleep();
    const schedulerConfig = resolveSchedulerConfig({}); // no device_id

    await runSchedulerLoop(baseLoopOptions({ controller, schedulerOnce: tick.fn, sleep, schedulerConfig }));

    expect(tick.calls[0]?.deviceId).toBeUndefined();
  });

  it("converts stale_after_seconds to ms and passes it to the one-shot primitive", async () => {
    const controller = createSchedulerLoopController();
    const tick = fakeTick({ controller, shutdownAfter: 1 });
    const { sleep } = immediateSleep();
    const schedulerConfig = resolveSchedulerConfig({ scheduler: { stale_after_seconds: 120 } });

    await runSchedulerLoop(baseLoopOptions({ controller, schedulerOnce: tick.fn, sleep, schedulerConfig }));

    expect(tick.calls[0]?.staleAfterMs).toBe(120_000);
  });

  it("passes the default stale_after (300s -> 300000ms) when not configured", async () => {
    const controller = createSchedulerLoopController();
    const tick = fakeTick({ controller, shutdownAfter: 1 });
    const { sleep } = immediateSleep();

    await runSchedulerLoop(baseLoopOptions({ controller, schedulerOnce: tick.fn, sleep }));

    expect(tick.calls[0]?.staleAfterMs).toBe(300_000);
  });

  it("threads configPath to every tick so schedulerOnce reads the right local config", async () => {
    const controller = createSchedulerLoopController();
    const tick = fakeTick({ controller, shutdownAfter: 2 });
    const { sleep } = immediateSleep();

    await runSchedulerLoop(baseLoopOptions({ controller, schedulerOnce: tick.fn, sleep, configPath: "/custom/config.yml" }));

    expect(tick.calls[0]?.configPath).toBe("/custom/config.yml");
    expect(tick.calls[1]?.configPath).toBe("/custom/config.yml");
  });
});

describe("runSchedulerLoop: shutdown behavior", () => {
  it("stops cleanly when shutdown is requested during sleep (no new tick, sleep cancelled)", async () => {
    const controller = createSchedulerLoopController();
    const tick = fakeTick({ controller }); // do not auto-shutdown
    const { sleep, waits, state } = shutdownSleep(controller);

    const result = await runSchedulerLoop(baseLoopOptions({ controller, schedulerOnce: tick.fn, sleep }));

    // One tick ran, then sleep requested shutdown: no second tick.
    expect(tick.calls).toHaveLength(1);
    expect(waits).toHaveLength(1);
    // The pending sleep was cancelled (no dangling timer).
    expect(state.cancels).toBe(1);
    expect(result.tickCount).toBe(1);
    expect(controller.shutdownRequested).toBe(true);
  });

  it("lets an already-started tick finish, then stops without sleeping", async () => {
    const controller = createSchedulerLoopController();
    // Tick 1 requests shutdown itself (simulates shutdown during a tick).
    const tick = fakeTick({ controller, shutdownAfter: 1 });
    const { sleep, waits } = immediateSleep();

    const result = await runSchedulerLoop(baseLoopOptions({ controller, schedulerOnce: tick.fn, sleep }));

    expect(tick.calls).toHaveLength(1);
    expect(waits).toHaveLength(0); // no sleep after the shutdown-requesting tick
    expect(result.tickCount).toBe(1);
  });

  it("does not start a new tick after shutdown is requested, even if more work exists", async () => {
    const controller = createSchedulerLoopController();
    const tick = fakeTick({ controller, shutdownAfter: 1 });
    const { sleep, waits } = immediateSleep();

    await runSchedulerLoop(baseLoopOptions({ controller, schedulerOnce: tick.fn, sleep }));

    // Only one tick despite no explicit cap: shutdown was requested during
    // tick 1, so the loop breaks before tick 2.
    expect(tick.calls).toHaveLength(1);
    expect(waits).toHaveLength(0);
  });

  it("survives a tick error, logs it, sleeps, and continues until shutdown", async () => {
    const controller = createSchedulerLoopController();
    const tick = fakeTick({ controller, shutdownAfter: 2, throwOn: (n) => n === 1 });
    const { sleep, waits } = immediateSleep();
    const logs: string[] = [];
    const options = baseLoopOptions({
      controller,
      schedulerOnce: tick.fn,
      sleep,
      log: (m) => logs.push(m),
    });

    const result = await runSchedulerLoop(options);

    expect(tick.calls).toHaveLength(2);
    expect(waits).toHaveLength(1); // slept after the failed tick
    expect(result.tickCount).toBe(2);
    expect(logs.some((l) => l.includes("failed") && l.includes("fake tick 1 failure"))).toBe(true);
  });
});

describe("runSchedulerLoop: operator-readable output", () => {
  it("logs a startup summary with device id, enabled agents, poll interval, stale-after, and effective max concurrency", async () => {
    const controller = createSchedulerLoopController();
    const tick = fakeTick({ controller, shutdownAfter: 1 });
    const { sleep } = immediateSleep();
    const logs: string[] = [];
    const schedulerConfig = resolveSchedulerConfig({
      scheduler: { poll_interval_seconds: 45, stale_after_seconds: 200, max_concurrent_agents: 3, device_id: "thor" },
    });

    await runSchedulerLoop(
      baseLoopOptions({
        controller,
        schedulerOnce: tick.fn,
        sleep,
        schedulerConfig,
        enabledAgents: ["codex", "deepseek"],
        log: (m) => logs.push(m),
      }),
    );

    const startup = logs.find((l) => l.includes("SCHEDULER LOOP")) ?? "";
    expect(startup).toContain("thor");
    expect(startup).toContain("codex");
    expect(startup).toContain("deepseek");
    expect(startup).toContain("45");
    expect(startup).toContain("200");
    expect(startup).toMatch(/effective.*1|1.*effective|one-at-a-time/i);
  });

  it("logs a clean shutdown summary with the tick count", async () => {
    const controller = createSchedulerLoopController();
    const tick = fakeTick({ controller, shutdownAfter: 2 });
    const { sleep } = immediateSleep();
    const logs: string[] = [];

    const result = await runSchedulerLoop(
      baseLoopOptions({ controller, schedulerOnce: tick.fn, sleep, log: (m) => logs.push(m) }),
    );

    const shutdown = logs.find((l) => l.toLowerCase().includes("shutdown")) ?? "";
    expect(shutdown.length).toBeGreaterThan(0);
    expect(shutdown).toContain(String(result.tickCount));
    expect(result.summary).toContain("shutdown");
  });

  it("reports config warnings in the startup summary when values fell back", async () => {
    const controller = createSchedulerLoopController();
    const tick = fakeTick({ controller, shutdownAfter: 1 });
    const { sleep } = immediateSleep();
    const logs: string[] = [];
    const schedulerConfig = resolveSchedulerConfig({
      scheduler: { poll_interval_seconds: 0, max_concurrent_agents: 4 },
    });

    // poll_interval_seconds=0 is invalid -> warning; max_concurrent_agents=4
    // is valid (just capped to effective 1) -> no warning for it.
    expect(schedulerConfig.maxConcurrentAgents).toBe(4);
    expect(schedulerConfig.effectiveConcurrency).toBe(1);
    expect(schedulerConfig.warnings.some((w) => w.includes("poll_interval_seconds"))).toBe(true);
    expect(schedulerConfig.warnings.some((w) => w.includes("max_concurrent_agents"))).toBe(false);

    await runSchedulerLoop(
      baseLoopOptions({ controller, schedulerOnce: tick.fn, sleep, schedulerConfig, log: (m) => logs.push(m) }),
    );

    const startup = logs.find((l) => l.includes("SCHEDULER LOOP")) ?? "";
    expect(startup).toContain("poll_interval_seconds");
  });
});

// ---------------------------------------------------------------------------
// Controller and real-sleep seams
// ---------------------------------------------------------------------------

describe("createSchedulerLoopController", () => {
  it("is not shutdownRequested initially and resolves onceShutdown after requestShutdown", async () => {
    const controller = createSchedulerLoopController();
    expect(controller.shutdownRequested).toBe(false);
    expect(controller.shutdownReason).toBeUndefined();

    let resolved = false;
    const p = controller.onceShutdown().then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    controller.requestShutdown("SIGINT");
    await p;
    expect(resolved).toBe(true);
    expect(controller.shutdownRequested).toBe(true);
    expect(controller.shutdownReason).toBe("SIGINT");
  });

  it("requestShutdown is idempotent (second call does not re-resolve or change reason)", async () => {
    const controller = createSchedulerLoopController();
    controller.requestShutdown("SIGTERM");
    const firstReason = controller.shutdownReason;
    controller.requestShutdown("SIGINT");
    expect(controller.shutdownReason).toBe(firstReason);
  });

  it("onceShutdown returns the same promise instance across calls", () => {
    const controller = createSchedulerLoopController();
    expect(controller.onceShutdown()).toBe(controller.onceShutdown());
  });
});

describe("createRealSchedulerLoopSleep", () => {
  it("cancel() clears the pending timer so no dangling timer keeps the process alive", async () => {
    const sleep = createRealSchedulerLoopSleep();
    let resolved = false;
    const p = sleep.wait(60_000).then(() => {
      resolved = true;
    });
    // Cancel before the 60s timer fires.
    sleep.cancel();
    await p;
    expect(resolved).toBe(true);
    // After cancel, a fresh wait works normally (state was reset).
    let second = false;
    const p2 = sleep.wait(0).then(() => {
      second = true;
    });
    await p2;
    expect(second).toBe(true);
  });
});
