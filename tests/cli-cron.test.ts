import { describe, expect, it, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// End-to-end dispatch test for the `piren cron` command. The pure writer/
// validator core is covered in tests/cron-cli.test.ts; this test exercises
// the real CLI binary dispatch path.
//
// Runs against the built binary: requires `npm run build` first.

const repoRoot = process.cwd();
const cliJs = join(repoRoot, "dist", "src", "cli.js");

function runPirenCron(
  args: string[],
  env: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliJs, "cron", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("piren cron (CLI dispatch)", () => {
  let home: string;
  let vault: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "piren-cron-cli-home-"));
    vault = join(home, "vault");
    await mkdir(join(vault, "team", "piren"), { recursive: true });
    await mkdir(join(vault, "cron", "jobs"), { recursive: true });
    await mkdir(join(vault, "team", "piren", "cron", "jobs"), { recursive: true });
    await mkdir(join(vault, "cron", "runs"), { recursive: true });
    await writeFile(join(vault, ".piren-vault"), "");
    await writeFile(join(vault, "steward-directives.md"), "# directives");
    await writeFile(join(vault, "team", "piren", "SOUL.md"), "# Piren\n");
    // Seed a minimal config so vault_root resolves.
    await mkdir(join(home, ".config", "piren"), { recursive: true });
    await writeFile(
      join(home, ".config", "piren", "config.yml"),
      ["vault_root: " + vault, "", "allowed_agents:", "  - piren", ""].join("\n"),
    );
  });

  it("lists no jobs on a fresh vault", () => {
    const result = runPirenCron(["list", "--agent", "piren"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/no cron jobs|none/i);
  });

  it("creates a cron job and lists it", () => {
    const create = runPirenCron(
      ["create", "test-job", "--agent", "piren", "--schedule", "30m"],
      { HOME: home },
    );
    expect(create.status).toBe(0);
    expect(create.stdout).toContain("Created cron job");

    const list = runPirenCron(["list", "--agent", "piren"], { HOME: home });
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("test-job");
    expect(list.stdout).toContain("30m");
  });

  it("shows a cron job's full details", () => {
    const result = runPirenCron(["show", "test-job"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("test-job");
    expect(result.stdout).toContain("piren");
    expect(result.stdout).toContain("30m");
  });

  it("refuses to create a duplicate job without --force", () => {
    const result = runPirenCron(
      ["create", "test-job", "--agent", "piren", "--schedule", "1d"],
      { HOME: home },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/already exists|--force/i);
  });

  it("overwrites a duplicate job with --force", () => {
    const result = runPirenCron(
      ["create", "test-job", "--agent", "piren", "--schedule", "1d", "--force"],
      { HOME: home },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Created cron job");
  });

  it("disables and enables a job", () => {
    const disable = runPirenCron(["disable", "test-job"], { HOME: home });
    expect(disable.status).toBe(0);
    expect(disable.stdout).toContain("Disabled");

    const showDisabled = runPirenCron(["show", "test-job"], { HOME: home });
    expect(showDisabled.stdout).toContain("enabled: false");

    const enable = runPirenCron(["enable", "test-job"], { HOME: home });
    expect(enable.status).toBe(0);
    expect(enable.stdout).toContain("Enabled");

    const showEnabled = runPirenCron(["show", "test-job"], { HOME: home });
    expect(showEnabled.stdout).toContain("enabled: true");
  });

  it("creates a script-mode job", () => {
    const result = runPirenCron(
      ["create-script", "backup-job", "--agent", "piren", "--schedule", "1d", "--script", "team/piren/SOUL.md"],
      { HOME: home },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("script-mode");
  });

  it("shows run records (empty)", () => {
    const result = runPirenCron(["runs", "--agent", "piren"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/no run records/i);
  });

  it("validates and reports OK", () => {
    const result = runPirenCron(["validate"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/OK|no issues/i);
  });

  it("rejects an invalid schedule in create", () => {
    const result = runPirenCron(
      ["create", "bad-job", "--agent", "piren", "--schedule", "not-a-schedule"],
      { HOME: home },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/invalid cron schedule/i);
  });

  it("rejects create without --agent", () => {
    const result = runPirenCron(
      ["create", "no-agent-job", "--schedule", "30m"],
      { HOME: home },
    );
    expect(result.status).toBe(2);
  });

  it("rejects create without --schedule", () => {
    const result = runPirenCron(
      ["create", "no-schedule-job", "--agent", "piren"],
      { HOME: home },
    );
    expect(result.status).toBe(2);
  });

  it("rejects an unknown subcommand", () => {
    const result = runPirenCron(["frobnicate"], { HOME: home });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage/i);
  });

  it("prints help for piren cron --help", () => {
    const result = runPirenCron(["--help"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("piren cron");
    expect(result.stdout).toMatch(/list|create|validate/);
  });
});
