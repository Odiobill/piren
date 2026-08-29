import { describe, expect, it } from "vitest";
import type { LocalPirenConfig, SchedulerAgentScopeLocalConfig, SchedulerClassAgentScopeLocalConfig } from "../src/bootstrap.js";
import type {
  SchedulerOnceOptions,
  SchedulerOnceResult,
  SchedulerOnceExecutors,
} from "../src/scheduler-once.js";
import {
  createSchedulerLoopController,
  createRealSchedulerLoopSleep,
  resolveAutomationClasses,
  resolveSchedulerConfig,
  runSchedulerLoop,
  type SchedulerLoopController,
  type SchedulerLoopOptions,
  type SchedulerLoopSleep,
} from "../src/scheduler-loop.js";

// ---------------------------------------------------------------------------
// resolveSchedulerConfig: pure local scheduler config resolver
// ---------------------------------------------------------------------------
// (0.2.0 S1: `enabled` + closed `automation` classes are resolved in the
// describes below; the pre-S1 defaults/fallback behavior is unchanged.)

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

  it("never echoes a malformed interval value in a warning", () => {
    const secret = "scheduler-secret-must-not-appear";
    const resolved = resolveSchedulerConfig({
      scheduler: { poll_interval_seconds: secret as unknown as number },
    });
    expect(resolved.warnings.join("\n")).not.toContain(secret);
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
// 0.2.0 S1: enabled master gate + closed automation classes (pure resolver)
// ---------------------------------------------------------------------------
// Binding contract (0.2.0 scope amendment §2 + S1 task):
//   - fresh / no scheduler config -> enabled:false, all classes false;
//   - present-but-malformed booleans fail closed with deterministic warnings;
//   - a legacy established scheduler block lacking `enabled` resolves effective
//     enabled=true (upgrade intent preserved) with a PURE migration signal;
//   - missing automation / classes remain false (fail closed).

describe("resolveSchedulerConfig: enabled master gate (0.2.0 S1)", () => {
  it("fresh config with no scheduler block resolves enabled=false and all automation classes false, with no warnings", () => {
    const resolved = resolveSchedulerConfig({});
    expect(resolved.enabled).toBe(false);
    expect(resolved.automation).toEqual({
      inboxTasks: false,
      agentCron: false,
      scriptCron: false,
    });
    expect(resolved.migration).toBeUndefined();
    expect(resolved.warnings).toEqual([]);
  });

  it("an empty scheduler block is fresh/no config: enabled=false, no migration, no warnings", () => {
    const resolved = resolveSchedulerConfig({ scheduler: {} });
    expect(resolved.enabled).toBe(false);
    expect(resolved.migration).toBeUndefined();
    expect(resolved.warnings).toEqual([]);
  });

  it("an explicit boolean enabled is honored verbatim", () => {
    expect(resolveSchedulerConfig({ scheduler: { enabled: true } }).enabled).toBe(true);
    expect(resolveSchedulerConfig({ scheduler: { enabled: false } }).enabled).toBe(false);
  });

  it("a legacy scheduler block without enabled resolves enabled=true with a migration signal (upgrade intent preserved)", () => {
    const resolved = resolveSchedulerConfig({ scheduler: { poll_interval_seconds: 15 } });
    expect(resolved.enabled).toBe(true);
    expect(resolved.migration).toBeDefined();
    expect(resolved.migration?.materializeEnabled).toBe(true);
    expect(resolved.migration?.value).toBe(true);
    expect(resolved.migration?.reason).toBe("legacy-scheduler-block-without-enabled");
    expect(resolved.migration?.note).toContain("poll_interval_seconds");
    expect(resolved.warnings).toEqual([]);
  });

  it("any established legacy key (stale/max_concurrent/device_id) triggers the migration signal", () => {
    for (const legacy of [
      { stale_after_seconds: 120 },
      { max_concurrent_agents: 2 },
      { device_id: "thor" },
    ]) {
      const resolved = resolveSchedulerConfig({ scheduler: legacy });
      expect(resolved.enabled).toBe(true);
      expect(resolved.migration?.materializeEnabled).toBe(true);
    }
  });

  it("an explicit enabled on a legacy block wins for the compat field and carries the legacy-gate state", () => {
    const resolved = resolveSchedulerConfig({
      scheduler: { poll_interval_seconds: 15, enabled: false },
    });
    expect(resolved.enabled).toBe(false);
    expect(resolved.migration).toBeUndefined();
    // SGC-1: enabled:false is an ambiguous legacy gate — all classes fail
    // closed with a deterministic warning (never silently re-enabled).
    expect(resolved.legacyMasterGate).toBe("gated");
    expect(resolved.automation).toEqual({ inboxTasks: false, agentCron: false, scriptCron: false });
    expect(resolved.warnings.some((w) => w.includes("legacy gate"))).toBe(true);
  });

  it("a present-but-malformed enabled fails closed to false with a deterministic warning", () => {
    for (const bad of ["true", 1, ["yes"], { on: true }]) {
      const resolved = resolveSchedulerConfig({
        scheduler: { enabled: bad as unknown as boolean },
      });
      expect(resolved.enabled).toBe(false);
      expect(resolved.migration).toBeUndefined();
      expect(resolved.warnings.some((w) => w.includes("scheduler.enabled"))).toBe(true);
    }
  });

  it("never echoes a malformed enabled value in a warning", () => {
    const secret = "scheduler-secret-must-not-appear";
    const resolved = resolveSchedulerConfig({
      scheduler: { enabled: secret as unknown as boolean },
    });
    expect(resolved.warnings.join("\n")).not.toContain(secret);
  });

  it("an unknown-key-only scheduler block is not established legacy: enabled=false without a migration signal", () => {
    const resolved = resolveSchedulerConfig({
      scheduler: { mystery: 1 },
    } as unknown as LocalPirenConfig);
    expect(resolved.enabled).toBe(false);
    expect(resolved.migration).toBeUndefined();
    expect(resolved.warnings).toEqual([]);
  });

  it("enabled: null is a PRESENT malformed retired value (SGC-3 correction): gated fail-closed with a bounded warning", () => {
    // `enabled:` with an empty YAML value parses to null (verified against the
    // `yaml` library). A present-but-empty key is NOT absent: it gates.
    const legacyNull = resolveSchedulerConfig({
      scheduler: { poll_interval_seconds: 30, automation: { inbox_tasks: true }, enabled: null as unknown as boolean },
    });
    expect(legacyNull.legacyMasterGate).toBe("gated");
    expect(legacyNull.enabled).toBe(false);
    expect(legacyNull.migration).toBeUndefined();
    // Declared classes are gated off fail-closed.
    expect(legacyNull.automation).toEqual({ inboxTasks: false, agentCron: false, scriptCron: false });
    expect(legacyNull.warnings).toHaveLength(1);
    expect(legacyNull.warnings[0]).toContain("scheduler.enabled");
    expect(legacyNull.warnings[0]).toContain("--force never bypasses");

    const freshNull = resolveSchedulerConfig({
      scheduler: { enabled: null as unknown as boolean },
    });
    expect(freshNull.legacyMasterGate).toBe("gated");
    expect(freshNull.automation).toEqual({ inboxTasks: false, agentCron: false, scriptCron: false });
  });

  it("an actually absent enabled key stays legacyMasterGate absent (no gating, no warning)", () => {
    const resolved = resolveSchedulerConfig({ scheduler: { poll_interval_seconds: 30 } });
    expect(resolved.legacyMasterGate).toBe("absent");
    expect(resolved.warnings.filter((w) => w.includes("scheduler.enabled"))).toEqual([]);
  });
});

describe("resolveSchedulerConfig: retired master gate and legacy shapes (SGC-1)", () => {
  it("legacyMasterGate is absent when no scheduler.enabled key exists and classes resolve independently", () => {
    const resolved = resolveSchedulerConfig({
      scheduler: { automation: { inbox_tasks: true, agent_cron: true } },
    });
    expect(resolved.legacyMasterGate).toBe("absent");
    expect(resolved.automation).toEqual({ inboxTasks: true, agentCron: true, scriptCron: false });
    expect(resolved.warnings).toEqual([]);
  });

  it("explicit enabled:true is inert-to-ignore: never adds execution, classes are the sole gates", () => {
    const resolved = resolveSchedulerConfig({
      scheduler: { enabled: true, automation: { inbox_tasks: true } },
    });
    expect(resolved.legacyMasterGate).toBe("ignored");
    expect(resolved.automation).toEqual({ inboxTasks: true, agentCron: false, scriptCron: false });
    // Bounded legacy notice; the retired key alone never enables anything.
    expect(resolved.warnings.some((w) => w.includes("inert-to-ignore"))).toBe(true);
  });

  it("enabled:true with no automation classes never enables anything", () => {
    const resolved = resolveSchedulerConfig({ scheduler: { enabled: true } });
    expect(resolved.legacyMasterGate).toBe("ignored");
    expect(resolved.automation).toEqual({ inboxTasks: false, agentCron: false, scriptCron: false });
  });

  it("enabled:false is an ambiguous legacy gate: ALL classes resolve disabled (fail closed)", () => {
    const resolved = resolveSchedulerConfig({
      scheduler: { enabled: false, automation: { inbox_tasks: true, agent_cron: true, script_cron: true } },
    });
    expect(resolved.legacyMasterGate).toBe("gated");
    expect(resolved.automation).toEqual({ inboxTasks: false, agentCron: false, scriptCron: false });
    expect(resolved.warnings.some((w) => w.includes("legacy gate"))).toBe(true);
  });

  it("a malformed enabled value is also a legacy gate: all classes disabled, no value echo", () => {
    const secret = "scheduler-secret-must-not-appear";
    const resolved = resolveSchedulerConfig({
      scheduler: { enabled: secret as unknown as boolean, automation: { inbox_tasks: true } },
    });
    expect(resolved.legacyMasterGate).toBe("gated");
    expect(resolved.automation).toEqual({ inboxTasks: false, agentCron: false, scriptCron: false });
    expect(resolved.warnings.join("\n")).not.toContain(secret);
  });
});

describe("resolveAutomationClasses: closed class resolution (0.2.0 S1)", () => {
  it("absent automation resolves all classes false without warnings", () => {
    const result = resolveAutomationClasses(undefined);
    expect(result.classes).toEqual({ inboxTasks: false, agentCron: false, scriptCron: false });
    expect(result.warnings).toEqual([]);
  });

  it("null automation (bare `automation:`) resolves all classes false without warnings", () => {
    const result = resolveAutomationClasses(null);
    expect(result.classes).toEqual({ inboxTasks: false, agentCron: false, scriptCron: false });
    expect(result.warnings).toEqual([]);
  });

  it("a non-mapping automation container fails closed: all classes false with one deterministic warning", () => {
    for (const bad of ["yes", 1, true, ["inbox_tasks"]]) {
      const result = resolveAutomationClasses(bad);
      expect(result.classes).toEqual({ inboxTasks: false, agentCron: false, scriptCron: false });
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toContain("scheduler.automation");
    }
  });

  it("explicit boolean class values are honored", () => {
    const result = resolveAutomationClasses({ inbox_tasks: true, agent_cron: true, script_cron: true });
    expect(result.classes).toEqual({ inboxTasks: true, agentCron: true, scriptCron: true });
    expect(result.warnings).toEqual([]);
  });

  it("a partial automation block fails closed for the missing classes", () => {
    const result = resolveAutomationClasses({ inbox_tasks: true });
    expect(result.classes).toEqual({ inboxTasks: true, agentCron: false, scriptCron: false });
    expect(result.warnings).toEqual([]);
  });

  it("a malformed class value disables that class with a deterministic warning naming it", () => {
    const result = resolveAutomationClasses({ inbox_tasks: "yes", agent_cron: 1, script_cron: true });
    expect(result.classes).toEqual({ inboxTasks: false, agentCron: false, scriptCron: true });
    expect(result.warnings.some((w) => w.includes("inbox_tasks"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("agent_cron"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("script_cron"))).toBe(false);
  });

  it("null class values are absent-like (fail closed, no warning)", () => {
    const result = resolveAutomationClasses({ inbox_tasks: null });
    expect(result.classes).toEqual({ inboxTasks: false, agentCron: false, scriptCron: false });
    expect(result.warnings).toEqual([]);
  });

  it("unknown automation keys are reported-and-ignored without echoing key or value", () => {
    const secret = "scheduler-secret-must-not-appear";
    const result = resolveAutomationClasses({
      inbox_tasks: secret,
      [secret]: secret,
    });
    expect(result.classes).toEqual({ inboxTasks: false, agentCron: false, scriptCron: false });
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.join("\n")).not.toContain(secret);
  });
});

describe("resolveSchedulerConfig: agent_scope class agent policy (S1a)", () => {
  it("absent agent_scope leaves every class un-narrowed with no warnings", () => {
    const resolved = resolveSchedulerConfig({ scheduler: { automation: { inbox_tasks: true } } });
    expect(resolved.agentScope).toEqual({});
    expect(resolved.warnings).toEqual([]);
  });

  it("allow-only narrows that class to runnable agents and never widens the runnable set", () => {
    const resolved = resolveSchedulerConfig({
      allowed_agents: ["thor", "sam"],
      scheduler: {
        automation: { inbox_tasks: true },
        agent_scope: { inbox_tasks: { allow: ["thor", "ghost"] } },
      },
    });
    expect(resolved.agentScope?.inboxTasks).toEqual(["thor"]);
    expect(resolved.agentScope?.agentCron).toBeUndefined();
    expect(resolved.agentScope?.scriptCron).toBeUndefined();
  });

  it("exclude-only narrows that class to runnable agents minus the excluded names", () => {
    const resolved = resolveSchedulerConfig({
      allowed_agents: ["thor", "sam", "zai"],
      scheduler: { agent_scope: { inbox_tasks: { exclude: ["sam"] } } },
    });
    expect(resolved.agentScope?.inboxTasks).toEqual(["thor", "zai"]);
  });

  it("overlap resolves with exclusion winning over allow", () => {
    const resolved = resolveSchedulerConfig({
      allowed_agents: ["thor", "sam"],
      scheduler: { agent_scope: { inbox_tasks: { allow: ["thor", "sam"], exclude: ["sam"] } } },
    });
    expect(resolved.agentScope?.inboxTasks).toEqual(["thor"]);
  });

  it("a present empty allow list deliberately allows none for that class", () => {
    const resolved = resolveSchedulerConfig({
      allowed_agents: ["thor"],
      scheduler: { agent_scope: { inbox_tasks: { allow: [] } } },
    });
    expect(resolved.agentScope?.inboxTasks).toEqual([]);
  });

  it("a malformed top-level agent_scope fails closed for every class with a bounded warning", () => {
    const resolved = resolveSchedulerConfig({
      allowed_agents: ["thor"],
      scheduler: {
        agent_scope: "everything" as unknown as SchedulerAgentScopeLocalConfig,
      },
    });
    expect(resolved.agentScope).toEqual({ inboxTasks: [], agentCron: [], scriptCron: [] });
    expect(resolved.warnings.some((w) => w.includes("scheduler.agent_scope") && w.includes("fail closed"))).toBe(true);
    expect(resolved.warnings.join("\n")).not.toContain("everything");
  });

  it("a malformed class scope fails closed only for the affected class", () => {
    const resolved = resolveSchedulerConfig({
      allowed_agents: ["thor"],
      scheduler: {
        agent_scope: {
          inbox_tasks: ["thor"] as unknown as SchedulerClassAgentScopeLocalConfig,
          script_cron: { exclude: ["thor"] },
        },
      },
    });
    expect(resolved.agentScope?.inboxTasks).toEqual([]);
    expect(resolved.agentScope?.agentCron).toBeUndefined();
    expect(resolved.agentScope?.scriptCron).toEqual([]);
    expect(resolved.warnings.some((w) => w.includes("scheduler.agent_scope.inbox_tasks"))).toBe(true);
  });

  it("a malformed allow/exclude list fails closed for the affected class", () => {
    const resolved = resolveSchedulerConfig({
      allowed_agents: ["thor", "sam"],
      scheduler: {
        agent_scope: {
          inbox_tasks: { allow: "thor" as unknown as string[] },
          script_cron: { exclude: [42 as unknown as string] },
        },
      },
    });
    expect(resolved.agentScope?.inboxTasks).toEqual([]);
    expect(resolved.agentScope?.scriptCron).toEqual([]);
    expect(resolved.agentScope?.agentCron).toBeUndefined();
    expect(resolved.warnings.some((w) => w.includes("scheduler.agent_scope.inbox_tasks.allow"))).toBe(true);
    expect(resolved.warnings.some((w) => w.includes("scheduler.agent_scope.script_cron.exclude"))).toBe(true);
  });

  it("unknown class keys are warned-and-ignored", () => {
    const resolved = resolveSchedulerConfig({
      allowed_agents: ["thor"],
      scheduler: {
        agent_scope: {
          inbox_tasks: { exclude: ["thor"] },
          everything_else: {},
        } as unknown as SchedulerAgentScopeLocalConfig,
      },
    });
    expect(resolved.agentScope?.inboxTasks).toEqual([]);
    expect(resolved.warnings.some((w) => w.includes("scheduler.agent_scope contains 1 unrecognized class key"))).toBe(true);
  });

  it("unknown/non-runnable configured names warn deterministically and never widen the candidate set", () => {
    const resolved = resolveSchedulerConfig({
      allowed_agents: ["thor"],
      scheduler: { agent_scope: { inbox_tasks: { allow: ["thor", "ghost"], exclude: ["phantom"] } } },
    });
    expect(resolved.agentScope?.inboxTasks).toEqual(["thor"]);
    expect(resolved.warnings.some((w) => w.includes("scheduler.agent_scope.inbox_tasks.allow") && w.includes("not locally enabled"))).toBe(true);
    expect(resolved.warnings.some((w) => w.includes("scheduler.agent_scope.inbox_tasks.exclude") && w.includes("not locally enabled"))).toBe(true);
    expect(resolved.warnings.join("\n")).not.toContain("ghost");
    expect(resolved.warnings.join("\n")).not.toContain("phantom");
  });

  it("an empty class scope record is absent-like: no narrowing for that class", () => {
    const resolved = resolveSchedulerConfig({
      allowed_agents: ["thor"],
      scheduler: { agent_scope: { agent_cron: {} } },
    });
    expect(resolved.agentScope).toEqual({});
    expect(resolved.warnings).toEqual([]);
  });

  it("a class excluded by scope plus a legacy gated master key stays fail closed on both layers", () => {
    const resolved = resolveSchedulerConfig({
      allowed_agents: ["thor", "sam"],
      scheduler: {
        enabled: false,
        automation: { inbox_tasks: true },
        agent_scope: { inbox_tasks: { exclude: ["sam"] } },
      },
    });
    expect(resolved.legacyMasterGate).toBe("gated");
    expect(resolved.automation).toEqual({ inboxTasks: false, agentCron: false, scriptCron: false });
    expect(resolved.agentScope?.inboxTasks).toEqual(["thor"]);
  });
});

describe("resolveSchedulerConfig: automation integration (0.2.0 S1)", () => {
  it("automation values flow through the config resolver and its warnings merge into config warnings", () => {
    const resolved = resolveSchedulerConfig({
      scheduler: {
        automation: { inbox_tasks: true, agent_cron: false, script_cron: "yes" as unknown as boolean },
      },
    });
    expect(resolved.enabled).toBe(false);
    expect(resolved.automation).toEqual({ inboxTasks: true, agentCron: false, scriptCron: false });
    expect(resolved.warnings.some((w) => w.includes("script_cron"))).toBe(true);
  });

  it("a legacy block with explicit automation keeps upgrade intent (enabled true via migration) while classes stay opt-in", () => {
    const resolved = resolveSchedulerConfig({
      scheduler: { poll_interval_seconds: 30, automation: { inbox_tasks: true } },
    });
    expect(resolved.enabled).toBe(true);
    expect(resolved.migration?.materializeEnabled).toBe(true);
    expect(resolved.automation).toEqual({ inboxTasks: true, agentCron: false, scriptCron: false });
  });

  it("existing interval/stale/concurrency/device resolution is unchanged alongside the new gates", () => {
    const resolved = resolveSchedulerConfig({
      scheduler: {
        poll_interval_seconds: 15,
        stale_after_seconds: 120,
        max_concurrent_agents: 2,
        device_id: "thor",
        enabled: true,
        automation: { inbox_tasks: true },
      },
    });
    expect(resolved.pollIntervalSeconds).toBe(15);
    expect(resolved.staleAfterSeconds).toBe(120);
    expect(resolved.maxConcurrentAgents).toBe(2);
    expect(resolved.deviceId).toBe("thor");
    expect(resolved.enabled).toBe(true);
    expect(resolved.automation.inboxTasks).toBe(true);
    expect(resolved.automation.agentCron).toBe(false);
    expect(resolved.automation.scriptCron).toBe(false);
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
    // 0.2 Settings contract §4.3: no retired `scheduler.enabled` key (so the
    // legacy notices stay absent) and every automation class enabled, so the
    // default fixture keeps exercising tick cadence unchanged.
    schedulerConfig: resolveSchedulerConfig({
      scheduler: {
        automation: { inbox_tasks: true, agent_cron: true, script_cron: true },
      },
    }),
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
    const schedulerConfig = resolveSchedulerConfig({ scheduler: { enabled: true } }); // no device_id

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

describe("runSchedulerLoop: automation gates and startup summary (SGC-1/2)", () => {
  it("runs as inert supervision when legacy-gated (enabled:false): ticks run, no heartbeat/planning/claim/spawn", async () => {
    const controller = createSchedulerLoopController();
    const logs: string[] = [];
    const { sleep, waits } = immediateSleep();
    const tick = fakeTick({ controller, shutdownAfter: 2 });
    const schedulerConfig = resolveSchedulerConfig({
      scheduler: { enabled: false, automation: { inbox_tasks: true, agent_cron: true, script_cron: true } },
    });

    const result = await runSchedulerLoop(
      baseLoopOptions({
        controller,
        schedulerConfig,
        sleep,
        schedulerOnce: tick.fn,
        log: (m) => logs.push(m),
      }),
    );

    // The loop is supervision only: it keeps ticking (no master-gate exit).
    expect(tick.calls).toHaveLength(2);
    expect(waits).toHaveLength(1);
    expect(result.tickCount).toBe(2);
    expect(result.executedCount).toBe(0);
    const output = logs.join("\n");
    // Bounded and non-secret inert-supervision + legacy-gate notices.
    expect(output).toMatch(/no enabled automation classes/i);
    expect(output).toMatch(/legacy gate/i);
    expect(output).not.toContain("scheduler disabled");
  });

  it("runs as inert supervision for a fresh install with no scheduler block (fail-closed default)", async () => {
    const controller = createSchedulerLoopController();
    const logs: string[] = [];
    const tick = fakeTick({ controller, shutdownAfter: 2 });

    const result = await runSchedulerLoop(
      baseLoopOptions({
        controller,
        schedulerConfig: resolveSchedulerConfig({}),
        schedulerOnce: tick.fn,
        log: (m) => logs.push(m),
      }),
    );

    expect(tick.calls).toHaveLength(2);
    expect(result.tickCount).toBe(2);
    expect(logs.join("\n")).toMatch(/no enabled automation classes/i);
    expect(logs.join("\n")).not.toMatch(/legacy/i);
  });

  it("startup summary lists the resolved automation classes (bounded, non-secret)", async () => {
    const controller = createSchedulerLoopController();
    const logs: string[] = [];
    const schedulerConfig = resolveSchedulerConfig({
      scheduler: { enabled: true, automation: { inbox_tasks: true, agent_cron: false, script_cron: true } },
    });

    await runSchedulerLoop(
      baseLoopOptions({
        controller,
        schedulerConfig,
        schedulerOnce: fakeTick({ controller, shutdownAfter: 1 }).fn,
        log: (m) => logs.push(m),
      }),
    );

    const startup = logs[0] ?? "";
    expect(startup).toContain("automation: inbox_tasks=on agent_cron=off script_cron=on");
  });

  it("startup summary surfaces the bounded agent-scope policy line (S1a)", async () => {
    const controller = createSchedulerLoopController();
    const logs: string[] = [];
    const schedulerConfig = resolveSchedulerConfig({
      allowed_agents: ["thor", "sam"],
      scheduler: {
        automation: { inbox_tasks: true },
        agent_scope: { inbox_tasks: { allow: ["thor"] } },
      },
    });

    await runSchedulerLoop(
      baseLoopOptions({
        controller,
        schedulerConfig,
        schedulerOnce: fakeTick({ controller, shutdownAfter: 1 }).fn,
        log: (m) => logs.push(m),
      }),
    );

    const startup = logs[0] ?? "";
    expect(startup).toContain("agent scope: inbox_tasks=1 agent(s) agent_cron=all script_cron=all");
  });

  it("startup summary surfaces the legacy-gate notice for a gated config (read-only, never persisted)", async () => {
    const controller = createSchedulerLoopController();
    const logs: string[] = [];
    // Legacy ambiguous gate: `enabled: false` with enabled automation classes.
    const schedulerConfig = resolveSchedulerConfig({
      scheduler: { enabled: false, automation: { inbox_tasks: true } },
    });
    expect(schedulerConfig.legacyMasterGate).toBe("gated");

    await runSchedulerLoop(
      baseLoopOptions({
        controller,
        schedulerConfig,
        schedulerOnce: fakeTick({ controller, shutdownAfter: 1 }).fn,
        log: (m) => logs.push(m),
      }),
    );

    const startup = logs[0] ?? "";
    expect(startup).toMatch(/legacy gate: .*fail closed/i);
    expect(startup).toMatch(/not persisted/i);
  });

  it("startup summary omits legacy notices when no retired scheduler.enabled key is present", async () => {
    const controller = createSchedulerLoopController();
    const logs: string[] = [];

    await runSchedulerLoop(
      baseLoopOptions({
        controller,
        schedulerOnce: fakeTick({ controller, shutdownAfter: 1 }).fn,
        log: (m) => logs.push(m),
      }),
    );

    expect(logs[0] ?? "").not.toMatch(/legacy:|legacy gate:/i);
  });
});
