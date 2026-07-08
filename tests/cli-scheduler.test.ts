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

function runScheduler(args: string[], env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliJs, "scheduler", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
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
    // is spawned. The loop then sleeps until SIGTERM interrupts it.
    const loopHome = await mkdtemp(join(tmpdir(), "piren-scheduler-loop-home-"));
    try {
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
