import type {
  ResolvedSchedulerAgentScope,
  ResolvedSchedulerAutomation,
  SchedulerLegacyMasterGateState,
} from "./scheduler-loop.js";

/**
 * Bounded, read-only presentation input from the existing scheduler resolver.
 * It contains resolved facts only: callers must not pass raw local config or
 * independently derive candidate eligibility.
 */
export interface SchedulerEffectivePolicy {
  automation: ResolvedSchedulerAutomation;
  legacyMasterGate: SchedulerLegacyMasterGateState;
  agentScope: ResolvedSchedulerAgentScope;
  warnings: readonly string[];
}

function scopePart(label: string, agents: string[] | undefined): string {
  return agents === undefined ? `${label}=all` : `${label}=${agents.length} agent(s)`;
}

/**
 * Format the existing resolved scheduler policy without exposing configured
 * allow/exclude names. This is presentation only: no I/O, mutation, planning,
 * or execution occurs here.
 */
export function formatSchedulerEffectivePolicy(policy: SchedulerEffectivePolicy): string[] {
  const onOff = (value: boolean): string => (value ? "on" : "off");
  const lines = [
    `automation: inbox_tasks=${onOff(policy.automation.inboxTasks)} ` +
      `agent_cron=${onOff(policy.automation.agentCron)} ` +
      `script_cron=${onOff(policy.automation.scriptCron)}`,
  ];

  if (policy.legacyMasterGate === "gated") {
    lines.push(
      "legacy gate: retired scheduler.enabled key present with a disabled/malformed value; " +
        "all automation classes resolve disabled (fail closed); operator-confirmed migration required " +
        "(read-only notice, not persisted)",
    );
  } else if (policy.legacyMasterGate === "ignored") {
    lines.push("legacy: retired scheduler.enabled key present with value true; inert-to-ignore (read-only notice, not persisted)");
  }

  lines.push(
    `agent scope: ${scopePart("inbox_tasks", policy.agentScope.inboxTasks)} ` +
      `${scopePart("agent_cron", policy.agentScope.agentCron)} ` +
      `${scopePart("script_cron", policy.agentScope.scriptCron)}`,
  );
  if (policy.warnings.length > 0) {
    lines.push("config warnings:");
    for (const warning of policy.warnings) lines.push(`  - ${warning}`);
  }
  return lines;
}
