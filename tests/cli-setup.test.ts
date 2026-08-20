import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// End-to-end dispatch test for the G1 bounded post-setup Workbench suggestion
// on the batch `piren setup` path (0.2.0 scope amendment §7). The pure
// formatter is covered in tests/setup-guidance.test.ts and the interactive
// wizard gating in tests/wizard-run.test.ts; this test exercises the real
// CLI binary dispatch so a regression in the cli.ts `command === "setup"`
// branch cannot ship green.
//
// Runs against the built binary: requires `npm run build` first. HOME is set
// per-invocation to a temp dir so the operator's real config is never touched.

const repoRoot = process.cwd();
const cliJs = join(repoRoot, "dist", "src", "cli.js");

function runPirenSetup(args: string[], home: string): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string> = { ...process.env, HOME: home } as Record<string, string>;
  // Unset (not blank) Piren env overrides: a blank value is not nullish and
  // would shadow the seeded local config via `??`.
  delete env.PIREN_AGENT_DIR;
  delete env.PIREN_VAULT_ROOT;
  delete env.PIREN_AGENT;
  const result = spawnSync(process.execPath, [cliJs, "setup", ...args], {
    encoding: "utf8",
    env,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const SUGGESTION_MARKER = "piren gateway";

function suggestionCount(stdout: string): number {
  return stdout.split(SUGGESTION_MARKER).length - 1;
}

describe("piren setup (CLI dispatch) — G1 post-setup Workbench suggestion", () => {
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "piren-setup-cli-home-"));
  });

  afterAll(async () => rm(home, { recursive: true, force: true }));

  it("a successful --apply prints the bounded optional suggestion exactly once and exits 0", async () => {
    const applyHome = join(home, "apply-ok");
    const vault = join(applyHome, "vault");
    await mkdir(applyHome, { recursive: true });
    const result = runPirenSetup(["--apply", "--vault-root", vault, "--agent", "piren"], applyHome);
    expect(result.status).toBe(0);
    expect(suggestionCount(result.stdout)).toBe(1);
    expect(result.stdout).toContain("127.0.0.1");
    expect(result.stdout).toContain("not running yet");
  });

  it("a failing --apply prints no suggestion and exits 1", async () => {
    const failHome = join(home, "apply-fail");
    const vault = join(failHome, "vault");
    await mkdir(join(failHome, ".config", "piren"), { recursive: true });
    // Pre-seeded local policy excludes the selected agent: the runnable-agent
    // check fails, so the apply report is CLI-failing and no success-only
    // suggestion may appear.
    await writeFile(
      join(failHome, ".config", "piren", "config.yml"),
      ["vault_root: " + vault, "", "allowed_agents:", "  - piren", "excluded_agents:", "  - piren", ""].join("\n"),
    );
    const result = runPirenSetup(["--apply", "--agent", "piren"], failHome);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain(SUGGESTION_MARKER);
    expect(result.stdout).not.toContain("not running yet");
  });

  it("a non-apply inspection without failing checks keeps its current output (no suggestion)", async () => {
    const inspectHome = join(home, "inspect");
    const vault = join(inspectHome, "vault");
    await mkdir(join(inspectHome, ".config", "piren"), { recursive: true });
    await mkdir(join(vault, "team", "piren"), { recursive: true });
    await writeFile(join(vault, "team", "piren", "config.yml"), "poll_interval_active_seconds: 60\n");
    await writeFile(join(inspectHome, ".config", "piren", "config.yml"), ["vault_root: " + vault, "", "allowed_agents:", "  - piren", ""].join("\n"));
    const result = runPirenSetup([], inspectHome);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Piren setup");
    expect(result.stdout).not.toContain(SUGGESTION_MARKER);
    expect(result.stdout).not.toContain("not running yet");
  });
});
