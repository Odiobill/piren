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
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { crontabAvailableFromInvocation, detectServiceManager, systemdUserAvailableFromInvocation, } from "./service-lifecycle.js";
/** Fixed compile-time target set; the gateway target is deliberately absent. */
export const SERVICE_OBSERVATION_TARGETS = ["telegram", "discord", "scheduler"];
/** Fixed per-probe bound; not caller-controlled. */
export const SERVICE_OBSERVATION_TIMEOUT_MS = 4000;
// ---------------------------------------------------------------------------
// Fixed commands (argument arrays; no shell, no caller input)
// ---------------------------------------------------------------------------
export function systemdIsActiveArgv(target) {
    return ["systemctl", "--user", "is-active", `piren-${target}.service`];
}
export function tmuxHasSessionArgv(target) {
    return ["tmux", "has-session", "-t", `piren-${target}`];
}
// ---------------------------------------------------------------------------
// Pure classifiers (exact state meanings from the accepted contract)
// ---------------------------------------------------------------------------
/**
 * Classify `systemctl --user is-active piren-<target>.service`. Only the
 * literal manager words map: "active" (exit 0) -> active, "inactive" ->
 * inactive. Anything else — "failed", "unknown", empty/malformed output, a
 * signal, or a missing exit code — cannot be classified safely and is
 * `unknown`, never an inferred inactive.
 */
export function classifySystemdIsActive(result) {
    if (result.signal !== null || result.exitCode === null)
        return "unknown";
    const out = result.stdout.trim();
    if (result.exitCode === 0 && out === "active")
        return "active";
    if (out === "inactive")
        return "inactive";
    return "unknown";
}
/**
 * Classify `tmux has-session -t piren-<target>`: exit 0 -> active, exit 1
 * (no such session) -> inactive. Any other exit, a signal, or a missing exit
 * code is `unknown`.
 */
export function classifyTmuxHasSession(result) {
    if (result.signal !== null || result.exitCode === null)
        return "unknown";
    if (result.exitCode === 0)
        return "active";
    if (result.exitCode === 1)
        return "inactive";
    return "unknown";
}
// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------
async function detectManagerKind(deps) {
    try {
        const manager = await detectServiceManager(deps);
        if (manager === "systemd")
            return "systemd-user";
        if (manager === "tmux-cron")
            return "tmux-cron";
        return "unavailable";
    }
    catch {
        // A detection failure is not evidence of any target state.
        return "unavailable";
    }
}
async function observeTarget(deps, manager, target) {
    try {
        const artifact = manager === "systemd-user" ? "systemd-unit" : "tmux-launch-script";
        if (!(await deps.artifactExists(artifact, target)))
            return "not-installed";
        const argv = manager === "systemd-user" ? systemdIsActiveArgv(target) : tmuxHasSessionArgv(target);
        const result = await Promise.race([deps.run(argv), deps.timeoutAfter(SERVICE_OBSERVATION_TIMEOUT_MS)]);
        return manager === "systemd-user" ? classifySystemdIsActive(result) : classifyTmuxHasSession(result);
    }
    catch {
        // Probe error, artifact-check error, timeout, or race: fail safe.
        return "unknown";
    }
}
/**
 * Sample the fixed target set once and return the bounded typed snapshot.
 * Each target is classified independently: one target's failed probe becomes
 * that target's `unknown`, never a fabricated whole-snapshot answer.
 */
export async function observeServiceStatus(deps) {
    const manager = await detectManagerKind(deps);
    const observedAt = deps.now().toISOString();
    if (manager === "unavailable") {
        return {
            observedAt,
            manager,
            targets: SERVICE_OBSERVATION_TARGETS.map((target) => ({ target, state: "unavailable" })),
        };
    }
    const targets = await Promise.all(SERVICE_OBSERVATION_TARGETS.map(async (target) => ({ target, state: await observeTarget(deps, manager, target) })));
    return { observedAt, manager, targets };
}
/**
 * Production gateway wiring: compose the D2.1 evaluator over the fixed local
 * observation seams. The deps parameter exists only so wiring tests inject a
 * fake seam and never probe a live service manager; the CLI calls this with
 * no arguments, which selects createLocalServiceObservationDeps().
 */
export function createLocalServiceStatusReader(deps) {
    const resolved = deps ?? createLocalServiceObservationDeps();
    return () => observeServiceStatus(resolved);
}
// ---------------------------------------------------------------------------
// Production seam factory (fixed Piren-owned paths; argument-array execution)
// ---------------------------------------------------------------------------
function runCapture(argv) {
    return new Promise((resolve) => {
        const [command, ...args] = argv;
        if (command === undefined) {
            resolve({ exitCode: null, signal: null, stdout: "" });
            return;
        }
        execFile(command, args, { timeout: SERVICE_OBSERVATION_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (error, stdout) => {
            if (!error) {
                resolve({ exitCode: 0, signal: null, stdout: String(stdout ?? "") });
                return;
            }
            const code = typeof error.code === "number" ? error.code : null;
            resolve({ exitCode: code, signal: error.signal ?? null, stdout: String(stdout ?? "") });
        });
    });
}
/**
 * Production seams over the fixed Piren-owned artifacts:
 * - systemd unit: ~/.config/systemd/user/piren-<target>.service
 * - tmux launch script: ~/.config/piren/services/piren-<target>.tmux.sh
 * Manager availability reuses the exact service-lifecycle invocation
 * classifiers (degraded systemd user sessions and crontab-less cron installs
 * stay usable, matching `piren service` detection).
 */
export function createLocalServiceObservationDeps(homeDir) {
    const home = homeDir ?? homedir();
    const systemdUserDir = join(home, ".config", "systemd", "user");
    const servicesDir = join(home, ".config", "piren", "services");
    return {
        hasSystemdUser: async () => systemdUserAvailableFromInvocation(await runCapture(["systemctl", "--user", "is-system-running"])),
        hasTmux: async () => (await runCapture(["tmux", "-V"])).exitCode === 0,
        hasCrontab: async () => crontabAvailableFromInvocation(await runCapture(["crontab", "-l"])),
        run: (argv) => runCapture(argv),
        artifactExists: async (artifact, target) => {
            const path = artifact === "systemd-unit"
                ? join(systemdUserDir, `piren-${target}.service`)
                : join(servicesDir, `piren-${target}.tmux.sh`);
            try {
                await access(path);
                return true;
            }
            catch (error) {
                // Only a definite absent artifact is `not-installed`. Permission,
                // filesystem, and path-shape errors must reach the evaluator so it
                // classifies the target as the contract's fail-safe `unknown`.
                if (error.code === "ENOENT")
                    return false;
                throw error;
            }
        },
        now: () => new Date(),
        timeoutAfter: (ms) => new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error("service observation probe timed out")), ms);
        }),
    };
}
//# sourceMappingURL=service-observability.js.map