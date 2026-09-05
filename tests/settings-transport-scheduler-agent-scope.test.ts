import { describe, expect, it } from "vitest";
import { buildSchedulerSettingsEnvelope, parseSchedulerSettingsRead } from "../web/src/settings-transport.js";

/**
 * 0.2.5 S7 — web typed transport for the Scheduler class agent-scope
 * Settings controls. The scheduler read result gains the gateway-authoritative
 * runnable roster, each class's effective selected runnable set (null =
 * unrestricted, [] = none), and bounded resolver warnings; all fail-closed.
 * The write envelope carries the closed per-class agentScope intent.
 */

const AVAILABLE = {
  available: true,
  scheduler: {
    present: true,
    legacyMasterGate: "absent",
    automation: { inboxTasks: true, agentCron: false, scriptCron: false },
    deviceIdConfigured: false,
    pollIntervalSeconds: null,
    staleAfterSeconds: null,
    maxConcurrentAgents: null,
    deviceId: null,
    agentScope: { inboxTasks: ["kimi"], agentCron: null, scriptCron: [] },
  },
  runnableAgents: ["kimi", "dipu"],
  agentScopeWarnings: [],
};

describe("parseSchedulerSettingsRead: agent scope (S7)", () => {
  it("parses the roster, effective per-class sets, and warnings", () => {
    const read = parseSchedulerSettingsRead(AVAILABLE);
    expect(read).toEqual({
      available: true,
      value: {
        present: true,
        legacyMasterGate: "absent",
        automation: { inboxTasks: true, agentCron: false, scriptCron: false },
        deviceIdConfigured: false,
        pollIntervalSeconds: null,
        staleAfterSeconds: null,
        maxConcurrentAgents: null,
        deviceId: null,
        agentScope: { inboxTasks: ["kimi"], agentCron: null, scriptCron: [] },
      },
      runnableAgents: ["kimi", "dipu"],
      agentScopeWarnings: [],
    });
  });

  it("fails closed when the roster, warnings, or effective sets are missing or malformed", () => {
    for (const broken of [
      // Missing roster / warnings entirely.
      { ...AVAILABLE, runnableAgents: undefined },
      { ...AVAILABLE, agentScopeWarnings: undefined },
      // Non-string roster entry.
      { ...AVAILABLE, runnableAgents: ["kimi", 42] },
      // Non-string warning entry.
      { ...AVAILABLE, agentScopeWarnings: [42] },
      // Missing agentScope block.
      { ...AVAILABLE, scheduler: { ...AVAILABLE.scheduler, agentScope: undefined } },
      // Class value neither null nor a string array.
      { ...AVAILABLE, scheduler: { ...AVAILABLE.scheduler, agentScope: { ...AVAILABLE.scheduler.agentScope, agentCron: 42 } } },
      // Blank or non-string entries in an effective set.
      { ...AVAILABLE, scheduler: { ...AVAILABLE.scheduler, agentScope: { ...AVAILABLE.scheduler.agentScope, inboxTasks: ["kimi", ""] } } },
      { ...AVAILABLE, scheduler: { ...AVAILABLE.scheduler, agentScope: { ...AVAILABLE.scheduler.agentScope, inboxTasks: ["kimi", null] } } },
    ]) {
      expect(() => parseSchedulerSettingsRead(broken), JSON.stringify(broken)).toThrow();
    }
  });
});

describe("buildSchedulerSettingsEnvelope: agentScope intent (S7)", () => {
  it("carries the closed per-class agentScope block (arrays, empty array, and null)", () => {
    expect(
      buildSchedulerSettingsEnvelope({
        agentScope: { inbox_tasks: ["kimi", "dipu"], agent_cron: [], script_cron: null },
      }),
    ).toEqual({
      surface: "local",
      family: "scheduler",
      block: { agentScope: { inbox_tasks: ["kimi", "dipu"], agent_cron: [], script_cron: null } },
    });
  });
});
