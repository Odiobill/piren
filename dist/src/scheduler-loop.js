// ---------------------------------------------------------------------------
// Scheduler loop (ADR-0029 / O7 S5)
// ---------------------------------------------------------------------------
//
// An explicit, opt-in loop that wraps the accepted S4 `schedulerOnce` one-shot
// primitive. Bare `piren scheduler` runs this loop; `--once` and `--dry-run`
// remain distinct and S4-compatible. The loop:
//
//   1. reads local scheduler config (poll interval, stale-after, max
//      concurrency, device id) once at startup;
//   2. calls the injected `schedulerOnce` once per tick, passing the resolved
//      device id / stale-after so claim-first execution and at-most-one-item
//      behavior stay delegated to S4;
//   3. sleeps between ticks according to poll_interval_seconds;
//   4. stops cleanly when the shutdown controller is tripped (SIGINT/SIGTERM
//      in CLI wiring), without starting a new tick and without leaving a
//      dangling timer.
//
// No `process`/signal access lives here: signal handling is thin and isolated
// in CLI wiring. All I/O/time seams are injectable so unit tests use fakes and
// no real sleeps, real signals, real services, or live Pi auth.
const DEFAULT_POLL_INTERVAL_SECONDS = 30;
const DEFAULT_STALE_AFTER_SECONDS = 300;
const DEFAULT_MAX_CONCURRENT_AGENTS = 1;
/** Effective concurrency supported by S5. S4 is one-at-a-time; S5 is honest. */
export const SCHEDULER_EFFECTIVE_CONCURRENCY = 1;
function resolvePositiveInt(value, fallback, name, warnings) {
    // Absent field: use the default silently. Only an explicitly-provided invalid
    // value (wrong type, non-finite, non-integer, or non-positive) warns and
    // falls back, so a missing scheduler block produces no warnings.
    if (value === undefined)
        return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
        warnings.push(`scheduler.${name}=${JSON.stringify(value)} is invalid; falling back to ${fallback}.`);
        return fallback;
    }
    return value;
}
/**
 * Pure resolver for local scheduler config. Takes a `LocalPirenConfig` and
 * returns the resolved scheduler settings with conservative defaults and
 * deterministic fallbacks for invalid/non-positive values. No I/O.
 */
export function resolveSchedulerConfig(config) {
    const warnings = [];
    const sched = config.scheduler ?? {};
    const pollIntervalSeconds = resolvePositiveInt(sched.poll_interval_seconds, DEFAULT_POLL_INTERVAL_SECONDS, "poll_interval_seconds", warnings);
    const staleAfterSeconds = resolvePositiveInt(sched.stale_after_seconds, DEFAULT_STALE_AFTER_SECONDS, "stale_after_seconds", warnings);
    const maxConcurrentAgents = resolvePositiveInt(sched.max_concurrent_agents, DEFAULT_MAX_CONCURRENT_AGENTS, "max_concurrent_agents", warnings);
    const result = {
        pollIntervalSeconds,
        staleAfterSeconds,
        maxConcurrentAgents,
        effectiveConcurrency: SCHEDULER_EFFECTIVE_CONCURRENCY,
        warnings,
    };
    // Pass an explicit device id VERBATIM (no sanitization): S4 uses explicit ids
    // as-is and downstream claim validators reject invalid forms rather than
    // silently transforming them. An empty/whitespace-only value is treated as
    // absent so the S4 sanitized-hostname fallback still applies.
    if (typeof sched.device_id === "string" && sched.device_id.trim() !== "") {
        result.deviceId = sched.device_id;
    }
    return result;
}
/**
 * Create a shutdown controller. The CLI wires `process.on("SIGINT"/"SIGTERM")`
 * to `requestShutdown(...)`; unit tests call it directly. No `process` access
 * lives inside the loop.
 */
export function createSchedulerLoopController() {
    let requested = false;
    let reason;
    let resolveFn = null;
    const promise = new Promise((resolve) => {
        resolveFn = resolve;
    });
    return {
        get shutdownRequested() {
            return requested;
        },
        get shutdownReason() {
            return reason;
        },
        onceShutdown() {
            return promise;
        },
        requestShutdown(r) {
            if (requested)
                return;
            requested = true;
            reason = r;
            if (resolveFn !== null) {
                const fn = resolveFn;
                resolveFn = null;
                fn();
            }
        },
    };
}
/**
 * Production sleep backed by `setTimeout`. `cancel()` clears the timer and
 * resolves the pending wait so no dangling timer keeps the process alive after
 * shutdown. The timer is intentionally NOT `unref()`d: during a 30s sleep it is
 * the only thing keeping the long-running scheduler process alive, which is the
 * intended behavior. On shutdown, `cancel()` clears it.
 */
export function createRealSchedulerLoopSleep() {
    let timer = null;
    let resolveFn = null;
    const clear = () => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        if (resolveFn !== null) {
            const fn = resolveFn;
            resolveFn = null;
            fn();
        }
    };
    return {
        wait(ms) {
            return new Promise((resolve) => {
                resolveFn = resolve;
                timer = setTimeout(() => {
                    timer = null;
                    resolveFn = null;
                    resolve();
                }, ms);
            });
        },
        cancel() {
            clear();
        },
    };
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function formatStartupSummary(schedulerConfig, enabledAgents, startedAt) {
    const lines = ["SCHEDULER LOOP STARTING"];
    lines.push(`started at: ${startedAt.toISOString()}`);
    const deviceIdLabel = schedulerConfig.deviceId !== undefined
        ? schedulerConfig.deviceId
        : "auto (sanitized hostname at tick time)";
    lines.push(`device id: ${deviceIdLabel}`);
    lines.push(`enabled agents: ${enabledAgents.join(", ") || "(none)"}`);
    lines.push(`poll interval: ${schedulerConfig.pollIntervalSeconds}s`);
    lines.push(`stale after: ${schedulerConfig.staleAfterSeconds}s`);
    lines.push(`max_concurrent_agents: ${schedulerConfig.maxConcurrentAgents} (effective: ${schedulerConfig.effectiveConcurrency}, one-at-a-time)`);
    if (schedulerConfig.warnings.length > 0) {
        lines.push("config warnings:");
        for (const w of schedulerConfig.warnings)
            lines.push(`  - ${w}`);
    }
    lines.push("press Ctrl+C (SIGINT/SIGTERM) to stop cleanly after the current tick.");
    return lines.join("\n") + "\n";
}
function formatTickSummary(tickNumber, result) {
    const head = `--- tick ${tickNumber} ---`;
    const body = result.summary.replace(/\n$/, "");
    const tail = result.executed
        ? `executed: yes (${result.executedItemType ?? "?"})`
        : result.noWork
            ? "executed: no (no work this tick)"
            : "executed: no";
    return `${head}\n${body}\n${tail}\n`;
}
function formatShutdownSummary(tickCount, executedCount, reason, finishedAt) {
    const lines = ["SCHEDULER LOOP SHUTDOWN"];
    lines.push(`reason: ${reason ?? "shutdown requested"}`);
    lines.push(`ticks run: ${tickCount}`);
    lines.push(`items executed: ${executedCount}`);
    lines.push(`finished at: ${finishedAt.toISOString()}`);
    lines.push("clean shutdown complete.");
    return lines.join("\n") + "\n";
}
/**
 * Race the sleep against shutdown, then cancel the sleep. If shutdown wins, the
 * pending timer is cleared so no dangling timer keeps the process alive. If the
 * sleep wins naturally, `cancel()` is a harmless no-op (timer already fired).
 */
async function cancellableSleep(sleep, controller, ms) {
    await Promise.race([sleep.wait(ms), controller.onceShutdown()]);
    sleep.cancel();
}
/**
 * Run the scheduler loop until the controller requests shutdown. Calls the
 * injected `schedulerOnce` once per tick (claim-first, at-most-one execution
 * stay delegated to S4), sleeps between ticks, and stops cleanly without
 * starting a new tick after shutdown. Returns a summary result.
 */
export async function runSchedulerLoop(options) {
    const log = options.log ?? (() => { });
    const now = options.now ?? (() => new Date());
    const { schedulerConfig, controller, sleep, schedulerOnce, executors } = options;
    const pollIntervalMs = schedulerConfig.pollIntervalSeconds * 1000;
    const staleAfterMs = schedulerConfig.staleAfterSeconds * 1000;
    const startedAt = now();
    log(formatStartupSummary(schedulerConfig, options.enabledAgents, startedAt));
    let tickCount = 0;
    let executedCount = 0;
    while (!controller.shutdownRequested) {
        tickCount += 1;
        const tickOptions = {
            executors,
            now,
            staleAfterMs,
        };
        if (options.configPath !== undefined)
            tickOptions.configPath = options.configPath;
        if (schedulerConfig.deviceId !== undefined)
            tickOptions.deviceId = schedulerConfig.deviceId;
        let result;
        try {
            result = await schedulerOnce(tickOptions);
        }
        catch (error) {
            log(`tick ${tickCount} failed: ${errorMessage(error)}`);
            if (controller.shutdownRequested)
                break;
            await cancellableSleep(sleep, controller, pollIntervalMs);
            continue;
        }
        if (result.executed)
            executedCount += 1;
        log(formatTickSummary(tickCount, result));
        if (controller.shutdownRequested)
            break;
        await cancellableSleep(sleep, controller, pollIntervalMs);
    }
    const finishedAt = now();
    const summary = formatShutdownSummary(tickCount, executedCount, controller.shutdownReason, finishedAt);
    log(summary);
    return {
        tickCount,
        executedCount,
        startedAt,
        finishedAt,
        shutdownReason: controller.shutdownReason,
        summary,
    };
}
//# sourceMappingURL=scheduler-loop.js.map