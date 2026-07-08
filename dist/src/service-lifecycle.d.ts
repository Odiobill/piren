/**
 * Service lifecycle management for Piren transports.
 *
 * Pure core, fully unit-tested without a real systemd or tmux install. Three layers:
 *
 * 1. Detection: `detectServiceManager(probe)` returns "systemd" (preferred),
 *    "tmux-cron" (fallback for DietPi/stripped-down systems), or "none".
 *    The probe is injected so tests fake availability.
 * 2. Generation: `generateSystemdUnit`, `generateTmuxLaunchScript`,
 *    `generateCronEntry` produce plain-text service files.
 * 3. Plans: `installPlan` / `removePlan` describe the exact files to write and
 *    commands to run, with absolute paths. The CLI orchestrates them.
 *
 * Per ADR-0021: systemd USER units (no sudo), tmux + @reboot cron fallback, all
 * generated files under ~/.config/piren/services/, everything inspectable and
 * reversible.
 */
export declare const SERVICE_TRANSPORTS: readonly ["gateway", "telegram", "discord", "scheduler"];
export type ServiceTransport = (typeof SERVICE_TRANSPORTS)[number];
export declare const SERVICE_ACTIONS: readonly ["install", "remove", "start", "stop", "restart", "status"];
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];
export type ServiceManager = "systemd" | "tmux-cron" | "none";
/** Injected availability probe so detection is unit-testable. */
export interface ServiceManagerDetection {
    hasSystemdUser: () => Promise<boolean>;
    hasTmux: () => Promise<boolean>;
    hasCrontab: () => Promise<boolean>;
}
export interface ValidationResult {
    ok: boolean;
    message?: string;
}
export declare function validateTransport(transport: string): ValidationResult;
export declare function validateAction(action: string): ValidationResult;
export declare function unitName(transport: ServiceTransport): string;
/**
 * Resolve the systemd user unit basename -> XDG_CONFIG_HOME path.
 * systemd reads ~/.config/systemd/user/*.service.
 */
export declare function systemdUnitPath(servicesDir: string, transport: ServiceTransport): string;
export declare function detectServiceManager(probe: ServiceManagerDetection): Promise<ServiceManager>;
/**
 * Interpret the result of invoking `crontab -l` to decide whether cron is
 * available on this system. vixie cron / Debian's `cron` package exit 1
 * specifically when the user has NO crontab yet, even though cron is installed
 * and running. Reading that as "unavailable" caused DietPi and other
 * stripped-down systems (no user crontab at first run) to be detected as "none"
 * instead of the intended "tmux-cron" fallback.
 *
 * Semantics:
 *   - exit 0: crontab exists, available.
 *   - exit 1: "no crontab for user" on Debian/vixie cron; cron IS installed.
 *   - exit >= 2 or a signal: hard failure (command not found, etc.) -> unavailable.
 */
export interface CrontabInvocationResult {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
}
export declare function crontabAvailableFromInvocation(result: CrontabInvocationResult): boolean;
/**
 * Interpret the result of invoking `systemctl --user is-system-running` to
 * decide whether the systemd user session can run Piren services.
 *
 * `is-system-running` prints a state word and exits:
 *   - exit 0: "running".
 *   - exit 1: "degraded", "starting", or "maintenance". A degraded session has
 *     a failed unit but still runs services fine; "starting"/"maintenance" are
 *     also a usable user manager for our purposes.
 *   - exit >= 2 or a signal: hard failure (command not found, no user session,
 *     bus error) -> unavailable.
 *
 * Reading exit 1 as "unavailable" caused systems with a merely degraded user
 * session (a common homelab state) to be detected as "none" instead of
 * "systemd", breaking `piren service install` on otherwise healthy machines.
 */
export interface SystemdInvocationResult {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
}
export declare function systemdUserAvailableFromInvocation(result: SystemdInvocationResult): boolean;
export interface GenerateServiceOptions {
    transport: ServiceTransport;
    pirenCommand: string;
    vaultRoot: string;
    agentName: string;
}
/**
 * Build the `piren <target> ...` start command for a service target.
 *
 * Transports (gateway/telegram/discord) boot with an initial agent context, so
 * they get `--vault-root <root> --agent <agent>`. The scheduler is different:
 * it launches the S5 loop (`piren scheduler`) and is NOT bound to one agent —
 * the loop reads local config (`allowed_agents` minus `excluded_agents`) on
 * each tick. Generating `--vault-root/--agent` for the scheduler would be
 * misleading (the loop currently ignores them), so it gets a bare command.
 */
export declare function targetStartCommand(transport: ServiceTransport, pirenCommand: string, vaultRoot: string, agentName: string): string;
export interface SystemdUnitOptions extends GenerateServiceOptions {
    description: string;
}
export declare function generateSystemdUnit(opts: SystemdUnitOptions): string;
export declare function generateTmuxLaunchScript(opts: GenerateServiceOptions): string;
export interface CronEntryOptions {
    transport: ServiceTransport;
    launchScriptPath: string;
}
export declare function generateCronEntry(opts: CronEntryOptions): string;
export interface FileWrite {
    path: string;
    content: string;
    executable?: boolean;
}
export interface ServicePlan {
    manager: ServiceManager;
    files: FileWrite[];
    commands: string[];
    instructions: string[];
}
export interface InstallPlanOptions {
    transport: ServiceTransport;
    manager: ServiceManager;
    pirenCommand: string;
    vaultRoot: string;
    agentName: string;
    servicesDir: string;
    description?: string;
}
export declare function installPlan(opts: InstallPlanOptions): ServicePlan;
export interface RemovePlanOptions {
    transport: ServiceTransport;
    manager: ServiceManager;
    servicesDir: string;
}
export interface RemovePlan {
    manager: ServiceManager;
    commands: string[];
    filesToRemove: string[];
    instructions: string[];
}
export declare function removePlan(opts: RemovePlanOptions): RemovePlan;
export declare function controlCommands(action: "start" | "stop" | "restart" | "status", transport: ServiceTransport, manager: ServiceManager): string[];
export interface CommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}
export interface ServiceExecDeps {
    writeFile: (path: string, content: string, opts?: {
        executable?: boolean;
    }) => Promise<void>;
    removeFile: (path: string) => Promise<void>;
    runCommand: (command: string) => Promise<CommandResult>;
    log: (message: string) => void;
}
export interface ResolvePirenCommandOptions {
    /** Explicit override (e.g. process.argv[1] when running the real binary). */
    explicit?: string | undefined;
}
export declare function resolvePirenCommand(opts?: ResolvePirenCommandOptions): string;
export interface ExecuteServiceActionOptions {
    action: ServiceAction;
    transport: ServiceTransport;
    manager: ServiceManager;
    pirenCommand: string;
    vaultRoot: string;
    agentName: string;
    servicesDir: string;
    deps: ServiceExecDeps;
}
export interface ServiceActionReport {
    ok: boolean;
    action: ServiceAction;
    transport: ServiceTransport;
    manager: ServiceManager;
    writtenFiles: FileWrite[];
    removedFiles: string[];
    executedCommands: number;
    errors: string[];
    instructions: string[];
}
export declare function executeServiceAction(opts: ExecuteServiceActionOptions): Promise<ServiceActionReport>;
export declare function formatServiceReport(report: ServiceActionReport): string;
export interface ServiceStatusFields {
    installed: boolean;
    running?: boolean;
}
/**
 * Merge a transport's service status into an existing config.yml document.
 *
 * The config uses a `services.transports.<name>` block (per
 * ServicesLocalConfig). This re-serializes the whole document so unrelated keys
 * are preserved, existing services blocks are merged (not duplicated), and the
 * named transport entry is overwritten with the new status.
 */
export declare function updateServiceStatusYaml(existingConfig: string, transport: ServiceTransport, status: ServiceStatusFields): string;
