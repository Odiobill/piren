import type { LocalPirenConfig } from "./bootstrap.js";
import type {
  SchedulerOnceOptions,
  SchedulerOnceResult,
  SchedulerOnceExecutors,
} from "./scheduler-once.js";

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
export const SCHEDULER_EFFECTIVE_CONCURRENCY = 1 as const;

// ---------------------------------------------------------------------------
// 0.2 Settings contract §4.3 (SGC-1): retired master gate + sole class gates
// ---------------------------------------------------------------------------
// Binding contract (0.2 Settings contract §4.3 + SGC-1/2 task):
//   - ~/.config/piren/config.yml is the sole scheduler authority;
//   - `scheduler.enabled` is RETIRED as an execution gate: the three
//     automation classes are the normal sole execution gates;
//   - absent/malformed classes fail closed with deterministic non-secret
//     warnings;
//   - a present `enabled: true` is inert-to-ignore (never adds execution);
//   - a present `enabled: false` or malformed value is an ambiguous legacy
//     gate: ALL classes resolve disabled (fail closed) so no old
//     `enabled:false` installation can silently begin executing, and
//     `--force` never bypasses it until an operator-confirmed migration;
//   - the `enabled`/`migration` compat fields below keep the S1 computation
//     byte-for-byte because the SGC-3 consumers (doctor/configure) are
//     reworked in a later tracer; runtime surfaces (loop/once/dry-run/
//     report) use `legacyMasterGate` + `automation` and never treat
//     `enabled` as a gate.

/**
 * Closed retired-master-gate state (0.2 Settings contract §4.3):
 * - "absent": no `scheduler.enabled` key (normal);
 * - "ignored": explicit `enabled: true` — inert-to-ignore, never adds
 *   execution; classes are the sole gates;
 * - "gated": explicit `enabled: false` or malformed value — ambiguous
 *   legacy gate; ALL automation classes resolve disabled (fail closed) and
 *   `--force` never bypasses it.
 */
export type SchedulerLegacyMasterGateState = "absent" | "ignored" | "gated";

/**
 * Closed automation-class model: exactly these three classes exist. No
 * per-task/per-cron/per-agent allowlists or expressions.
 */
export const SCHEDULER_AUTOMATION_CLASSES = [
  "inbox_tasks",
  "agent_cron",
  "script_cron",
] as const;
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * YAML empty values (`key:` with nothing after it) parse to null with the
 * `yaml` library (verified against real parser output). Treat null exactly
 * like absent: fail closed to disabled without a malformed-value warning.
 */
function isAbsentLike(value: unknown): boolean {
  return value === undefined || value === null;
}

/** Return a bounded value category for diagnostics without echoing local config content. */
function configValueKind(value: unknown): string {
  return Array.isArray(value) ? "array" : typeof value;
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
export function resolveAutomationClasses(automation: unknown): ResolveAutomationClassesResult {
  const warnings: string[] = [];
  const allFalse: ResolvedSchedulerAutomation = {
    inboxTasks: false,
    agentCron: false,
    scriptCron: false,
  };
  if (isAbsentLike(automation)) {
    return { classes: allFalse, warnings };
  }
  if (!isPlainRecord(automation)) {
    warnings.push(
      `scheduler.automation has invalid ${configValueKind(automation)} content; disabling all automation classes (fail closed).`,
    );
    return { classes: allFalse, warnings };
  }

  const classes: ResolvedSchedulerAutomation = { ...allFalse };
  const classKeys: Record<SchedulerAutomationClass, keyof ResolvedSchedulerAutomation> = {
    inbox_tasks: "inboxTasks",
    agent_cron: "agentCron",
    script_cron: "scriptCron",
  };
  const classLabels: Record<SchedulerAutomationClass, string> = {
    inbox_tasks: "inbox task",
    agent_cron: "agent cron",
    script_cron: "script cron",
  };
  for (const key of SCHEDULER_AUTOMATION_CLASSES) {
    const raw = automation[key];
    if (isAbsentLike(raw)) continue;
    if (typeof raw === "boolean") {
      classes[classKeys[key]] = raw;
      continue;
    }
    warnings.push(
      `scheduler.automation.${key} has invalid ${configValueKind(raw)} content; disabling ${classLabels[key]} automation (fail closed).`,
    );
  }

  // Unknown keys under `automation` are reported-and-ignored (never assigned
  // semantics), mirroring the manifest tolerance convention. Sorted so the
  // warning order is deterministic regardless of YAML insertion order.
  const knownClasses = SCHEDULER_AUTOMATION_CLASSES as readonly string[];
  const unknownKeys = Object.keys(automation)
    .filter((key) => !knownClasses.includes(key))
    .sort();
  if (unknownKeys.length > 0) {
    warnings.push(
      `scheduler.automation contains ${unknownKeys.length} unrecognized class key(s); ignoring them.`,
    );
  }
  return { classes, warnings };
}

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
   * Transitional master-gate compat (SGC-1/2). Kept byte-for-byte with the
   * S1 computation because the SGC-3 consumers (doctor/configure) are
   * reworked in a later tracer. Runtime surfaces never treat this as a gate:
   * they use {@link legacyMasterGate} + {@link automation}.
   */
  enabled: boolean;
  /** Closed automation classes (inbox_tasks / agent_cron / script_cron). */
  automation: ResolvedSchedulerAutomation;
  /**
   * Present exactly for a legacy established scheduler block lacking
   * `enabled`: inspectable pure signal for a later writer/wizard tracer.
   */
  migration?: SchedulerMigrationSignal;
  /**
   * Closed retired-master-gate state (0.2 Settings contract §4.3). Runtime
   * surfaces gate execution on {@link automation} only; when this is
   * "gated", {@link automation} is ALL disabled (fail-closed legacy gate).
   */
  legacyMasterGate: SchedulerLegacyMasterGateState;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Legacy scheduler keys that establish upgrade intent when present. Presence is
// the signal (any value, valid or not): an operator who wrote a scheduler key
// configured the scheduler, so effective enabled=true preserves that intent.
const LEGACY_SCHEDULER_KEYS = [
  "poll_interval_seconds",
  "stale_after_seconds",
  "max_concurrent_agents",
  "device_id",
] as const;

function resolvePositiveInt(
  value: unknown,
  fallback: number,
  name: string,
  warnings: string[],
): number {
  // Absent field: use the default silently. Only an explicitly-provided invalid
  // value (wrong type, non-finite, non-integer, or non-positive) warns and
  // falls back, so a missing scheduler block produces no warnings.
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    warnings.push(
      `scheduler.${name} has invalid ${configValueKind(value)} content; falling back to ${fallback}.`,
    );
    return fallback;
  }
  return value;
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
export function resolveSchedulerConfig(config: LocalPirenConfig): ResolvedSchedulerConfig {
  const warnings: string[] = [];
  const sched = config.scheduler ?? {};
  const pollIntervalSeconds = resolvePositiveInt(
    sched.poll_interval_seconds,
    DEFAULT_POLL_INTERVAL_SECONDS,
    "poll_interval_seconds",
    warnings,
  );
  const staleAfterSeconds = resolvePositiveInt(
    sched.stale_after_seconds,
    DEFAULT_STALE_AFTER_SECONDS,
    "stale_after_seconds",
    warnings,
  );
  const maxConcurrentAgents = resolvePositiveInt(
    sched.max_concurrent_agents,
    DEFAULT_MAX_CONCURRENT_AGENTS,
    "max_concurrent_agents",
    warnings,
  );

  // Retired master gate (0.2 Settings contract §4.3). The `enabled`/
  // `migration` compat fields below keep the S1 computation byte-for-byte
  // (the SGC-3 consumers doctor/configure are reworked in a later tracer);
  // runtime surfaces gate on `legacyMasterGate` + `automation` and never
  // treat `enabled` as a gate.
  const legacyKeysPresent = LEGACY_SCHEDULER_KEYS.filter((key) => sched[key] !== undefined);
  const enabledRaw = sched.enabled;
  let enabled: boolean;
  let migration: SchedulerMigrationSignal | undefined;
  let legacyMasterGate: SchedulerLegacyMasterGateState;
  if (enabledRaw === undefined) {
    if (legacyKeysPresent.length > 0) {
      enabled = true;
      migration = {
        materializeEnabled: true,
        value: true,
        reason: "legacy-scheduler-block-without-enabled",
        note:
          `scheduler block sets legacy key(s) ${legacyKeysPresent.map((key) => `scheduler.${key}`).join(", ")} ` +
          `without an 'enabled' key; effective enabled=true preserves established upgrade intent. ` +
          `Missing automation classes remain disabled (fail closed). ` +
          `Atomic materialization belongs to a later separately gated writer/wizard tracer.`,
      };
    } else {
      enabled = false;
    }
    legacyMasterGate = "absent";
  } else if (enabledRaw === null) {
    // SGC-3 lead correction: a PRESENT-but-empty retired key is a malformed
    // value, not an absent one — it gates fail-closed exactly like false.
    enabled = false;
    legacyMasterGate = "gated";
    warnings.push(
      "scheduler.enabled is present with an empty value; ambiguous legacy gate: all automation classes resolve disabled (fail closed) until an operator-confirmed migration removes the retired key; --force never bypasses this legacy gate.",
    );
  } else if (enabledRaw === true) {
    enabled = true;
    legacyMasterGate = "ignored";
    warnings.push(
      "scheduler.enabled is present with value true; the retired master gate is inert-to-ignore and never adds execution (automation classes are the sole gates).",
    );
  } else if (enabledRaw === false) {
    enabled = false;
    legacyMasterGate = "gated";
    warnings.push(
      "scheduler.enabled is present with value false; ambiguous legacy gate: all automation classes resolve disabled (fail closed) until an operator-confirmed migration removes the retired key; --force never bypasses this legacy gate.",
    );
  } else {
    enabled = false;
    legacyMasterGate = "gated";
    warnings.push(
      `scheduler.enabled has invalid ${configValueKind(enabledRaw)} content; ambiguous legacy gate: all automation classes resolve disabled (fail closed); --force never bypasses this legacy gate.`,
    );
  }

  const automationResult = resolveAutomationClasses(sched.automation);
  for (const warning of automationResult.warnings) warnings.push(warning);
  // Fail-closed legacy gating: a "gated" retired master key disables EVERY
  // automation class regardless of the declared `automation` block, so no
  // old `enabled:false` installation can silently begin executing.
  const automation: ResolvedSchedulerAutomation =
    legacyMasterGate === "gated"
      ? { inboxTasks: false, agentCron: false, scriptCron: false }
      : automationResult.classes;

  const result: ResolvedSchedulerConfig = {
    pollIntervalSeconds,
    staleAfterSeconds,
    maxConcurrentAgents,
    effectiveConcurrency: SCHEDULER_EFFECTIVE_CONCURRENCY,
    enabled,
    automation,
    legacyMasterGate,
    warnings,
  };
  if (migration !== undefined) result.migration = migration;
  // Pass an explicit device id VERBATIM (no sanitization): S4 uses explicit ids
  // as-is and downstream claim validators reject invalid forms rather than
  // silently transforming them. An empty/whitespace-only value is treated as
  // absent so the S4 sanitized-hostname fallback still applies.
  if (typeof sched.device_id === "string" && sched.device_id.trim() !== "") {
    result.deviceId = sched.device_id;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Shutdown controller (injectable signal seam)
// ---------------------------------------------------------------------------

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
export function createSchedulerLoopController(): SchedulerLoopController {
  let requested = false;
  let reason: string | undefined;
  let resolveFn: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  return {
    get shutdownRequested(): boolean {
      return requested;
    },
    get shutdownReason(): string | undefined {
      return reason;
    },
    onceShutdown(): Promise<void> {
      return promise;
    },
    requestShutdown(r?: string): void {
      if (requested) return;
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

// ---------------------------------------------------------------------------
// Cancellable sleep seam
// ---------------------------------------------------------------------------

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
export function createRealSchedulerLoopSleep(): SchedulerLoopSleep {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveFn: (() => void) | null = null;
  const clear = (): void => {
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
    wait(ms: number): Promise<void> {
      return new Promise<void>((resolve) => {
        resolveFn = resolve;
        timer = setTimeout(() => {
          timer = null;
          resolveFn = null;
          resolve();
        }, ms);
      });
    },
    cancel(): void {
      clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Loop runner
// ---------------------------------------------------------------------------

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatStartupSummary(
  schedulerConfig: ResolvedSchedulerConfig,
  enabledAgents: string[],
  startedAt: Date,
): string {
  const lines: string[] = ["SCHEDULER LOOP STARTING"];
  lines.push(`started at: ${startedAt.toISOString()}`);
  const deviceIdLabel =
    schedulerConfig.deviceId !== undefined
      ? schedulerConfig.deviceId
      : "auto (sanitized hostname at tick time)";
  lines.push(`device id: ${deviceIdLabel}`);
  lines.push(`enabled agents: ${enabledAgents.join(", ") || "(none)"}`);
  lines.push(`poll interval: ${schedulerConfig.pollIntervalSeconds}s`);
  lines.push(`stale after: ${schedulerConfig.staleAfterSeconds}s`);
  lines.push(
    `max_concurrent_agents: ${schedulerConfig.maxConcurrentAgents} (effective: ${schedulerConfig.effectiveConcurrency}, one-at-a-time)`,
  );
  // 0.2 Settings contract §4.3: bounded resolved automation classes, an
  // inert-supervision note when every class is disabled, and bounded legacy
  // notices for a retired `scheduler.enabled` key (never config content).
  const onOff = (value: boolean): string => (value ? "on" : "off");
  lines.push(
    `automation: inbox_tasks=${onOff(schedulerConfig.automation.inboxTasks)} ` +
      `agent_cron=${onOff(schedulerConfig.automation.agentCron)} ` +
      `script_cron=${onOff(schedulerConfig.automation.scriptCron)}`,
  );
  if (!schedulerConfig.automation.inboxTasks && !schedulerConfig.automation.agentCron && !schedulerConfig.automation.scriptCron) {
    lines.push("no enabled automation classes; the loop runs as supervision only and will not heartbeat, plan, claim, or spawn until a class is enabled.");
  }
  if (schedulerConfig.legacyMasterGate === "gated") {
    lines.push("legacy gate: retired scheduler.enabled key present with a disabled/malformed value; all automation classes resolve disabled (fail closed); operator-confirmed migration required (read-only notice, not persisted)");
  } else if (schedulerConfig.legacyMasterGate === "ignored") {
    lines.push("legacy: retired scheduler.enabled key present with value true; inert-to-ignore (read-only notice, not persisted)");
  }
  if (schedulerConfig.warnings.length > 0) {
    lines.push("config warnings:");
    for (const w of schedulerConfig.warnings) lines.push(`  - ${w}`);
  }
  lines.push("press Ctrl+C (SIGINT/SIGTERM) to stop cleanly after the current tick.");
  return lines.join("\n") + "\n";
}

function formatTickSummary(tickNumber: number, result: SchedulerOnceResult): string {
  const head = `--- tick ${tickNumber} ---`;
  const body = result.summary.replace(/\n$/, "");
  const tail = result.executed
    ? `executed: yes (${result.executedItemType ?? "?"})`
    : result.noWork
      ? "executed: no (no work this tick)"
      : "executed: no";
  return `${head}\n${body}\n${tail}\n`;
}

function formatShutdownSummary(
  tickCount: number,
  executedCount: number,
  reason: string | undefined,
  finishedAt: Date,
): string {
  const lines: string[] = ["SCHEDULER LOOP SHUTDOWN"];
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
async function cancellableSleep(
  sleep: SchedulerLoopSleep,
  controller: SchedulerLoopController,
  ms: number,
): Promise<void> {
  await Promise.race([sleep.wait(ms), controller.onceShutdown()]);
  sleep.cancel();
}

/**
 * Run the scheduler loop until the controller requests shutdown. Calls the
 * injected `schedulerOnce` once per tick (claim-first, at-most-one execution
 * stay delegated to S4), sleeps between ticks, and stops cleanly without
 * starting a new tick after shutdown. Returns a summary result.
 */
export async function runSchedulerLoop(options: SchedulerLoopOptions): Promise<SchedulerLoopResult> {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const { schedulerConfig, controller, sleep, schedulerOnce, executors } = options;
  const pollIntervalMs = schedulerConfig.pollIntervalSeconds * 1000;
  const staleAfterMs = schedulerConfig.staleAfterSeconds * 1000;

  const startedAt = now();

  // 0.2 Settings contract §4.3: there is no master-gate exit. The loop runs
  // as supervision; schedulerOnce per tick gates execution on the resolved
  // automation classes (all classes off = inert supervision with no
  // heartbeat/planning/claim/spawn per tick).

  log(formatStartupSummary(schedulerConfig, options.enabledAgents, startedAt));

  let tickCount = 0;
  let executedCount = 0;

  while (!controller.shutdownRequested) {
    tickCount += 1;
    const tickOptions: SchedulerOnceOptions = {
      executors,
      now,
      staleAfterMs,
    };
    if (options.configPath !== undefined) tickOptions.configPath = options.configPath;
    if (schedulerConfig.deviceId !== undefined) tickOptions.deviceId = schedulerConfig.deviceId;

    let result: SchedulerOnceResult;
    try {
      result = await schedulerOnce(tickOptions);
    } catch (error) {
      log(`tick ${tickCount} failed: ${errorMessage(error)}`);
      if (controller.shutdownRequested) break;
      await cancellableSleep(sleep, controller, pollIntervalMs);
      continue;
    }
    if (result.executed) executedCount += 1;
    log(formatTickSummary(tickCount, result));

    if (controller.shutdownRequested) break;

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
