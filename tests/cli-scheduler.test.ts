import { describe, expect, it, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// End-to-end dispatch test for the `piren scheduler` command branches. The
// pure core (schedulerOnce) is covered in tests/scheduler-once.test.ts and
// --once parsing in tests/parse-args.test.ts; this test exercises the real
// CLI binary dispatch path so a regression in the cli.ts scheduler branch
// cannot ship green.
//
// Runs against the built binary: requires `npm run build` first. Each case
// uses a temp HOME with no config (or a no-work config), so --once never
// reaches live Pi auth.

const repoRoot = process.cwd();
const cliJs = join(repoRoot, "dist", "src", "cli.js");

function runScheduler(args: string[], env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliJs, "scheduler", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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

  it("bare 'piren scheduler' prints a not-implemented hint mentioning --once and exits 1", () => {
    const result = runScheduler([], { HOME: home });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("--once");
    expect(result.stdout).toContain("--dry-run");
  });

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
