import type { LocalPirenConfig } from "./bootstrap.js";
import type { SchedulerOnceOptions, SchedulerOnceResult, SchedulerOnceExecutors } from "./scheduler-once.js";
/** Effective concurrency supported by S5. S4 is one-at-a-time; S5 is honest. */
export declare const SCHEDULER_EFFECTIVE_CONCURRENCY: 1;
/**
 * Closed automation-class model: exactly these three classes exist. No
 * per-task/per-cron/per-agent allowlists or expressions.
 */
export declare const SCHEDULER_AUTOMATION_CLASSES: readonly ["inbox_tasks", "agent_cron", "script_cron"];
export type SchedulerAutomationClass = (typeof SCHEDULER_AUTOMATION_CLASSES)[number];
/** Resolved closed automation classes. Each is false unless explicitly true. */
export interface ResolvedSchedulerAutomation {
    /** Claim + execute pending inbox tasks (most consequential class). */
    inboxTasks: boolean;
    /** Claim + execute due agent-mode cron jobs. */
    agentCron: boolean;
    /** Execute due script-mode cron jobs directly. */
    scriptCron: boolean;
}
/** Result of `resolveAutomationClasses`: resolved classes plus warnings. */
export interface ResolveAutomationClassesResult {
    classes: ResolvedSchedulerAutomation;
    warnings: string[];
}
/**
 * Pure, inspectable migration signal (0.2.0 S1). Present on the resolved
 * config exactly when an established legacy `scheduler:` block lacks the new
 * `enabled` key: the block resolved effective enabled=true to preserve
 * established upgrade intent. S1 is resolver-only: nothing writes a file. A
 * later separately gated writer/wizard tracer may consume this signal to
 * atomically persist `scheduler.enabled: true`.
 */
export interface SchedulerMigrationSignal {
    /** Always true when present: the migration materializes enabled=true. */
    readonly materializeEnabled: true;
    /** Exact value a writer/wizard would persist for `scheduler.enabled`. */
    readonly value: true;
    /** Deterministic machine-readable reason code. */
    readonly reason: "legacy-scheduler-block-without-enabled";
    /** Deterministic, non-secret operator note. */
    readonly note: string;
}
/**
 * Pure fail-closed resolver for the closed `scheduler.automation` block
 * (0.2.0 scope amendment §2). Takes the raw `automation` value (which may be
 * anything the YAML loader produced) and returns the three resolved classes
 * plus deterministic warnings. No I/O.
 *
 * - Absent/null container or class -> that class disabled, no warning.
 * - Non-mapping container -> all three classes disabled + one warning.
 * - Non-boolean class value -> that class disabled + a warning naming it.
 * - Unknown keys are reported-and-ignored (never assigned semantics),
 *   mirroring the manifest tolerance convention.
 */
export declare function resolveAutomationClasses(automation: unknown): ResolveAutomationClassesResult;
/**
 * Resolved local scheduler config with conservative defaults and deterministic
 * fallbacks for invalid input. `warnings` records every field that fell back so
 * the loop can report them to the operator.
 */
export interface ResolvedSchedulerConfig {
    pollIntervalSeconds: number;
    staleAfterSeconds: number;
    /** Parsed max_concurrent_agents (default 1). Kept even when > 1. */
    maxConcurrentAgents: number;
    /** Always 1 in S5. Honest reporting: no broad concurrency is implemented. */
    effectiveConcurrency: typeof SCHEDULER_EFFECTIVE_CONCURRENCY;
    /** Explicit device id override, or undefined to use S4 hostname fallback. */
    deviceId?: string;
    /**
     * Master gate (0.2.0 scope amendment §2). Fail-closed default false; a
     * legacy established block without `enabled` resolves true and carries a
     * migration signal. S1 resolves only; gating is wired in a later tracer.
     */
    enabled: boolean;
    /** Closed automation classes (inbox_tasks / agent_cron / script_cron). */
    automation: ResolvedSchedulerAutomation;
    /**
     * Present exactly for a legacy established scheduler block lacking
     * `enabled`: inspectable pure signal for a later writer/wizard tracer.
     */
    migration?: SchedulerMigrationSignal;
    warnings: string[];
}
/**
 * Pure resolver for local scheduler config. Takes a `LocalPirenConfig` and
 * returns the resolved scheduler settings with conservative defaults and
 * deterministic fallbacks for invalid/non-positive values. No I/O.
 *
 * 0.2.0 S1 addition: also resolves the `enabled` master gate and the closed
 * `automation` classes (fail-closed defaults, deterministic warnings, and a
 * pure migration signal for legacy blocks lacking `enabled`). Existing
 * interval/stale/concurrency/device behavior is unchanged.
 */
export declare function resolveSchedulerConfig(config: LocalPirenConfig): ResolvedSchedulerConfig;
export interface SchedulerLoopController {
    readonly shutdownRequested: boolean;
    readonly shutdownReason: string | undefined;
    /** Resolve when shutdown is requested. Same promise across calls. */
    onceShutdown(): Promise<void>;
    /** Mark shutdown as requested. Idempotent. */
    requestShutdown(reason?: string): void;
}
/**
 * Create a shutdown controller. The CLI wires `process.on("SIGINT"/"SIGTERM")`
 * to `requestShutdown(...)`; unit tests call it directly. No `process` access
 * lives inside the loop.
 */
export declare function createSchedulerLoopController(): SchedulerLoopController;
export interface SchedulerLoopSleep {
    /** Wait `ms` milliseconds. Must resolve early when `cancel()` is called. */
    wait(ms: number): Promise<void>;
    /** Cancel any pending wait immediately (clears the timer and resolves). */
    cancel(): void;
}
/**
 * Production sleep backed by `setTimeout`. `cancel()` clears the timer and
 * resolves the pending wait so no dangling timer keeps the process alive after
 * shutdown. The timer is intentionally NOT `unref()`d: during a 30s sleep it is
 * the only thing keeping the long-running scheduler process alive, which is the
 * intended behavior. On shutdown, `cancel()` clears it.
 */
export declare function createRealSchedulerLoopSleep(): SchedulerLoopSleep;
export interface SchedulerLoopOptions {
    /** Path passed to each `schedulerOnce` tick so it reads the right config. */
    configPath?: string;
    /** Resolved scheduler settings (poll interval, stale-after, device id, ...). */
    schedulerConfig: ResolvedSchedulerConfig;
    /** Enabled agents snapshot for the startup summary (allowed minus excluded). */
    enabledAgents: string[];
    /** The S4 one-shot primitive. Production: `schedulerOnce`. */
    schedulerOnce: (options: SchedulerOnceOptions) => Promise<SchedulerOnceResult>;
    /** Bounded execution seams forwarded to each tick. */
    executors: SchedulerOnceExecutors;
    /** Sleep seam. Production: `createRealSchedulerLoopSleep()`. */
    sleep: SchedulerLoopSleep;
    /** Shutdown controller. Production: wired to SIGINT/SIGTERM. */
    controller: SchedulerLoopController;
    /** Clock. Production: `() => new Date()`. */
    now?: () => Date;
    /** Logger. Production: `(m) => console.log(m)`. */
    log?: (message: string) => void;
}
export interface SchedulerLoopResult {
    tickCount: number;
    executedCount: number;
    startedAt: Date;
    finishedAt: Date;
    shutdownReason: string | undefined;
    summary: string;
}
/**
 * Run the scheduler loop until the controller requests shutdown. Calls the
 * injected `schedulerOnce` once per tick (claim-first, at-most-one execution
 * stay delegated to S4), sleeps between ticks, and stops cleanly without
 * starting a new tick after shutdown. Returns a summary result.
 */
export declare function runSchedulerLoop(options: SchedulerLoopOptions): Promise<SchedulerLoopResult>;
