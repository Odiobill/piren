import { describe, expect, it, beforeAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// End-to-end dispatch tests for the `piren scheduler` command branches. The
// pure loop core is covered in tests/scheduler-loop.test.ts; this file
// exercises the real CLI binary dispatch path so a regression in the cli.ts
// scheduler branch cannot ship green.
//
// Runs against the built binary: requires `npm run build` first. Each case
// uses a temp HOME with no config (or a no-work config), so --once never
// reaches live Pi auth, and the bare loop is stopped via SIGTERM.

const repoRoot = process.cwd();
const cliJs = join(repoRoot, "dist", "src", "cli.js");

function runScheduler(args: string[], env: Record<string, string>, input?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliJs, "scheduler", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    // Bounded safety net: a regression that leaves the long-running loop
    // alive must fail the test, not hang the suite forever.
    timeout: 15000,
    killSignal: "SIGKILL",
    ...(input !== undefined ? { input } : {}),
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * Spawn `piren scheduler` (the long-running loop), let it print its startup
 * summary and first tick, then send SIGTERM and resolve when the process
 * exits. A SIGKILL safety net prevents a hung test if clean shutdown fails.
 */
function runSchedulerLoopUntilSignal(
  args: string[],
  env: Record<string, string>,
  opts: { readyMs: number; killMs: number },
): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [cliJs, "scheduler", ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let readyTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (readyTimer) clearTimeout(readyTimer);
      if (killTimer) clearTimeout(killTimer);
    };
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    readyTimer = setTimeout(() => {
      if (!settled) child.kill("SIGTERM");
    }, opts.readyMs);
    killTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve({ status: null, signal: "SIGKILL", stdout, stderr });
      }
    }, opts.readyMs + opts.killMs);
    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ status: code, signal, stdout, stderr });
    });
  });
}

describe("piren scheduler (CLI dispatch)", () => {
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "piren-scheduler-cli-home-"));
  });

  it("'piren scheduler --once' with no config prints a no-work summary and exits 0", () => {
    const result = runScheduler(["--once"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SCHEDULER ONCE");
    expect(result.stdout).toMatch(/vault root|no enabled agents|no work/i);
  });

  it("bare 'piren scheduler' runs the opt-in loop and shuts down cleanly on SIGTERM (exit 0)", async () => {
    // Isolated HOME with a no-work config so the first tick is fast and no Pi
    // is spawned. The loop then sleeps until SIGTERM interrupts it. The
    // scheduler block is explicitly enabled (0.2.0 S2: fresh installs are
    // fail-closed disabled).
    const loopHome = await mkdtemp(join(tmpdir(), "piren-scheduler-loop-home-"));
    try {
      const vault = join(loopHome, "vault");
      await mkdir(join(vault, "team", "codex"), { recursive: true });
      await writeFile(join(vault, ".piren-vault"), "");
      await mkdir(join(loopHome, ".config", "piren"), { recursive: true });
      await writeFile(
        join(loopHome, ".config", "piren", "config.yml"),
        `vault_root: ${vault}\nallowed_agents:\n  - codex\nscheduler:\n  enabled: true\n  automation:\n    inbox_tasks: true\n    agent_cron: true\n    script_cron: true\n`,
      );
      const result = await runSchedulerLoopUntilSignal([], { HOME: loopHome }, { readyMs: 1000, killMs: 5000 });
      expect(result.status).toBe(0);
      expect(result.signal).toBe(null);
      expect(result.stdout).toContain("SCHEDULER LOOP STARTING");
      expect(result.stdout).toContain("SCHEDULER LOOP SHUTDOWN");
      // The shutdown reason reflects the signal that requested it.
      expect(result.stdout).toContain("SIGTERM");
    } finally {
      await rm(loopHome, { recursive: true, force: true });
    }
  }, 15000);

  it("bare 'piren scheduler' reports the enabled agent and conservative defaults at startup", async () => {
    const loopHome = await mkdtemp(join(tmpdir(), "piren-scheduler-loop-home-"));
    try {
      const vault = join(loopHome, "vault");
      await mkdir(join(vault, "team", "codex"), { recursive: true });
      await writeFile(join(vault, ".piren-vault"), "");
      await mkdir(join(loopHome, ".config", "piren"), { recursive: true });
      await writeFile(
        join(loopHome, ".config", "piren", "config.yml"),
        `vault_root: ${vault}\nallowed_agents:\n  - codex\nscheduler:\n  poll_interval_seconds: 5\n  device_id: thor\n`,
      );
      const result = await runSchedulerLoopUntilSignal([], { HOME: loopHome }, { readyMs: 1000, killMs: 5000 });
      expect(result.status).toBe(0);
      const startup = result.stdout;
      expect(startup).toContain("SCHEDULER LOOP STARTING");
      expect(startup).toContain("device id: thor");
      expect(startup).toContain("enabled agents: codex");
      expect(startup).toContain("poll interval: 5s");
      // Effective concurrency is honestly 1 (one-at-a-time).
      expect(startup).toMatch(/effective.*1|one-at-a-time/i);
    } finally {
      await rm(loopHome, { recursive: true, force: true });
    }
  }, 15000);

  it("'piren scheduler --dry-run' remains LLM-free/claim-free and exits 0", () => {
    const result = runScheduler(["--dry-run"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SCHEDULER DRY-RUN");
    expect(result.stdout).not.toContain("[EXEC]");
  });

  it("'piren scheduler --report' is read-only, exits 0, and never invokes Pi", async () => {
    const reportHome = await mkdtemp(join(tmpdir(), "piren-scheduler-report-home-"));
    try {
      const vault = join(reportHome, "vault");
      await mkdir(join(vault, "team", "codex", "inbox"), { recursive: true });
      await writeFile(join(vault, ".piren-vault"), "");
      await writeFile(
        join(vault, "team", "codex", "inbox", "20260725T120000000Z-stuck.claimed.thor.md"),
        "---\nid: 20260725T120000000Z-stuck\nstatus: in_progress\n---\n\n# Stuck task\n",
      );
      await mkdir(join(reportHome, ".config", "piren"), { recursive: true });
      await writeFile(
        join(reportHome, ".config", "piren", "config.yml"),
        `vault_root: ${vault}\nallowed_agents:\n  - codex\n`,
      );
      const result = runScheduler(["--report"], { HOME: reportHome });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("SCHEDULER REPORT");
      expect(result.stdout).toContain("[TRIAGE]");
      expect(result.stdout).toContain("manual triage");
      // Read-only: no execution, no Pi spawn, no error output.
      expect(result.stdout).not.toContain("[EXEC]");
      expect(result.stderr).toBe("");
    } finally {
      await rm(reportHome, { recursive: true, force: true });
    }
  });

  it("'piren scheduler --once' with a vault but no work exits 0 without spawning Pi", async () => {
    const vault = join(home, "vault-once");
    await mkdir(join(vault, "team", "codex"), { recursive: true });
    await writeFile(join(vault, ".piren-vault"), "");
    await mkdir(join(home, ".config", "piren"), { recursive: true });
    await writeFile(
      join(home, ".config", "piren", "config.yml"),
      `vault_root: ${vault}\nallowed_agents:\n  - codex\n`,
    );
    const result = runScheduler(["--once"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SCHEDULER ONCE");
    expect(result.stdout).toMatch(/no work/i);
  });
});

describe("piren scheduler CLI gates (0.2.0 S2)", () => {
  async function makeHome(schedulerBlock: string): Promise<{ home: string; vault: string }> {
    const home = await mkdtemp(join(tmpdir(), "piren-scheduler-gate-home-"));
    const vault = join(home, "vault");
    await mkdir(join(vault, "team", "codex", "inbox"), { recursive: true });
    await mkdir(join(vault, "team", "codex", "devices"), { recursive: true });
    await writeFile(join(vault, ".piren-vault"), "");
    await mkdir(join(home, ".config", "piren"), { recursive: true });
    await writeFile(
      join(home, ".config", "piren", "config.yml"),
      `vault_root: ${vault}\nallowed_agents:\n  - codex\n${schedulerBlock}`,
    );
    return { home, vault };
  }

  it("'piren scheduler --once' with a legacy-gated config prints an inert legacy-gate notice, exits 0, writes nothing", async () => {
    const { home, vault } = await makeHome("scheduler:\n  enabled: false\n");
    try {
      const result = runScheduler(["--once"], { HOME: home });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("SCHEDULER ONCE");
      expect(result.stdout).toMatch(/no enabled automation classes/i);
      expect(result.stdout).toMatch(/legacy gate/i);
      expect(result.stdout).not.toContain("[EXEC]");
      // Inert supervision: no heartbeat; the devices directory stays empty.
      const { readdir } = await import("node:fs/promises");
      expect(await readdir(join(vault, "team", "codex", "devices"))).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("'piren scheduler --once --force' never bypasses legacy gating (enabled:false fails closed; no persistence)", async () => {
    const { home } = await makeHome("scheduler:\n  enabled: false\n  automation:\n    agent_cron: false\n    script_cron: false\n");
    try {
      const result = runScheduler(["--once", "--force"], { HOME: home });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("SCHEDULER ONCE");
      expect(result.stdout).toMatch(/legacy gate/i);
      expect(result.stdout).toMatch(/force: not applied/i);
      expect(result.stdout).not.toMatch(/force: inbox automation override/);
      // Config unchanged: force never persists and never migrates.
      const after = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(home, ".config", "piren", "config.yml"), "utf8"),
      );
      expect(after).toContain("enabled: false");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("bare 'piren scheduler' with a legacy-gated config runs as inert supervision until SIGTERM (clean exit 0)", async () => {
    const { home } = await makeHome("scheduler:\n  enabled: false\n");
    try {
      const result = await runSchedulerLoopUntilSignal([], { HOME: home }, { readyMs: 1000, killMs: 5000 });
      expect(result.status).toBe(0);
      expect(result.signal).toBe(null);
      expect(result.stdout).toContain("SCHEDULER LOOP STARTING");
      expect(result.stdout).toMatch(/no enabled automation classes/i);
      expect(result.stdout).toMatch(/legacy gate/i);
      expect(result.stdout).toContain("SCHEDULER LOOP SHUTDOWN");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 15000);

  it("bare 'piren scheduler' startup summary lists resolved automation classes", async () => {
    const { home } = await makeHome(
      "scheduler:\n  enabled: true\n  poll_interval_seconds: 5\n  automation:\n    inbox_tasks: true\n    agent_cron: false\n    script_cron: true\n",
    );
    try {
      const result = await runSchedulerLoopUntilSignal([], { HOME: home }, { readyMs: 1000, killMs: 5000 });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("SCHEDULER LOOP STARTING");
      expect(result.stdout).toContain("automation: inbox_tasks=on agent_cron=off script_cron=on");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 15000);

  it("'piren scheduler --report' renders resolved automation/legacy state and stays read-only", async () => {
    const { home } = await makeHome("scheduler:\n  enabled: false\n  automation:\n    inbox_tasks: false\n    agent_cron: true\n    script_cron: false\n");
    try {
      const result = runScheduler(["--report"], { HOME: home });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("SCHEDULER REPORT");
      // enabled:false is an ambiguous legacy gate: ALL classes resolve disabled.
      expect(result.stdout).toContain("automation: inbox_tasks=off agent_cron=off script_cron=off");
      expect(result.stdout).toMatch(/legacy gate: .*fail closed/i);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("piren scheduler configure (CLI dispatch, 0.2.0 S3)", () => {
  async function makeHome(configText: string | undefined): Promise<{ home: string; vault: string; configPath: string }> {
    const home = await mkdtemp(join(tmpdir(), "piren-scheduler-configure-home-"));
    const vault = join(home, "vault");
    await mkdir(join(vault, "team", "codex"), { recursive: true });
    await writeFile(join(vault, ".piren-vault"), "");
    const configPath = join(home, ".config", "piren", "config.yml");
    await mkdir(join(home, ".config", "piren"), { recursive: true });
    if (configText !== undefined) await writeFile(configPath, configText);
    return { home, vault, configPath };
  }

  it("guided flow: piped answers produce a preview, confirmation, and an atomic write", async () => {
    const { home, configPath } = await makeHome("vault_root: /v\nallowed_agents:\n  - codex\n");
    try {
      // inbox yes, agent no, script no, intervals default,
      // device blank, write yes.
      const answers = "y\nn\nn\n\n\n\n\ny\n";
      const result = runScheduler(["configure"], { HOME: home }, answers);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Validation: resolves inbox_tasks=on agent_cron=off script_cron=off");
      expect(result.stdout).not.toMatch(/scheduler enabled|Enable the scheduler/);
      expect(result.stdout).toContain("scheduler:");
      expect(result.stdout).toContain("Wrote");
      const { readFile } = await import("node:fs/promises");
      const written = await readFile(configPath, "utf8");
      expect(written).not.toContain("enabled");
      expect(written).toContain("inbox_tasks: true");
      expect(written).toContain("agent_cron: false");
      expect(written).toContain("script_cron: false");
      // Unrelated blocks preserved.
      expect(written).toContain("vault_root: /v");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("declining the write confirmation leaves the config byte-for-byte intact", async () => {
    const original = "vault_root: /v\nallowed_agents:\n  - codex\nscheduler:\n  poll_interval_seconds: 45\n";
    const { home, configPath } = await makeHome(original);
    try {
      // defaults accepted (classes resolve from automation; none declared), write declined.
      const answers = "\n\n\n\n\n\n\nn\n";
      const result = runScheduler(["configure"], { HOME: home }, answers);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Cancelled");
      const { readFile } = await import("node:fs/promises");
      expect(await readFile(configPath, "utf8")).toBe(original);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("an unknown scheduler subcommand fails with usage", () => {
    const result = runScheduler(["bogus"], { HOME: "" });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage: piren scheduler/i);
  });
});
