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

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const SERVICE_TRANSPORTS = ["gateway", "telegram", "discord", "scheduler"] as const;
export type ServiceTransport = (typeof SERVICE_TRANSPORTS)[number];

// NOTE: the internal name `ServiceTransport` / `SERVICE_TRANSPORTS` is kept for
// backward compatibility with the persisted `services.transports.*` config key
// (renaming it would break existing local configs). Despite the name, this list
// covers ALL service targets, including `scheduler`, which is a device-local
// scheduler loop and not a network transport. User-facing wording (help,
// doctor, usage errors, docs) calls these "service targets".

export const SERVICE_ACTIONS = ["install", "remove", "start", "stop", "restart", "status"] as const;
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

export function validateTransport(transport: string): ValidationResult {
  if ((SERVICE_TRANSPORTS as readonly string[]).includes(transport)) return { ok: true };
  return { ok: false, message: `Unknown service target '${transport}'. Use one of: ${SERVICE_TRANSPORTS.join(", ")}.` };
}

export function validateAction(action: string): ValidationResult {
  if ((SERVICE_ACTIONS as readonly string[]).includes(action)) return { ok: true };
  return { ok: false, message: `Unknown action '${action}'. Use one of: ${SERVICE_ACTIONS.join(", ")}.` };
}

export function unitName(transport: ServiceTransport): string {
  return `piren-${transport}.service`;
}

/**
 * Resolve the systemd user unit basename -> XDG_CONFIG_HOME path.
 * systemd reads ~/.config/systemd/user/*.service.
 */
export function systemdUnitPath(servicesDir: string, transport: ServiceTransport): string {
  // User units live in ~/.config/systemd/user/, but we keep a Piren-owned copy
  // under services/ and symlink/copy into place during install. The plan records
  // the canonical services/ path; the CLI handles the user-unit placement.
  return `${servicesDir}/${unitName(transport)}`;
}

export async function detectServiceManager(probe: ServiceManagerDetection): Promise<ServiceManager> {
  if (await probe.hasSystemdUser()) return "systemd";
  if ((await probe.hasTmux()) && (await probe.hasCrontab())) return "tmux-cron";
  return "none";
}

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

export function crontabAvailableFromInvocation(result: CrontabInvocationResult): boolean {
  if (result.signal !== null) return false;
  if (result.exitCode === null) return false;
  return result.exitCode === 0 || result.exitCode === 1;
}

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

export function systemdUserAvailableFromInvocation(result: SystemdInvocationResult): boolean {
  if (result.signal !== null) return false;
  if (result.exitCode === null) return false;
  return result.exitCode === 0 || result.exitCode === 1;
}

// ---------------------------------------------------------------------------
// Generators (pure, return string content)
// ---------------------------------------------------------------------------

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
export function targetStartCommand(
  transport: ServiceTransport,
  pirenCommand: string,
  vaultRoot: string,
  agentName: string,
): string {
  if (transport === "scheduler") {
    return `${pirenCommand} scheduler`;
  }
  return `${pirenCommand} ${transport} --vault-root ${vaultRoot} --agent ${agentName}`;
}

export interface SystemdUnitOptions extends GenerateServiceOptions {
  description: string;
}

export function generateSystemdUnit(opts: SystemdUnitOptions): string {
  const execStart = targetStartCommand(opts.transport, opts.pirenCommand, opts.vaultRoot, opts.agentName);
  return [
    "# Generated by piren service install. Edit freely; re-run install to regenerate.",
    "[Unit]",
    `Description=${opts.description}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execStart}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function generateTmuxLaunchScript(opts: GenerateServiceOptions): string {
  const sessionName = `piren-${opts.transport}`;
  const startCmd = targetStartCommand(opts.transport, opts.pirenCommand, opts.vaultRoot, opts.agentName);
  return [
    "#!/bin/sh",
    "# Generated by piren service install (tmux + @reboot cron fallback).",
    `# Starts the Piren ${opts.transport} transport in a detached tmux session.`,
    "# Re-run piren service install <transport> to regenerate.",
    "set -e",
    "",
    `SESSION="${sessionName}"`,
    "",
    "# Kill an existing session so re-running this script is idempotent.",
    `if tmux has-session -t "$SESSION" 2>/dev/null; then`,
    `  tmux kill-session -t "$SESSION"`,
    "fi",
    "",
    `tmux new-session -d -s "$SESSION" "${startCmd}"`,
    `echo "Piren ${opts.transport} started in tmux session '$SESSION'."`,
    `echo "Attach with: tmux attach -t $SESSION"`,
    "",
  ].join("\n");
}

export interface CronEntryOptions {
  transport: ServiceTransport;
  launchScriptPath: string;
}

export function generateCronEntry(opts: CronEntryOptions): string {
  // The comment must include the same launch-script path as the @reboot line.
  // The remove plan filters the crontab with `grep -v -F "${scriptPath}"`, so
  // tagging the comment ensures the WHOLE block (comment + @reboot) is stripped
  // on removal. Without this, a dangling comment survives and pollutes the
  // operator's crontab.
  return [
    `# Generated by piren service install (${opts.launchScriptPath}). Remove this line to stop auto-start on boot.`,
    `@reboot ${opts.launchScriptPath}`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Plans (pure descriptions of files + commands + instructions)
// ---------------------------------------------------------------------------

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

const TRANSPORT_DESCRIPTIONS: Record<ServiceTransport, string> = {
  gateway: "Piren gateway transport (web UI, OpenAI-compatible API)",
  telegram: "Piren Telegram transport",
  discord: "Piren Discord transport",
  scheduler: "Piren scheduler service (device-local scheduler loop)",
};

export function installPlan(opts: InstallPlanOptions): ServicePlan {
  const description = opts.description ?? TRANSPORT_DESCRIPTIONS[opts.transport];

  if (opts.manager === "systemd") {
    const unitPath = systemdUnitPath(opts.servicesDir, opts.transport);
    const unit = generateSystemdUnit({
      transport: opts.transport,
      pirenCommand: opts.pirenCommand,
      vaultRoot: opts.vaultRoot,
      agentName: opts.agentName,
      description,
    });
    const unitBase = unitName(opts.transport);
    return {
      manager: "systemd",
      files: [{ path: unitPath, content: unit }],
      commands: [
        `mkdir -p ~/.config/systemd/user`,
        `cp ${unitPath} ~/.config/systemd/user/${unitBase}`,
        `systemctl --user daemon-reload`,
        `systemctl --user enable ${unitBase}`,
        `systemctl --user start ${unitBase}`,
      ],
      instructions: [
        "systemd user units run without sudo. For the service to survive logout and",
        "start at boot, enable lingering for your user once:",
        "  loginctl enable-linger $USER",
        "",
        "Inspect logs with:",
        `  journalctl --user -u ${unitBase} -f`,
        "",
        `Generated unit file: ${unitPath}`,
      ],
    };
  }

  if (opts.manager === "tmux-cron") {
    const scriptPath = `${opts.servicesDir}/piren-${opts.transport}.tmux.sh`;
    const cronPath = `${opts.servicesDir}/piren-${opts.transport}.cron`;
    const script = generateTmuxLaunchScript({
      transport: opts.transport,
      pirenCommand: opts.pirenCommand,
      vaultRoot: opts.vaultRoot,
      agentName: opts.agentName,
    });
    const cron = generateCronEntry({ transport: opts.transport, launchScriptPath: scriptPath });
    return {
      manager: "tmux-cron",
      files: [
        { path: scriptPath, content: script, executable: true },
        { path: cronPath, content: cron },
      ],
      commands: [
        `chmod +x ${scriptPath}`,
        `${scriptPath}`,
        `( crontab -l 2>/dev/null; cat ${cronPath} ) | sort -u | crontab -`,
      ],
      instructions: [
        "tmux + @reboot cron fallback (no systemd user session required).",
        "The transport runs in a detached tmux session named 'piren-" + opts.transport + "'.",
        "Attach to it with: tmux attach -t piren-" + opts.transport,
        "",
        "To start it now, the launch script was run directly. To survive reboot, the",
        "@reboot crontab line was merged into your crontab.",
        "",
        `Launch script: ${scriptPath}`,
        `Cron fragment: ${cronPath}`,
      ],
    };
  }

  return {
    manager: "none",
    files: [],
    commands: [],
    instructions:
      opts.transport === "scheduler"
        ? [
            "No service manager detected on this system.",
            "Install systemd (and enable a user session) or tmux plus cron to use piren service.",
            "For now, run the scheduler loop manually:",
            `  ${opts.pirenCommand} scheduler`,
            "",
            "The scheduler reads local config (~/.config/piren/config.yml) for vault_root,",
            "allowed_agents, and scheduler: settings on each tick; it is not bound to one agent.",
          ]
        : [
            "No service manager detected on this system.",
            "Install systemd (and enable a user session) or tmux plus cron to use piren service.",
            "For now, run the transport manually with an initial/default agent:",
            `  ${opts.pirenCommand} ${opts.transport} --vault-root ${opts.vaultRoot} --agent ${opts.agentName}`,
            "",
            "The --agent is the initial agent the transport boots with; it is not a",
            "permanent binding. You can switch to any other runnable agent at runtime",
            "(gateway: the agent selector / POST /api/chat/switch; messaging: /agent <name>).",
          ],
  };
}

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

export function removePlan(opts: RemovePlanOptions): RemovePlan {
  if (opts.manager === "systemd") {
    const unitBase = unitName(opts.transport);
    const unitPath = systemdUnitPath(opts.servicesDir, opts.transport);
    return {
      manager: "systemd",
      commands: [
        `systemctl --user stop ${unitBase} || true`,
        `systemctl --user disable ${unitBase} || true`,
        `rm -f ~/.config/systemd/user/${unitBase}`,
        `systemctl --user daemon-reload`,
      ],
      filesToRemove: [unitPath],
      instructions: [
        "Stopped and disabled the systemd user unit, then removed it.",
        `Removed generated file: ${unitPath}`,
      ],
    };
  }

  if (opts.manager === "tmux-cron") {
    const scriptPath = `${opts.servicesDir}/piren-${opts.transport}.tmux.sh`;
    const cronPath = `${opts.servicesDir}/piren-${opts.transport}.cron`;
    return {
      manager: "tmux-cron",
      commands: [
        `tmux kill-session -t piren-${opts.transport} 2>/dev/null || true`,
        `crontab -l 2>/dev/null | grep -v -F "${scriptPath}" | crontab - || true`,
      ],
      filesToRemove: [scriptPath, cronPath],
      instructions: [
        "Killed the tmux session and removed the @reboot crontab line.",
        "If you had other crontab entries, verify your crontab with: crontab -l",
        `Removed generated files: ${scriptPath}, ${cronPath}`,
      ],
    };
  }

  return {
    manager: "none",
    commands: [],
    filesToRemove: [],
    instructions: [
      "No service manager detected; nothing installed to remove.",
      `If a tmux session is running, stop it with: tmux kill-session -t piren-${opts.transport}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Simple control actions (start/stop/restart/status) for an already-installed service
// ---------------------------------------------------------------------------

export function controlCommands(action: "start" | "stop" | "restart" | "status", transport: ServiceTransport, manager: ServiceManager): string[] {
  const unitBase = unitName(transport);
  if (manager === "systemd") {
    if (action === "status") return [`systemctl --user status ${unitBase}`, `journalctl --user -u ${unitBase} --no-pager -n 50`];
    return [`systemctl --user ${action} ${unitBase}`];
  }
  if (manager === "tmux-cron") {
    const scriptPath = `~/.config/piren/services/piren-${transport}.tmux.sh`;
    if (action === "start") return [`${scriptPath}`];
    if (action === "stop") return [`tmux kill-session -t piren-${transport} 2>/dev/null || true`];
    if (action === "restart") return [`tmux kill-session -t piren-${transport} 2>/dev/null || true`, `${scriptPath}`];
    return [`tmux has-session -t piren-${transport} 2>/dev/null && echo "running" || echo "not running"`];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Execution layer (orchestration with injected deps)
// ---------------------------------------------------------------------------

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ServiceExecDeps {
  writeFile: (path: string, content: string, opts?: { executable?: boolean }) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  runCommand: (command: string) => Promise<CommandResult>;
  log: (message: string) => void;
}

export interface ResolvePirenCommandOptions {
  /** Explicit override (e.g. process.argv[1] when running the real binary). */
  explicit?: string | undefined;
}

export function resolvePirenCommand(opts: ResolvePirenCommandOptions = {}): string {
  const explicit = opts.explicit?.trim();
  if (!explicit) return "piren";
  // When the explicit path is a JavaScript entry point (running from source or
  // dist via `node dist/src/cli.js`), systemd's ExecStart cannot execute it
  // directly and fails with 203/EXEC. Prepend `node` so the unit is runnable.
  if (explicit.endsWith(".js") || explicit.endsWith(".mjs")) {
    return `node ${explicit}`;
  }
  return explicit;
}

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

export async function executeServiceAction(opts: ExecuteServiceActionOptions): Promise<ServiceActionReport> {
  const errors: string[] = [];
  const writtenFiles: FileWrite[] = [];
  const removedFiles: string[] = [];
  let executedCommands = 0;
  const instructions: string[] = [];

  if (opts.action === "install") {
    const plan = installPlan({
      transport: opts.transport,
      manager: opts.manager,
      pirenCommand: opts.pirenCommand,
      vaultRoot: opts.vaultRoot,
      agentName: opts.agentName,
      servicesDir: opts.servicesDir,
    });
    instructions.push(...plan.instructions);
    for (const file of plan.files) {
      try {
        if (file.executable === true) {
          await opts.deps.writeFile(file.path, file.content, { executable: true });
        } else {
          await opts.deps.writeFile(file.path, file.content);
        }
        writtenFiles.push(file);
        opts.deps.log(`Wrote ${file.path}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${file.path}: ${message}`);
      }
    }
    for (const command of plan.commands) {
      try {
        const result = await opts.deps.runCommand(command);
        executedCommands += 1;
        opts.deps.log(`$ ${command}`);
        if (result.stderr && result.stderr.trim() !== "") opts.deps.log(result.stderr);
        if (result.exitCode !== 0 && !command.includes("|| true")) {
          errors.push(`${command} (exit ${result.exitCode}): ${result.stderr || result.stdout}`.trim());
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${command}: ${message}`);
      }
    }
  } else if (opts.action === "remove") {
    const plan = removePlan({ transport: opts.transport, manager: opts.manager, servicesDir: opts.servicesDir });
    instructions.push(...plan.instructions);
    for (const command of plan.commands) {
      try {
        const result = await opts.deps.runCommand(command);
        executedCommands += 1;
        opts.deps.log(`$ ${command}`);
        if (result.stderr && result.stderr.trim() !== "") opts.deps.log(result.stderr);
        if (result.exitCode !== 0 && !command.includes("|| true")) {
          errors.push(`${command} (exit ${result.exitCode}): ${result.stderr || result.stdout}`.trim());
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${command}: ${message}`);
      }
    }
    for (const file of plan.filesToRemove) {
      try {
        await opts.deps.removeFile(file);
        removedFiles.push(file);
        opts.deps.log(`Removed ${file}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${file}: ${message}`);
      }
    }
  } else {
    // start/stop/restart/status: run control commands, no files.
    const commands = controlCommands(opts.action, opts.transport, opts.manager);
    for (const command of commands) {
      try {
        const result = await opts.deps.runCommand(command);
        executedCommands += 1;
        opts.deps.log(`$ ${command}`);
        if (result.stdout && result.stdout.trim() !== "") opts.deps.log(result.stdout);
        if (result.stderr && result.stderr.trim() !== "") opts.deps.log(result.stderr);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${command}: ${message}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    action: opts.action,
    transport: opts.transport,
    manager: opts.manager,
    writtenFiles,
    removedFiles,
    executedCommands,
    errors,
    instructions,
  };
}

export function formatServiceReport(report: ServiceActionReport): string {
  const lines: string[] = [];
  lines.push(`Piren service ${report.action} ${report.transport} (${report.manager})`);
  lines.push("");
  if (report.writtenFiles.length > 0) {
    lines.push("Generated files:");
    for (const f of report.writtenFiles) lines.push(`  ${f.path}`);
    lines.push("");
  }
  if (report.removedFiles.length > 0) {
    lines.push("Removed files:");
    for (const f of report.removedFiles) lines.push(`  ${f}`);
    lines.push("");
  }
  if (report.executedCommands > 0) {
    lines.push(`Executed ${report.executedCommands} command(s).`);
    lines.push("");
  }
  if (report.errors.length > 0) {
    lines.push("Errors:");
    for (const e of report.errors) lines.push(`  ${e}`);
    lines.push("");
  }
  if (report.instructions.length > 0) {
    lines.push("Notes:");
    for (const i of report.instructions) lines.push(`  ${i}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Config writeback: record service install/remove status into local config.yml
// ---------------------------------------------------------------------------

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
export function updateServiceStatusYaml(existingConfig: string, transport: ServiceTransport, status: ServiceStatusFields): string {
  const trimmed = existingConfig.trim();
  const parsed = trimmed === "" ? {} : (parseYaml(trimmed) as Record<string, unknown> | null) ?? {};
  const root = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const services = (root.services && typeof root.services === "object" ? root.services : {}) as Record<string, unknown>;
  const transports = (services.transports && typeof services.transports === "object" ? services.transports : {}) as Record<string, unknown>;

  const entry: Record<string, boolean> = { installed: status.installed };
  if (status.running !== undefined) entry.running = status.running;
  transports[transport] = entry;
  services.transports = transports;
  root.services = services;

  return stringifyYaml(root);
}
