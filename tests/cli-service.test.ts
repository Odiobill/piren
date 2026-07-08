import { describe, expect, it, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// End-to-end dispatch tests for the `piren service ... scheduler` path. The
// pure install/remove/control plans are covered in tests/service-lifecycle.test.ts;
// this file proves the real CLI binary accepts `scheduler` as a service target
// and targets the `piren-scheduler` unit/session, without performing a real
// install (which would mutate systemd/tmux/crontab).
//
// `status` is read-only and side-effect-free: it runs `systemctl --user status`
// / `tmux has-session` / nothing (none) but writes no files and installs
// nothing. Runs against the built binary: requires `npm run build` first.

const repoRoot = process.cwd();
const cliJs = join(repoRoot, "dist", "src", "cli.js");

function runService(args: string[], env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliJs, "service", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("piren service scheduler (CLI dispatch)", () => {
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "piren-service-cli-home-"));
  });

  it("'piren service' with no args prints a usage error that lists scheduler", () => {
    const result = runService([], { HOME: home });
    expect(result.status).toBe(2);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("Usage: piren service");
    expect(combined).toContain("scheduler");
    expect(combined).toContain("gateway");
  });

  it("'piren service status scheduler' accepts scheduler and targets piren-scheduler (no rejection)", () => {
    const result = runService(["status", "scheduler"], { HOME: home });
    // status is read-only; it must not reject scheduler as an unknown target.
    // Exit 2 would mean validation/usage failure; any other code means scheduler
    // was accepted and dispatch reached the service manager layer.
    expect(result.status).not.toBe(2);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toMatch(/unknown (transport|service target)/i);
    // The report targets the piren-scheduler unit/session name.
    expect(combined).toContain("piren-scheduler");
    expect(combined).toContain("scheduler");
  });

  it("'piren service install bogus' still rejects an unknown target and lists scheduler", () => {
    const result = runService(["install", "bogus"], { HOME: home });
    expect(result.status).toBe(2);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("scheduler");
    expect(combined).toMatch(/unknown service target/i);
  });
});
