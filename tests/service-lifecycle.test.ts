import { describe, expect, it } from "vitest";
import {
  SERVICE_TRANSPORTS,
  SERVICE_ACTIONS,
  detectServiceManager,
  crontabAvailableFromInvocation,
  systemdUserAvailableFromInvocation,
  resolvePirenCommand,
  generateSystemdUnit,
  generateTmuxLaunchScript,
  generateCronEntry,
  installPlan,
  removePlan,
  controlCommands,
  unitName,
  validateTransport,
  validateAction,
  type ServiceManagerDetection,
} from "../src/service-lifecycle.js";

describe("service-lifecycle: constants and validation", () => {
  it("supports the three transport targets", () => {
    expect(SERVICE_TRANSPORTS).toContain("gateway");
    expect(SERVICE_TRANSPORTS).toContain("telegram");
    expect(SERVICE_TRANSPORTS).toContain("discord");
  });

  it("supports install/remove/start/stop/restart/status actions", () => {
    expect(SERVICE_ACTIONS).toContain("install");
    expect(SERVICE_ACTIONS).toContain("remove");
    expect(SERVICE_ACTIONS).toContain("start");
    expect(SERVICE_ACTIONS).toContain("stop");
    expect(SERVICE_ACTIONS).toContain("restart");
    expect(SERVICE_ACTIONS).toContain("status");
  });

  it("validateTransport accepts known transports and rejects others", () => {
    expect(validateTransport("gateway").ok).toBe(true);
    expect(validateTransport("bogus").ok).toBe(false);
  });

  it("validateAction accepts known actions and rejects others", () => {
    expect(validateAction("install").ok).toBe(true);
    expect(validateAction("bogus").ok).toBe(false);
  });
});

describe("service-lifecycle: unit naming", () => {
  it("names the systemd user unit piren-<transport>.service", () => {
    expect(unitName("gateway")).toBe("piren-gateway.service");
    expect(unitName("telegram")).toBe("piren-telegram.service");
  });
});

describe("service-lifecycle: manager detection", () => {
  it("prefers systemd when systemctl --user is available", async () => {
    const probe: ServiceManagerDetection = {
      hasSystemdUser: async () => true,
      hasTmux: async () => true,
      hasCrontab: async () => true,
    };
    expect(await detectServiceManager(probe)).toBe("systemd");
  });

  it("falls back to tmux-cron when tmux and crontab exist but systemd does not", async () => {
    const probe: ServiceManagerDetection = {
      hasSystemdUser: async () => false,
      hasTmux: async () => true,
      hasCrontab: async () => true,
    };
    expect(await detectServiceManager(probe)).toBe("tmux-cron");
  });

  it("returns none when neither systemd nor the tmux+cron pair is fully available", async () => {
    const probe: ServiceManagerDetection = {
      hasSystemdUser: async () => false,
      hasTmux: async () => true,
      hasCrontab: async () => false,
    };
    expect(await detectServiceManager(probe)).toBe("none");
  });

  it("returns none when nothing is available", async () => {
    const probe: ServiceManagerDetection = {
      hasSystemdUser: async () => false,
      hasTmux: async () => false,
      hasCrontab: async () => false,
    };
    expect(await detectServiceManager(probe)).toBe("none");
  });
});

describe("service-lifecycle: crontab detection (DietPi / vixie cron)", () => {
  // crontab -l exits 1 specifically when the user has NO crontab yet, even
  // though cron is installed and running. This is the DietPi failure: a system
  // with tmux + cron (but no user crontab yet) was detected as "none".
  it("treats 'no crontab for user' (exit 1) as available", () => {
    expect(crontabAvailableFromInvocation({ exitCode: 1, signal: null })).toBe(true);
  });

  it("treats a successful listing (exit 0) as available", () => {
    expect(crontabAvailableFromInvocation({ exitCode: 0, signal: null })).toBe(true);
  });

  it("treats crontab not found / hard errors (exit >= 2) as unavailable", () => {
    expect(crontabAvailableFromInvocation({ exitCode: 2, signal: null })).toBe(false);
    expect(crontabAvailableFromInvocation({ exitCode: 127, signal: null })).toBe(false);
  });

  it("treats a killed process (signal) as unavailable", () => {
    expect(crontabAvailableFromInvocation({ exitCode: null, signal: "SIGTERM" })).toBe(false);
  });
});

describe("service-lifecycle: systemd user detection (degraded session)", () => {
  // `systemctl --user is-system-running` exits 1 with "degraded" when the user
  // session is degraded (a unit failed but the session itself runs services).
  // A bare exit-0 check reads that as "systemd not available" and breaks
  // service install on systems whose user session is merely degraded.
  it("treats 'degraded' (exit 1) as available", () => {
    expect(systemdUserAvailableFromInvocation({ exitCode: 1, signal: null })).toBe(true);
  });

  it("treats 'running' (exit 0) as available", () => {
    expect(systemdUserAvailableFromInvocation({ exitCode: 0, signal: null })).toBe(true);
  });

  it("treats 'starting' (exit 1) as available", () => {
    expect(systemdUserAvailableFromInvocation({ exitCode: 1, signal: null })).toBe(true);
  });

  it("treats hard failures (exit >= 2) as unavailable", () => {
    expect(systemdUserAvailableFromInvocation({ exitCode: 2, signal: null })).toBe(false);
    expect(systemdUserAvailableFromInvocation({ exitCode: 127, signal: null })).toBe(false);
  });

  it("treats a killed process (signal) as unavailable", () => {
    expect(systemdUserAvailableFromInvocation({ exitCode: null, signal: "SIGTERM" })).toBe(false);
  });
});

describe("service-lifecycle: resolvePirenCommand", () => {
  // When Piren is run from source or dist via `node dist/src/cli.js`,
  // process.argv[1] is a .js file path. systemd's ExecStart cannot execute a
  // .js file directly (it fails with 203/EXEC), so the resolved command must
  // prepend `node` when the explicit path is a JS entry point.
  it("prepends node when the explicit path is a .js file", () => {
    expect(resolvePirenCommand({ explicit: "/home/davide/src/piren/dist/src/cli.js" })).toBe(
      "node /home/davide/src/piren/dist/src/cli.js",
    );
  });

  it("prepends node when the explicit path is an .mjs file", () => {
    expect(resolvePirenCommand({ explicit: "/opt/piren/cli.mjs" })).toBe("node /opt/piren/cli.mjs");
  });

  it("returns the binary name verbatim when it is not a JS file", () => {
    expect(resolvePirenCommand({ explicit: "/usr/local/bin/piren" })).toBe("/usr/local/bin/piren");
  });

  it("defaults to 'piren' when no explicit path is given", () => {
    expect(resolvePirenCommand({})).toBe("piren");
  });

  it("defaults to 'piren' when the explicit path is empty", () => {
    expect(resolvePirenCommand({ explicit: "" })).toBe("piren");
    expect(resolvePirenCommand({ explicit: "   " })).toBe("piren");
  });
});

describe("service-lifecycle: systemd unit generation", () => {
  const opts = {
    transport: "gateway" as const,
    pirenCommand: "/usr/local/bin/piren",
    vaultRoot: "/home/davide/vault",
    agentName: "piren",
    description: "Piren gateway transport",
  };

  it("generates a user unit (not a system unit)", () => {
    const unit = generateSystemdUnit(opts);
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("Description=Piren gateway transport");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("runs the piren gateway command with resolved vault and agent", () => {
    const unit = generateSystemdUnit(opts);
    expect(unit).toContain("ExecStart=/usr/local/bin/piren gateway --vault-root /home/davide/vault --agent piren");
  });

  it("restarts on failure and sets a sane restart delay", () => {
    const unit = generateSystemdUnit(opts);
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=5");
  });

  it("uses simple type with notify off so non-systemd-aware binaries work", () => {
    const unit = generateSystemdUnit(opts);
    expect(unit).toContain("Type=simple");
  });
});

describe("service-lifecycle: tmux launch script generation", () => {
  const opts = {
    transport: "telegram" as const,
    pirenCommand: "piren",
    vaultRoot: "/srv/vault",
    agentName: "thor",
  };

  it("generates a tmux new-session for the piren transport", () => {
    const script = generateTmuxLaunchScript(opts);
    expect(script).toContain("tmux");
    expect(script).toContain("new-session");
    expect(script).toContain("piren-telegram");
    expect(script).toContain("piren telegram --vault-root /srv/vault --agent thor");
  });

  it("is idempotent: kills an existing session before starting", () => {
    const script = generateTmuxLaunchScript(opts);
    expect(script).toContain("has-session");
    expect(script.toLowerCase()).toMatch(/kill-session|kill-session/);
  });

  it("starts the session detached", () => {
    const script = generateTmuxLaunchScript(opts);
    expect(script).toContain("-d");
  });
});

describe("service-lifecycle: cron entry generation", () => {
  const opts = {
    transport: "discord" as const,
    launchScriptPath: "/home/davide/.config/piren/services/piren-discord.tmux.sh",
  };

  it("generates an @reboot line that runs the launch script", () => {
    const entry = generateCronEntry(opts);
    expect(entry).toContain("@reboot");
    expect(entry).toContain("/home/davide/.config/piren/services/piren-discord.tmux.sh");
  });

  it("tags the comment with the script path so removal can grep the whole block out", () => {
    // The remove plan filters the crontab with `grep -v -F "${scriptPath}"`. If
    // only the @reboot line carries the path, the comment line survives removal
    // and a dangling "# Generated by piren service install..." stays behind.
    // The comment must reference the same path so the whole block is stripped.
    const entry = generateCronEntry(opts);
    expect(entry).toMatch(/#/); // is a comment-bearing entry
    // Every non-empty line must contain the script path OR be the @reboot line.
    const lines = entry.split("\n").filter((l) => l.trim() !== "");
    for (const line of lines) {
      expect(line).toContain("/home/davide/.config/piren/services/piren-discord.tmux.sh");
    }
  });
});

describe("service-lifecycle: install plan", () => {
  const base = {
    transport: "gateway" as const,
    pirenCommand: "piren",
    vaultRoot: "/vault",
    agentName: "piren",
    servicesDir: "/home/davide/.config/piren/services",
  };

  it("plans a systemd install: write unit, enable, start, with exact paths and commands", () => {
    const plan = installPlan({ ...base, manager: "systemd" });
    expect(plan.manager).toBe("systemd");
    const paths = plan.files.map((f) => f.path);
    expect(paths).toContain("/home/davide/.config/piren/services/piren-gateway.service");
    expect(plan.commands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("systemctl --user enable piren-gateway.service"),
        expect.stringContaining("systemctl --user start piren-gateway.service"),
      ]),
    );
    // lingering hint is part of the instructions, not a command
    expect(plan.instructions.join("\n")).toMatch(/linger|loginctl enable-linger/i);
  });

  it("plans a tmux-cron install: write launch script + cron fragment, show install command", () => {
    const plan = installPlan({ ...base, manager: "tmux-cron" });
    expect(plan.manager).toBe("tmux-cron");
    const paths = plan.files.map((f) => f.path);
    expect(paths).toContain("/home/davide/.config/piren/services/piren-gateway.tmux.sh");
    expect(paths).toContain("/home/davide/.config/piren/services/piren-gateway.cron");
    expect(plan.commands.some((c) => c.includes("crontab"))).toBe(true);
  });

  it("plans none as guidance only: no files, no commands, clear instructions", () => {
    const plan = installPlan({ ...base, manager: "none" });
    expect(plan.files).toEqual([]);
    expect(plan.commands).toEqual([]);
    expect(plan.instructions.join("\n")).toMatch(/no service manager|systemd|tmux/i);
  });

  it("none-fallback clarifies the --agent is the initial/default agent, switchable at runtime", () => {
    const plan = installPlan({ ...base, manager: "none" });
    const text = plan.instructions.join("\n");
    expect(text).toMatch(/initial|default/i);
    expect(text).toMatch(/switch/i);
  });
});

describe("service-lifecycle: remove plan", () => {
  const base = {
    transport: "gateway" as const,
    servicesDir: "/home/davide/.config/piren/services",
  };

  it("plans a systemd remove: stop, disable, delete unit", () => {
    const plan = removePlan({ ...base, manager: "systemd" });
    expect(plan.commands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("systemctl --user stop piren-gateway.service"),
        expect.stringContaining("systemctl --user disable piren-gateway.service"),
      ]),
    );
    expect(plan.filesToRemove).toContain("/home/davide/.config/piren/services/piren-gateway.service");
  });

  it("plans a tmux-cron remove: kill tmux session, remove files, show crontab edit hint", () => {
    const plan = removePlan({ ...base, manager: "tmux-cron" });
    expect(plan.commands.some((c) => c.includes("tmux kill-session"))).toBe(true);
    expect(plan.filesToRemove).toContain("/home/davide/.config/piren/services/piren-gateway.tmux.sh");
    expect(plan.filesToRemove).toContain("/home/davide/.config/piren/services/piren-gateway.cron");
    expect(plan.instructions.join("\n")).toMatch(/crontab|@reboot/i);
  });
});

// ---------------------------------------------------------------------------
// Scheduler service target (O7 S6)
// ---------------------------------------------------------------------------
//
// The scheduler is a service target like gateway/telegram/discord, but its
// generated command launches the S5 loop (`piren scheduler`) WITHOUT binding
// to a single agent: the loop reads local config (allowed_agents minus
// excluded_agents) on each tick. Internal type names still say `ServiceTransport`
// for backward compatibility with the persisted `services.transports.*` config
// key; user-facing wording calls these "service targets".

describe("service-lifecycle: scheduler target validation", () => {
  it("includes scheduler in the supported service targets", () => {
    expect(SERVICE_TRANSPORTS).toContain("scheduler");
  });

  it("validates scheduler as an accepted service target", () => {
    expect(validateTransport("scheduler").ok).toBe(true);
  });

  it("lists scheduler alongside the other valid targets in the rejection message", () => {
    const result = validateTransport("bogus");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("scheduler");
    expect(result.message).toContain("gateway");
  });

  it("names the scheduler systemd unit piren-scheduler.service", () => {
    expect(unitName("scheduler")).toBe("piren-scheduler.service");
  });
});

describe("service-lifecycle: scheduler command generation (no agent binding)", () => {
  const opts = {
    transport: "scheduler" as const,
    pirenCommand: "node /home/davide/src/piren/dist/src/cli.js",
    vaultRoot: "/home/davide/vault",
    agentName: "piren",
    description: "Piren scheduler service",
  };

  it("generates a systemd unit whose ExecStart is just `<resolved piren command> scheduler` with no --vault-root/--agent", () => {
    const unit = generateSystemdUnit(opts);
    expect(unit).toContain("ExecStart=node /home/davide/src/piren/dist/src/cli.js scheduler");
    expect(unit).not.toContain("--vault-root");
    expect(unit).not.toContain("--agent");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("Restart=on-failure");
  });

  it("generates a tmux launch script that starts `<resolved piren command> scheduler` with no agent binding", () => {
    const script = generateTmuxLaunchScript(opts);
    expect(script).toContain("piren-scheduler");
    expect(script).toContain("node /home/davide/src/piren/dist/src/cli.js scheduler");
    expect(script).not.toContain("--vault-root");
    expect(script).not.toContain("--agent");
    expect(script).toContain("new-session");
    expect(script).toContain("-d");
  });
});

describe("service-lifecycle: scheduler install plan", () => {
  const base = {
    transport: "scheduler" as const,
    pirenCommand: "piren",
    vaultRoot: "/vault",
    agentName: "piren",
    servicesDir: "/home/davide/.config/piren/services",
  };

  it("plans a systemd install that writes piren-scheduler.service and enables/starts it", () => {
    const plan = installPlan({ ...base, manager: "systemd" });
    expect(plan.manager).toBe("systemd");
    const paths = plan.files.map((f) => f.path);
    expect(paths).toContain("/home/davide/.config/piren/services/piren-scheduler.service");
    expect(plan.commands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("systemctl --user enable piren-scheduler.service"),
        expect.stringContaining("systemctl --user start piren-scheduler.service"),
      ]),
    );
    // The generated unit must launch the bare scheduler loop, not bind an agent.
    expect(plan.files[0]!.content).toContain("ExecStart=piren scheduler");
    expect(plan.files[0]!.content).not.toContain("--agent");
  });

  it("plans a tmux-cron install that writes the scheduler tmux script and cron fragment", () => {
    const plan = installPlan({ ...base, manager: "tmux-cron" });
    expect(plan.manager).toBe("tmux-cron");
    const paths = plan.files.map((f) => f.path);
    expect(paths).toContain("/home/davide/.config/piren/services/piren-scheduler.tmux.sh");
    expect(paths).toContain("/home/davide/.config/piren/services/piren-scheduler.cron");
    expect(plan.files.find((f) => f.path.endsWith(".tmux.sh"))!.executable).toBe(true);
    expect(plan.files.find((f) => f.path.endsWith(".tmux.sh"))!.content).toContain("piren scheduler");
    expect(plan.files.find((f) => f.path.endsWith(".tmux.sh"))!.content).not.toContain("--agent");
  });

  it("plans none as guidance that runs `piren scheduler` manually with no agent binding", () => {
    const plan = installPlan({ ...base, manager: "none" });
    expect(plan.files).toEqual([]);
    expect(plan.commands).toEqual([]);
    const text = plan.instructions.join("\n");
    expect(text).toContain("piren scheduler");
    expect(text).not.toContain("--agent");
  });
});

describe("service-lifecycle: scheduler remove/control", () => {
  const base = {
    transport: "scheduler" as const,
    servicesDir: "/home/davide/.config/piren/services",
  };

  it("plans a systemd remove that targets piren-scheduler.service", () => {
    const plan = removePlan({ ...base, manager: "systemd" });
    expect(plan.commands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("systemctl --user stop piren-scheduler.service"),
        expect.stringContaining("systemctl --user disable piren-scheduler.service"),
      ]),
    );
    expect(plan.filesToRemove).toContain("/home/davide/.config/piren/services/piren-scheduler.service");
  });

  it("plans a tmux-cron remove that kills the piren-scheduler session and removes its files", () => {
    const plan = removePlan({ ...base, manager: "tmux-cron" });
    expect(plan.commands.some((c) => c.includes("tmux kill-session -t piren-scheduler"))).toBe(true);
    expect(plan.filesToRemove).toContain("/home/davide/.config/piren/services/piren-scheduler.tmux.sh");
    expect(plan.filesToRemove).toContain("/home/davide/.config/piren/services/piren-scheduler.cron");
  });

  it("control commands target the piren-scheduler unit (systemd) and session (tmux)", () => {
    expect(controlCommands("start", "scheduler", "systemd")).toContain("systemctl --user start piren-scheduler.service");
    expect(controlCommands("stop", "scheduler", "tmux-cron")).toContain("tmux kill-session -t piren-scheduler 2>/dev/null || true");
    expect(controlCommands("restart", "scheduler", "tmux-cron")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("tmux kill-session -t piren-scheduler"),
        expect.stringContaining("piren-scheduler.tmux.sh"),
      ]),
    );
    expect(controlCommands("status", "scheduler", "systemd")).toContain("systemctl --user status piren-scheduler.service");
  });
});
