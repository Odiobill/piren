import { describe, expect, it, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// End-to-end dispatch test for the `piren group` command. The pure writer/
// validator core is covered in tests/group-config.test.ts; this test exercises
// the real CLI binary dispatch path so a regression in the cli.ts
// `command === "group"` branch (and the parse-args KNOWN_COMMANDS entry) cannot
// ship green.
//
// Runs against the built binary: requires `npm run build` first.

const repoRoot = process.cwd();
const cliJs = join(repoRoot, "dist", "src", "cli.js");

// Isolate from the real ~/.config/piren/config.yml so the test never mutates
// the operator's config. HOME is set per-invocation.
function runPirenGroup(
  args: string[],
  env: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliJs, "group", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("piren group (CLI dispatch)", () => {
  let home: string;
  let vault: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "piren-group-cli-home-"));
    vault = join(home, "vault");
    await mkdir(join(vault, "team", "dipu"), { recursive: true });
    await mkdir(join(vault, "team", "zai"), { recursive: true });
    await mkdir(join(vault, "team", "sam"), { recursive: true });
    await writeFile(join(vault, ".piren-vault"), "");
    await writeFile(join(vault, "steward-directives.md"), "# directives");
    await writeFile(join(vault, "team", "dipu", "SOUL.md"), "# Dipu\n");
    await writeFile(join(vault, "team", "zai", "SOUL.md"), "# Zai\n");
    await writeFile(join(vault, "team", "sam", "SOUL.md"), "# Sam\n");
    // Seed a minimal config so vault_root resolves.
    await mkdir(join(home, ".config", "piren"), { recursive: true });
    await writeFile(
      join(home, ".config", "piren", "config.yml"),
      ["vault_root: " + vault, "", "allowed_agents:", "  - dipu", "  - zai", "  - sam", ""].join("\n"),
    );
  });

  it("lists no groups on a fresh vault", () => {
    const result = runPirenGroup(["list"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/<none>/);
  });

  it("creates a group, its skills dir, and an empty config.yml", async () => {
    const result = runPirenGroup(["create", "developers"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Created group 'developers'");
    const config = await readFile(join(vault, "agent-groups", "developers", "config.yml"), "utf8");
    expect(config).toBe("agents: []\nfallback_order: {}\n");
    // skills/ dir created
    await access(join(vault, "agent-groups", "developers", "skills"));
  });

  it("refuses to recreate an existing group without --force", () => {
    const result = runPirenGroup(["create", "developers"], { HOME: home });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/already exists|--force/i);
  });

  it("recreates the group with --force", () => {
    const result = runPirenGroup(["create", "developers", "--force"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Created group 'developers'");
  });

  it("rejects an invalid group name", () => {
    const result = runPirenGroup(["create", "../escape"], { HOME: home });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/invalid group name/i);
  });

  it("adds agents to the group and lists it", async () => {
    const add1 = runPirenGroup(["add-agent", "developers", "dipu"], { HOME: home });
    expect(add1.status).toBe(0);
    expect(add1.stdout).toContain("Added 'dipu'");
    const add2 = runPirenGroup(["add-agent", "developers", "zai"], { HOME: home });
    expect(add2.status).toBe(0);

    const config = await readFile(join(vault, "agent-groups", "developers", "config.yml"), "utf8");
    expect(config).toContain("- dipu");
    expect(config).toContain("- zai");

    const list = runPirenGroup(["list"], { HOME: home });
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("developers");
    expect(list.stdout).toContain("dipu");
  });

  it("no-ops when adding an agent already present", () => {
    const result = runPirenGroup(["add-agent", "developers", "dipu"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/already a member|no change/i);
  });

  it("refuses add-agent on a non-existent group", () => {
    const result = runPirenGroup(["add-agent", "ghost", "dipu"], { HOME: home });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not exist/i);
  });

  it("shows the group config as YAML", () => {
    const result = runPirenGroup(["show", "developers"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("developers");
    expect(result.stdout).toContain("agents:");
    expect(result.stdout).toContain("fallback_order:");
  });

  it("refuses show on a non-existent group", () => {
    const result = runPirenGroup(["show", "ghost"], { HOME: home });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not exist/i);
  });

  it("sets a fallback order with candidates", async () => {
    const result = runPirenGroup(["fallback", "set", "developers", "zai", "dipu", "sam"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("fallback");
    const config = await readFile(join(vault, "agent-groups", "developers", "config.yml"), "utf8");
    expect(config).toContain("fallback_order:");
    expect(config).toContain("zai:");
    expect(config).toContain("- dipu");
  });

  it("refuses fallback set when the agent is not a member", async () => {
    const result = runPirenGroup(["fallback", "set", "developers", "ghost", "dipu"], { HOME: home });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not a member|not in group/i);
  });

  it("removes an agent and prunes its fallback entries", async () => {
    const result = runPirenGroup(["remove-agent", "developers", "dipu"], { HOME: home });
    expect(result.status).toBe(0);
    const config = await readFile(join(vault, "agent-groups", "developers", "config.yml"), "utf8");
    // dipu removed from agents list
    const agentsBlock = config.split("fallback_order")[0] ?? "";
    expect(agentsBlock).not.toContain("- dipu");
    // and removed from any fallback list
    expect(config).not.toContain("- dipu");
  });

  it("reports when removing a non-member agent", () => {
    const result = runPirenGroup(["remove-agent", "developers", "ghost"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/not a member|was not/i);
  });

  it("validates and reports OK on a clean vault", () => {
    // Establish an internally consistent state for the shared `developers`
    // group before validating: every fallback candidate must be a member.
    const addSam = runPirenGroup(["add-agent", "developers", "sam"], { HOME: home });
    expect(addSam.status).toBe(0);
    const result = runPirenGroup(["validate"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/OK|no issues/i);
  });

  it("validates and reports errors (non-zero exit) for drift", async () => {
    // Create a group that declares a missing agent and a dangling fallback.
    await mkdir(join(vault, "agent-groups", "broken"), { recursive: true });
    await writeFile(
      join(vault, "agent-groups", "broken", "config.yml"),
      ["agents:", "  - zai", "  - nobody", "fallback_order:", "  zai:", "    - ghost"].join("\n") + "\n",
    );
    const result = runPirenGroup(["validate"], { HOME: home });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("broken");
    await rm(join(vault, "agent-groups", "broken"), { recursive: true, force: true });
  });

  it("prints help for piren group --help", () => {
    const result = runPirenGroup(["--help"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("piren group");
    expect(result.stdout).toMatch(/list|create|add-agent/);
  });

  it("rejects an unknown subcommand", () => {
    const result = runPirenGroup(["frobnicate"], { HOME: home });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unknown subcommand|usage/i);
  });

  // Path traversal guard (Slice A review fix): invalid group names must be
  // rejected on every read/consumer path before any filesystem access, not
  // surfaced as a confusing 'does not exist'. The pure-core guard lives in
  // readGroupConfig(); these tests exercise it through the real CLI dispatch.
  it("rejects a traversal group name on `show`", () => {
    const result = runPirenGroup(["show", "../../../etc/passwd"], { HOME: home });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/invalid group name/i);
  });

  it("rejects an invalid group name on `add-agent`", () => {
    const result = runPirenGroup(["add-agent", "../foo", "dipu"], { HOME: home });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/invalid group name/i);
  });

  it("rejects an invalid group name on `remove-agent`", () => {
    const result = runPirenGroup(["remove-agent", "foo/bar", "dipu"], { HOME: home });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/invalid group name/i);
  });

  it("rejects an invalid group name on `fallback set`", () => {
    const result = runPirenGroup(["fallback", "set", ".", "dipu", "sam"], { HOME: home });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/invalid group name/i);
  });
});
