import { describe, expect, it, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// End-to-end dispatch test for the `piren skills seed|doctor` surface
// (S3a §3/§6). Runs against the built binary + built dist/templates, so it
// requires `npm run build` first. The pure core is covered in
// tests/starter-skills.test.ts; this test pins the real CLI dispatch path,
// exit codes, and non-mutation guarantees.

const repoRoot = process.cwd();
const cliJs = join(repoRoot, "dist", "src", "cli.js");

function runPirenSkills(
  args: string[],
  home: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliJs, "skills", ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PIREN_HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function makeVault(home: string, name = "vault"): Promise<string> {
  const vault = join(home, name);
  await mkdir(join(vault, "skills"), { recursive: true });
  await writeFile(join(vault, ".piren-vault"), "");
  return vault;
}

describe("piren skills (CLI dispatch)", () => {
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "piren-skills-cli-home-"));
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("seed --dry-run prints the plan and writes nothing", async () => {
    const vault = await makeVault(home, "dry-run");
    const run = runPirenSkills(["seed", "--profile", "okf", "--dry-run", "--vault-root", vault], home);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("okf-authoring");
    expect(run.stdout).toContain("piren-vault-operations");
    expect(run.stdout).toContain("piren-knowledge-lifecycle");
    expect(run.stdout.toLowerCase()).toContain("--yes");
    // Nothing was written.
    await expect(access(join(vault, "skills", "okf-authoring", "SKILL.md"))).rejects.toThrow();
  });

  it("seed without --yes is plan-only and non-mutating", async () => {
    const vault = await makeVault(home, "plan-only");
    const run = runPirenSkills(["seed", "--profile", "okf", "--vault-root", vault], home);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("create");
    await expect(access(join(vault, "skills", "okf-authoring", "SKILL.md"))).rejects.toThrow();
  });

  it("seed --yes creates exactly the absent files with provenance; a second run is a no-op", async () => {
    const vault = await makeVault(home, "apply");
    const run = runPirenSkills(["seed", "--profile", "okf", "--yes", "--vault-root", vault], home);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("created");

    for (const name of ["okf-authoring", "piren-vault-operations", "piren-knowledge-lifecycle"]) {
      const content = await readFile(join(vault, "skills", name, "SKILL.md"), "utf8");
      expect(content).toContain("template:");
      expect(content).toContain(`  id: ${name}`);
      expect(content).toContain("  profile: okf");
      expect(content).toMatch(/  content_sha256: [0-9a-f]{64}/);
    }

    const second = runPirenSkills(["seed", "--profile", "okf", "--yes", "--vault-root", vault], home);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("nothing to seed");
  });

  it("doctor reports absent on a fresh vault and seeded-current after seeding", async () => {
    const vault = await makeVault(home, "doctor");
    const before = runPirenSkills(["doctor", "--profile", "okf", "--vault-root", vault], home);
    expect(before.status).toBe(0);
    expect(before.stdout).toContain("absent");

    const seed = runPirenSkills(["seed", "--profile", "okf", "--yes", "--vault-root", vault], home);
    expect(seed.status).toBe(0);
    const after = runPirenSkills(["doctor", "--profile", "okf", "--vault-root", vault], home);
    expect(after.status).toBe(0);
    expect(after.stdout).toContain("seeded-current");
  });

  it("seed refuses a duplicate active skill name without writing", async () => {
    const vault = await makeVault(home, "duplicate");
    await mkdir(join(vault, "team", "thor", "skills", "okf-authoring"), { recursive: true });
    await writeFile(
      join(vault, "team", "thor", "skills", "okf-authoring", "SKILL.md"),
      ["---", "name: okf-authoring", 'description: "Agent variant."', "type: Skill", "---", "", "# Agent"].join("\n"),
    );
    const run = runPirenSkills(["seed", "--profile", "okf", "--yes", "--vault-root", vault], home);
    expect(run.status).toBe(1);
    expect(run.stderr.toLowerCase()).toContain("duplicate");
    await expect(access(join(vault, "skills", "okf-authoring", "SKILL.md"))).rejects.toThrow();
  });

  it("rejects an unknown profile and a non-vault root", async () => {
    const vault = await makeVault(home, "rejects");
    const unknown = runPirenSkills(["seed", "--profile", "nope", "--vault-root", vault], home);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr.toLowerCase()).toContain("available");

    const notVault = join(home, "not-a-vault");
    await mkdir(notVault, { recursive: true });
    const badRoot = runPirenSkills(["doctor", "--profile", "okf", "--vault-root", notVault], home);
    expect(badRoot.status).toBe(2);

    const missingRoot = runPirenSkills(["doctor", "--profile", "okf", "--vault-root", join(home, "missing")], home);
    expect(missingRoot.status).toBe(2);
  });

  it("doctor reports user-modified for a steward-edited seeded copy", async () => {
    const vault = await makeVault(home, "modified");
    const seed = runPirenSkills(["seed", "--profile", "okf", "--yes", "--vault-root", vault], home);
    expect(seed.status).toBe(0);
    const target = join(vault, "skills", "okf-authoring", "SKILL.md");
    const content = await readFile(target, "utf8");
    await writeFile(target, content.replace("# OKF Authoring", "# OKF Authoring (edited)"), "utf8");
    const after = runPirenSkills(["doctor", "--profile", "okf", "--vault-root", vault], home);
    expect(after.status).toBe(0);
    expect(after.stdout).toContain("user-modified");
  });

  it("doctor without --profile covers every available profile", async () => {
    const vault = await makeVault(home, "all-profiles");
    const run = runPirenSkills(["doctor", "--vault-root", vault], home);
    expect(run.status).toBe(0);
    expect(run.stdout.toLowerCase()).toContain("profile: okf");
  });
});
