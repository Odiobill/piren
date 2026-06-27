import { describe, expect, it, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// End-to-end dispatch test for the `piren agent` command. The pure core
// (validateAgentName, executeAddAgent, etc.) is covered in
// tests/agent-manage.test.ts and command recognition in parse-args.test.ts;
// this test exercises the real CLI binary dispatch path so a regression in the
// cli.ts `command === "agent"` branch cannot ship green.
//
// Runs against the built binary: requires `npm run build` first.

const repoRoot = process.cwd();
const cliJs = join(repoRoot, "dist", "src", "cli.js");

// Isolate from the real ~/.config/piren/config.yml so the test never mutates
// the operator's config. HOME is set per-invocation.
function runPirenAgent(args: string[], env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliJs, "agent", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("piren agent (CLI dispatch)", () => {
  let home: string;
  let vault: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "piren-agent-cli-home-"));
    vault = join(home, "vault");
    await mkdir(join(vault, "team", "piren"), { recursive: true });
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

  it("lists agents showing the existing one as allowed", () => {
    const result = runPirenAgent(["list"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("vault_root: ");
    expect(result.stdout).toContain("[allowed] piren");
  });

  it("adds a new agent, scaffolds its dir, and permits it", async () => {
    const result = runPirenAgent(["add", "thor"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Added agent 'thor'");
    expect(result.stdout).toContain("Permitted 'thor'");

    // The team dir was scaffolded with identity files.
    const soul = await readFile(join(vault, "team", "thor", "SOUL.md"), "utf8");
    expect(soul.length).toBeGreaterThan(0);

    // Config now lists thor.
    const config = await readFile(join(home, ".config", "piren", "config.yml"), "utf8");
    expect(config).toContain("- thor");
    expect(config).toContain("- piren"); // existing agent preserved
  });

  it("refuses to add an agent whose name is invalid", () => {
    const result = runPirenAgent(["add", "BAD-NAME"], { HOME: home });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/invalid agent name/i);
  });

  it("clones an existing agent into a new one and permits the clone", async () => {
    // piren exists; clone it to sage.
    const result = runPirenAgent(["clone", "piren", "sage"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Cloned 'piren' to 'sage'");
    const soul = await readFile(join(vault, "team", "sage", "SOUL.md"), "utf8");
    expect(soul).toContain("Piren"); // source identity copied verbatim
    const config = await readFile(join(home, ".config", "piren", "config.yml"), "utf8");
    expect(config).toContain("- sage");
  });

  it("removes an agent with --yes, dropping permission and deleting the dir", async () => {
    // thor was added earlier.
    const result = runPirenAgent(["remove", "thor", "--yes"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Removed 'thor' from allowed_agents");
    expect(result.stdout).toContain("Deleted vault directory");
    const config = await readFile(join(home, ".config", "piren", "config.yml"), "utf8");
    expect(config).not.toContain("- thor");
  });
});
