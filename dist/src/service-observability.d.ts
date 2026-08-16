/**
 * D2.1 — pure local service-observation core (accepted contract:
 * Projects/Piren/workbench-dashboard-service-observability-contract.md).
 *
 * A small, directly testable evaluator that samples the fixed non-gateway
 * Piren service targets (telegram, discord, scheduler — fixed contract order)
 * through the existing supported-manager precedence: a usable systemd user
 * manager, then usable tmux plus crontab, otherwise unavailable.
 *
 * Boundaries:
 * - The gateway service is deliberately EXCLUDED: a successful authenticated
 *   Workbench read is already the exact gateway-connection fact; this core
 *   never probes or reports `gateway`.
 * - Target selection, commands, paths, manager precedence, and timeout are
 *   fixed at compile time. Callers inject only the command/file/clock seams;
 *   nothing caller-controlled reaches a command line, and execution is by
 *   argument array — never a shell.
 * - Every probe error, timeout, malformed output, signal, or race fails
 *   safely to `unknown`; an unavailable manager yields `unavailable`. Neither
 *   is ever presented as `inactive`.
 * - `not-installed` means only that the manager-specific fixed Piren artifact
 *   is absent; it never asserts a target cannot be running manually.
 * - The core is read-only: no service control, no file/config writes, no
 *   network, no polling, no persistence, and no raw diagnostics, logs, paths,
 *   or secrets in the returned snapshot.
 */
import { type ServiceManagerDetection } from "./service-lifecycle.js";
export type ServiceManagerKind = "systemd-user" | "tmux-cron" | "unavailable";
export type ServiceObservedState = "active" | "inactive" | "not-installed" | "unavailable" | "unknown";
/** Fixed compile-time target set; the gateway target is deliberately absent. */
export declare const SERVICE_OBSERVATION_TARGETS: readonly ["telegram", "discord", "scheduler"];
export type ServiceObservationTarget = (typeof SERVICE_OBSERVATION_TARGETS)[number];
export interface ServiceTargetObservation {
    target: ServiceObservationTarget;
    state: ServiceObservedState;
}
export interface ServiceStatusSnapshot {
    /** Server-generated canonical ISO observation time (from the injected clock). */
    observedAt: string;
    manager: ServiceManagerKind;
    /** Fixed order: telegram, discord, scheduler. */
    targets: ServiceTargetObservation[];
}
export interface CommandRunResult {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
}
/** Fixed artifact kinds; the seam maps kind+target to a path, never the caller. */
export type ServiceArtifactKind = "systemd-unit" | "tmux-launch-script";
export interface ServiceObservationDeps extends ServiceManagerDetection {
    /** Argument-array execution only; the core builds every argv itself. */
    run: (argv: readonly string[]) => Promise<CommandRunResult>;
    artifactExists: (artifact: ServiceArtifactKind, target: ServiceObservationTarget) => Promise<boolean>;
    now: () => Date;
    /** Rejects after `ms`; the core races every probe against it. */
    timeoutAfter: (ms: number) => Promise<never>;
}
/** Fixed per-probe bound; not caller-controlled. */
export declare const SERVICE_OBSERVATION_TIMEOUT_MS = 4000;
export declare function systemdIsActiveArgv(target: ServiceObservationTarget): string[];
export declare function tmuxHasSessionArgv(target: ServiceObservationTarget): string[];
/**
 * Classify `systemctl --user is-active piren-<target>.service`. Only the
 * literal manager words map: "active" (exit 0) -> active, "inactive" ->
 * inactive. Anything else — "failed", "unknown", empty/malformed output, a
 * signal, or a missing exit code — cannot be classified safely and is
 * `unknown`, never an inferred inactive.
 */
export declare function classifySystemdIsActive(result: CommandRunResult): ServiceObservedState;
/**
 * Classify `tmux has-session -t piren-<target>`: exit 0 -> active, exit 1
 * (no such session) -> inactive. Any other exit, a signal, or a missing exit
 * code is `unknown`.
 */
export declare function classifyTmuxHasSession(result: CommandRunResult): ServiceObservedState;
/**
 * Sample the fixed target set once and return the bounded typed snapshot.
 * Each target is classified independently: one target's failed probe becomes
 * that target's `unknown`, never a fabricated whole-snapshot answer.
 */
export declare function observeServiceStatus(deps: ServiceObservationDeps): Promise<ServiceStatusSnapshot>;
/**
 * Production seams over the fixed Piren-owned artifacts:
 * - systemd unit: ~/.config/systemd/user/piren-<target>.service
 * - tmux launch script: ~/.config/piren/services/piren-<target>.tmux.sh
 * Manager availability reuses the exact service-lifecycle invocation
 * classifiers (degraded systemd user sessions and crontab-less cron installs
 * stay usable, matching `piren service` detection).
 */
export declare function createLocalServiceObservationDeps(homeDir?: string): ServiceObservationDeps;
