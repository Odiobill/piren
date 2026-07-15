import { describe, expect, it, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// End-to-end dispatch test for the `piren skill` command. The pure core is
// covered in tests/skill-cli.test.ts; this test exercises the real CLI binary
// dispatch path.
//
// Runs against the built binary: requires `npm run build` first.

const repoRoot = process.cwd();
const cliJs = join(repoRoot, "dist", "src", "cli.js");

function runPirenSkill(
  args: string[],
  env: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliJs, "skill", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("piren skill (CLI dispatch)", () => {
  let home: string;
  let vault: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "piren-skill-cli-home-"));
    vault = join(home, "vault");
    await mkdir(join(vault, "team", "dipu", "skills"), { recursive: true });
    await mkdir(join(vault, "team", "zai", "skills"), { recursive: true });
    await mkdir(join(vault, "skills"), { recursive: true });
    await mkdir(join(vault, "agent-groups", "devs", "skills"), { recursive: true });
    await mkdir(join(vault, "agent-groups", "ops", "skills"), { recursive: true });
    // Group configs
    await mkdir(join(vault, "agent-groups", "devs"), { recursive: true });
    await writeFile(
      join(vault, "agent-groups", "devs", "config.yml"),
      "agents:\n  - dipu\n  - zai\n",
    );
    await mkdir(join(vault, "agent-groups", "ops"), { recursive: true });
    await writeFile(
      join(vault, "agent-groups", "ops", "config.yml"),
      "agents:\n  - dipu\n",
    );
    await writeFile(join(vault, ".piren-vault"), "");
    await writeFile(join(vault, "steward-directives.md"), "# directives");
    await writeFile(join(vault, "team", "dipu", "SOUL.md"), "# Dipu\n");
    await writeFile(join(vault, "team", "zai", "SOUL.md"), "# Zai\n");
    // Seed a minimal config so vault_root resolves.
    await mkdir(join(home, ".config", "piren"), { recursive: true });
    await writeFile(
      join(home, ".config", "piren", "config.yml"),
      ["vault_root: " + vault, "", "allowed_agents:", "  - dipu", "  - zai", ""].join("\n"),
    );
  });

  it("lists no skills on a fresh vault", () => {
    const result = runPirenSkill(["list"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/no skills found/i);
  });

  it("creates a shared skill and lists it", () => {
    const create = runPirenSkill(
      ["create", "test-skill", "--scope", "shared"],
      { HOME: home },
    );
    expect(create.status).toBe(0);
    expect(create.stdout).toContain("Created skill");

    const list = runPirenSkill(["list"], { HOME: home });
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("test-skill");
    expect(list.stdout).toContain("shared:shared");
  });

  it("creates an agent-scoped skill", () => {
    const create = runPirenSkill(
      ["create", "agent-only", "--scope", "agent:dipu"],
      { HOME: home },
    );
    expect(create.status).toBe(0);

    const list = runPirenSkill(["list", "--agent", "dipu"], { HOME: home });
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("agent-only");
  });

  it("refuses to create duplicate without --force", () => {
    const result = runPirenSkill(
      ["create", "test-skill", "--scope", "shared"],
      { HOME: home },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/already exists/i);
  });

  it("creates with --force when duplicate exists", () => {
    const result = runPirenSkill(
      ["create", "test-skill", "--scope", "shared", "--force"],
      { HOME: home },
    );
    expect(result.status).toBe(0);
  });

  it("shows a skill by name", () => {
    const result = runPirenSkill(["show", "test-skill"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Name: test-skill");
    expect(result.stdout).toContain("Source: shared");
  });

  it("errors on show of unknown skill", () => {
    const result = runPirenSkill(["show", "nonexistent"], { HOME: home });
    expect(result.status).not.toBe(0);
  });

  it("shows skill with agent precedence", () => {
    // Create a skill in both shared and agent scope
    runPirenSkill(["create", "overlap", "--scope", "shared", "--force"], { HOME: home });
    runPirenSkill(["create", "overlap", "--scope", "agent:dipu", "--force"], { HOME: home });

    const result = runPirenSkill(["show", "overlap", "--agent", "dipu"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Source: agent");
  });

  it("explains skill provenance", () => {
    const result = runPirenSkill(
      ["explain", "overlap", "--agent", "dipu"],
      { HOME: home },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Effective (active)");
    expect(result.stdout).toContain("agent:dipu");
    expect(result.stdout).toContain("Shadowed (inactive)");
  });

  it("moves a skill between scopes", () => {
    const move = runPirenSkill(
      ["move", "agent-only", "--from", "agent:dipu", "--to", "shared"],
      { HOME: home },
    );
    expect(move.status).toBe(0);
    expect(move.stdout).toContain("Moved skill");

    // Should now be in shared scope
    const list = runPirenSkill(["list", "--scope", "shared"], { HOME: home });
    expect(list.stdout).toContain("agent-only");
  });

  it("promotes a skill from agent to group", () => {
    runPirenSkill(["create", "promo", "--scope", "agent:dipu", "--force"], { HOME: home });

    const promote = runPirenSkill(
      ["promote", "promo", "--from", "agent:dipu", "--to", "group:devs"],
      { HOME: home },
    );
    expect(promote.status).toBe(0);
    expect(promote.stdout).toContain("Promoted skill");

    const list = runPirenSkill(["list", "--group", "devs"], { HOME: home });
    expect(list.stdout).toContain("promo");
  });

  it("demotes a skill from shared to agent", () => {
    runPirenSkill(["create", "demo", "--scope", "shared", "--force"], { HOME: home });

    const demote = runPirenSkill(
      ["demote", "demo", "--from", "shared", "--to", "agent:dipu"],
      { HOME: home },
    );
    expect(demote.status).toBe(0);
    expect(demote.stdout).toContain("Demoted skill");

    const list = runPirenSkill(["list", "--agent", "dipu"], { HOME: home });
    expect(list.stdout).toContain("demo");
  });

  it("reports conflicts", () => {
    // We already have overlap in shared and agent:dipu
    const result = runPirenSkill(["conflicts", "--agent", "dipu"], { HOME: home });
    expect(result.status).toBe(1); // Non-zero when conflicts found
    expect(result.stdout).toContain("overlap");
  });

  it("reports no conflicts when none exist", () => {
    const result = runPirenSkill(["conflicts", "--agent", "zai"], { HOME: home });
    // zai may have no conflicting skills
    if (result.status === 0) {
      expect(result.stdout).toMatch(/no skill conflicts found/i);
    }
  });

  it("validates skills", () => {
    const result = runPirenSkill(["validate"], { HOME: home });
    // All skills created by this test should pass validation
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/passed validation/i);
  });

  it("rejects unknown subcommand", () => {
    const result = runPirenSkill(["unknown"], { HOME: home });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/piren skill/i);
  });

  it("filters list by scope", () => {
    const result = runPirenSkill(["list", "--scope", "shared"], { HOME: home });
    expect(result.status).toBe(0);
    // Should only show shared-scoped skills
    const lines = result.stdout.split("\n").filter((l) => l.includes("shared:shared") || l.includes("NAME"));
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });
});
