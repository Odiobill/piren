import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLocalServiceObservationDeps,
  observeServiceStatus,
  SERVICE_OBSERVATION_TARGETS,
  type CommandRunResult,
  type ServiceObservationDeps,
} from "../src/service-observability.js";

/**
 * ADR-0044 / D2.1 — pure local service-observation core (accepted contract:
 * Projects/Piren/workbench-dashboard-service-observability-contract.md).
 *
 * The core observes ONLY the fixed non-gateway targets telegram, discord,
 * scheduler (fixed order) through the existing supported-manager precedence
 * (usable systemd user manager, then usable tmux+crontab, otherwise
 * unavailable). Every probe error, timeout, malformed result, or race fails
 * safely to `unknown`; an unavailable manager yields `unavailable`, never a
 * fabricated inactive. The core is read-only: no control action, no shell,
 * no caller-controlled target/command/path/manager/timeout, and no raw
 * diagnostics in the snapshot.
 */

function makeDeps(overrides: Partial<ServiceObservationDeps> = {}): ServiceObservationDeps {
  return {
    hasSystemdUser: async () => false,
    hasTmux: async () => false,
    hasCrontab: async () => false,
    run: async () => ({ exitCode: null, signal: null, stdout: "" }),
    artifactExists: async () => false,
    now: () => new Date("2026-08-16T11:20:00.000Z"),
    // Default: the timeout never fires; individual tests arm it.
    timeoutAfter: () => new Promise<never>(() => {}),
    ...overrides,
  };
}

function runResult(partial: Partial<CommandRunResult>): CommandRunResult {
  return { exitCode: 0, signal: null, stdout: "", ...partial };
}

describe("D2.1 manager precedence and fixed commands", () => {
  it("prefers a usable systemd user manager over tmux-cron", async () => {
    const argv: string[][] = [];
    const snapshot = await observeServiceStatus(
      makeDeps({
        hasSystemdUser: async () => true,
        hasTmux: async () => true,
        hasCrontab: async () => true,
        artifactExists: async () => true,
        run: async (args) => {
          argv.push([...args]);
          return runResult({ exitCode: 0, stdout: "active\n" });
        },
      }),
    );
    expect(snapshot.manager).toBe("systemd-user");
    // Only fixed systemctl argument arrays ran — one per target, no shell.
    expect(argv).toEqual([
      ["systemctl", "--user", "is-active", "piren-telegram.service"],
      ["systemctl", "--user", "is-active", "piren-discord.service"],
      ["systemctl", "--user", "is-active", "piren-scheduler.service"],
    ]);
  });

  it("falls back to tmux-cron only when systemd user is unusable and both tmux and crontab are usable", async () => {
    const argv: string[][] = [];
    const snapshot = await observeServiceStatus(
      makeDeps({
        hasSystemdUser: async () => false,
        hasTmux: async () => true,
        hasCrontab: async () => true,
        artifactExists: async () => true,
        run: async (args) => {
          argv.push([...args]);
          return runResult({ exitCode: 0 });
        },
      }),
    );
    expect(snapshot.manager).toBe("tmux-cron");
    expect(argv).toEqual([
      ["tmux", "has-session", "-t", "piren-telegram"],
      ["tmux", "has-session", "-t", "piren-discord"],
      ["tmux", "has-session", "-t", "piren-scheduler"],
    ]);
  });

  it("reports unavailable when tmux exists without crontab", async () => {
    const snapshot = await observeServiceStatus(makeDeps({ hasTmux: async () => true }));
    expect(snapshot.manager).toBe("unavailable");
    expect(snapshot.targets.every((t) => t.state === "unavailable")).toBe(true);
  });

  it("fails safe to unavailable when a manager-availability probe throws", async () => {
    const snapshot = await observeServiceStatus(
      makeDeps({
        hasSystemdUser: async () => {
          throw new Error("dbus exploded");
        },
      }),
    );
    expect(snapshot.manager).toBe("unavailable");
    expect(snapshot.targets.every((t) => t.state === "unavailable")).toBe(true);
  });
});

describe("D2.1 systemd-user state meanings and fail-safe behavior", () => {
  const systemdUp: Partial<ServiceObservationDeps> = { hasSystemdUser: async () => true };

  it("absent fixed unit artifact means not-installed and no probe runs", async () => {
    let runs = 0;
    const snapshot = await observeServiceStatus(
      makeDeps({
        ...systemdUp,
        artifactExists: async (artifact, target) => {
          expect(artifact).toBe("systemd-unit");
          return target !== "discord";
        },
        run: async () => {
          runs += 1;
          return runResult({ exitCode: 0, stdout: "active\n" });
        },
      }),
    );
    expect(snapshot.targets).toEqual([
      { target: "telegram", state: "active" },
      { target: "discord", state: "not-installed" },
      { target: "scheduler", state: "active" },
    ]);
    // The not-installed target was never probed.
    expect(runs).toBe(2);
  });

  it("maps only the literal manager words: active -> active, inactive -> inactive", async () => {
    const snapshot = await observeServiceStatus(
      makeDeps({
        ...systemdUp,
        artifactExists: async () => true,
        run: async (argv) => {
          if (argv.includes("piren-telegram.service")) return runResult({ exitCode: 0, stdout: "active\n" });
          if (argv.includes("piren-discord.service")) return runResult({ exitCode: 3, stdout: "inactive\n" });
          return runResult({ exitCode: 0, stdout: "active\n" });
        },
      }),
    );
    expect(snapshot.targets[0]?.state).toBe("active");
    expect(snapshot.targets[1]?.state).toBe("inactive");
    expect(snapshot.targets[2]?.state).toBe("active");
  });

  it("never infers inactive from 'failed', empty, or malformed output — those are unknown", async () => {
    const snapshot = await observeServiceStatus(
      makeDeps({
        ...systemdUp,
        artifactExists: async () => true,
        run: async (argv) => {
          if (argv.includes("piren-telegram.service")) return runResult({ exitCode: 3, stdout: "failed\n" });
          if (argv.includes("piren-discord.service")) return runResult({ exitCode: 0, stdout: "" });
          return runResult({ exitCode: 4, stdout: "unknown\n" });
        },
      }),
    );
    expect(snapshot.targets.map((t) => t.state)).toEqual(["unknown", "unknown", "unknown"]);
    expect(JSON.stringify(snapshot)).not.toContain("inactive");
  });

  it("a signal or missing exit code is unknown, never a guessed state", async () => {
    const snapshot = await observeServiceStatus(
      makeDeps({
        ...systemdUp,
        artifactExists: async () => true,
        run: async (argv) =>
          argv.includes("piren-telegram.service")
            ? runResult({ exitCode: null, signal: "SIGTERM", stdout: "active\n" })
            : runResult({ exitCode: 0, stdout: "active\n" }),
      }),
    );
    expect(snapshot.targets[0]?.state).toBe("unknown");
    expect(snapshot.targets[1]?.state).toBe("active");
  });

  it("a throwing probe fails only its own target to unknown — per-target failure isolation", async () => {
    const snapshot = await observeServiceStatus(
      makeDeps({
        ...systemdUp,
        artifactExists: async () => true,
        run: async (argv) => {
          if (argv.includes("piren-discord.service")) throw new Error("probe exploded");
          return runResult({ exitCode: 0, stdout: "active\n" });
        },
      }),
    );
    expect(snapshot.manager).toBe("systemd-user");
    expect(snapshot.targets.map((t) => t.state)).toEqual(["active", "unknown", "active"]);
  });

  it("a throwing artifact check fails only its own target to unknown", async () => {
    const snapshot = await observeServiceStatus(
      makeDeps({
        ...systemdUp,
        artifactExists: async (_artifact, target) => {
          if (target === "scheduler") throw new Error("fs race");
          return true;
        },
        run: async () => runResult({ exitCode: 0, stdout: "active\n" }),
      }),
    );
    expect(snapshot.targets.map((t) => t.state)).toEqual(["active", "active", "unknown"]);
  });

  it("a probe that loses the fixed timeout race is unknown", async () => {
    const snapshot = await observeServiceStatus(
      makeDeps({
        ...systemdUp,
        artifactExists: async () => true,
        run: async (argv) => {
          if (argv.includes("piren-telegram.service")) return new Promise<CommandRunResult>(() => {}); // hangs
          return runResult({ exitCode: 0, stdout: "active\n" });
        },
        timeoutAfter: async () => {
          throw new Error("timed out");
        },
      }),
    );
    expect(snapshot.targets.map((t) => t.state)).toEqual(["unknown", "active", "active"]);
  });
});

describe("D2.1 tmux-cron state meanings and fail-safe behavior", () => {
  const tmuxUp: Partial<ServiceObservationDeps> = {
    hasSystemdUser: async () => false,
    hasTmux: async () => true,
    hasCrontab: async () => true,
  };

  it("absent fixed launch artifact means not-installed and no tmux probe runs", async () => {
    let runs = 0;
    const snapshot = await observeServiceStatus(
      makeDeps({
        ...tmuxUp,
        artifactExists: async (artifact, target) => {
          expect(artifact).toBe("tmux-launch-script");
          return target === "telegram";
        },
        run: async () => {
          runs += 1;
          return runResult({ exitCode: 0 });
        },
      }),
    );
    expect(snapshot.manager).toBe("tmux-cron");
    expect(snapshot.targets).toEqual([
      { target: "telegram", state: "active" },
      { target: "discord", state: "not-installed" },
      { target: "scheduler", state: "not-installed" },
    ]);
    expect(runs).toBe(1);
  });

  it("maps exit 0 -> active and exit 1 (no such session) -> inactive", async () => {
    const snapshot = await observeServiceStatus(
      makeDeps({
        ...tmuxUp,
        artifactExists: async () => true,
        run: async (argv) => (argv.includes("piren-discord") ? runResult({ exitCode: 1 }) : runResult({ exitCode: 0 })),
      }),
    );
    expect(snapshot.targets.map((t) => t.state)).toEqual(["active", "inactive", "active"]);
  });

  it("any other exit, a signal, or a probe error is unknown — never inferred inactive", async () => {
    const snapshot = await observeServiceStatus(
      makeDeps({
        ...tmuxUp,
        artifactExists: async () => true,
        run: async (argv) => {
          if (argv.includes("piren-telegram")) return runResult({ exitCode: 2 });
          if (argv.includes("piren-discord")) return runResult({ exitCode: null, signal: "SIGKILL" });
          throw new Error("tmux server gone");
        },
      }),
    );
    expect(snapshot.targets.map((t) => t.state)).toEqual(["unknown", "unknown", "unknown"]);
    expect(JSON.stringify(snapshot)).not.toContain("inactive");
  });
});

describe("D2.1 production seam factory", () => {
  it("maps fixed artifact kinds to Piren-owned paths only, under the given home", async () => {
    const home = await mkdtemp(join(tmpdir(), "piren-d21-"));
    try {
      const deps = createLocalServiceObservationDeps(home);
      // Nothing installed: both kinds absent.
      expect(await deps.artifactExists("systemd-unit", "telegram")).toBe(false);
      expect(await deps.artifactExists("tmux-launch-script", "scheduler")).toBe(false);
      // Create the fixed artifacts and observe them found.
      await mkdir(join(home, ".config", "systemd", "user"), { recursive: true });
      await mkdir(join(home, ".config", "piren", "services"), { recursive: true });
      await writeFile(join(home, ".config", "systemd", "user", "piren-telegram.service"), "[Unit]\n");
      await writeFile(join(home, ".config", "piren", "services", "piren-scheduler.tmux.sh"), "#!/bin/sh\n");
      expect(await deps.artifactExists("systemd-unit", "telegram")).toBe(true);
      expect(await deps.artifactExists("tmux-launch-script", "scheduler")).toBe(true);
      // A differently named artifact is invisible to the fixed mapping.
      await writeFile(join(home, ".config", "systemd", "user", "other.service"), "[Unit]\n");
      expect(await deps.artifactExists("systemd-unit", "discord")).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("D2.1 fixed target model", () => {
  it("declares exactly telegram, discord, scheduler in fixed contract order", () => {
    expect([...SERVICE_OBSERVATION_TARGETS]).toEqual(["telegram", "discord", "scheduler"]);
    // The gateway service is deliberately excluded from manager observation.
    expect(SERVICE_OBSERVATION_TARGETS).not.toContain("gateway");
  });

  it("returns the fixed three targets in order and never observes the gateway", async () => {
    const snapshot = await observeServiceStatus(makeDeps());
    expect(snapshot.targets.map((t) => t.target)).toEqual(["telegram", "discord", "scheduler"]);
    expect(snapshot.targets).toHaveLength(3);
    expect(JSON.stringify(snapshot)).not.toContain("gateway");
  });

  it("stamps observedAt from the injected clock as canonical ISO", async () => {
    const snapshot = await observeServiceStatus(makeDeps({ now: () => new Date("2026-08-16T11:25:03.500Z") }));
    expect(snapshot.observedAt).toBe("2026-08-16T11:25:03.500Z");
  });

  it("yields manager unavailable and per-target unavailable when no usable manager exists — never fabricated inactive", async () => {
    const snapshot = await observeServiceStatus(makeDeps());
    expect(snapshot.manager).toBe("unavailable");
    for (const target of snapshot.targets) {
      expect(target.state).toBe("unavailable");
    }
    expect(JSON.stringify(snapshot)).not.toContain("inactive");
  });

  it("returns a bounded typed snapshot: no raw diagnostics, only the contract fields", async () => {
    const snapshot = await observeServiceStatus(
      makeDeps({
        hasSystemdUser: async () => true,
        artifactExists: async () => true,
        run: async () => runResult({ exitCode: 0, stdout: "active\nRAW-MARKER-SECRET-DIAGNOSTIC" }),
      }),
    );
    expect(Object.keys(snapshot).sort()).toEqual(["manager", "observedAt", "targets"]);
    for (const target of snapshot.targets) {
      expect(Object.keys(target).sort()).toEqual(["state", "target"]);
    }
    // Raw probe output never leaks into the snapshot.
    expect(JSON.stringify(snapshot)).not.toContain("RAW-MARKER-SECRET-DIAGNOSTIC");
  });
});
