import type { ResolvedSchedulerAgentScope, ResolvedSchedulerAutomation, SchedulerLegacyMasterGateState } from "./scheduler-loop.js";
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
/**
 * Format the existing resolved scheduler policy without exposing configured
 * allow/exclude names. This is presentation only: no I/O, mutation, planning,
 * or execution occurs here.
 */
export declare function formatSchedulerEffectivePolicy(policy: SchedulerEffectivePolicy): string[];
