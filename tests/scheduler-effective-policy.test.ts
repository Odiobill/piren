import { describe, expect, it } from "vitest";
import { formatSchedulerEffectivePolicy } from "../src/scheduler-effective-policy.js";

describe("formatSchedulerEffectivePolicy", () => {
  it("renders resolved class states, count-only scopes, and existing warnings without local config names", () => {
    const output = formatSchedulerEffectivePolicy({
      automation: { inboxTasks: true, agentCron: false, scriptCron: true },
      legacyMasterGate: "ignored",
      agentScope: { inboxTasks: ["thor"], scriptCron: [] },
      warnings: [
        "scheduler.agent_scope.inbox_tasks.allow contains 1 name(s) that are not locally enabled agents; they are ignored and never widen eligibility.",
      ],
    });

    expect(output).toEqual([
      "automation: inbox_tasks=on agent_cron=off script_cron=on",
      "legacy: retired scheduler.enabled key present with value true; inert-to-ignore (read-only notice, not persisted)",
      "agent scope: inbox_tasks=1 agent(s) agent_cron=all script_cron=0 agent(s)",
      "config warnings:",
      "  - scheduler.agent_scope.inbox_tasks.allow contains 1 name(s) that are not locally enabled agents; they are ignored and never widen eligibility.",
    ]);
    expect(output.join("\n")).not.toContain("thor");
  });

  it("keeps the existing fail-closed legacy-gate wording and preserves resolver warning order", () => {
    const output = formatSchedulerEffectivePolicy({
      automation: { inboxTasks: false, agentCron: false, scriptCron: false },
      legacyMasterGate: "gated",
      agentScope: { inboxTasks: [], agentCron: [], scriptCron: [] },
      warnings: ["first warning", "second warning"],
    });

    expect(output).toEqual([
      "automation: inbox_tasks=off agent_cron=off script_cron=off",
      "legacy gate: retired scheduler.enabled key present with a disabled/malformed value; all automation classes resolve disabled (fail closed); operator-confirmed migration required (read-only notice, not persisted)",
      "agent scope: inbox_tasks=0 agent(s) agent_cron=0 agent(s) script_cron=0 agent(s)",
      "config warnings:",
      "  - first warning",
      "  - second warning",
    ]);
  });
});
