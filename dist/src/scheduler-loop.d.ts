import type { LocalPirenConfig } from "./bootstrap.js";
import type { SchedulerOnceOptions, SchedulerOnceResult, SchedulerOnceExecutors } from "./scheduler-once.js";
/** Effective concurrency supported by S5. S4 is one-at-a-time; S5 is honest. */
export declare const SCHEDULER_EFFECTIVE_CONCURRENCY: 1;
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
    warnings: string[];
}
/**
 * Pure resolver for local scheduler config. Takes a `LocalPirenConfig` and
 * returns the resolved scheduler settings with conservative defaults and
 * deterministic fallbacks for invalid/non-positive values. No I/O.
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
