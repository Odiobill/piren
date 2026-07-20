import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctorPiren, formatDoctorReport, type PiRuntimeCheck } from "../src/doctor.js";
import { initVault } from "../src/init.js";

let root: string;

const localPiRuntime = async (): Promise<PiRuntimeCheck> => ({ source: "path", version: "0.80.2" });
const missingPiRuntime = async (): Promise<PiRuntimeCheck> => ({ source: "unavailable", error: "Pi Coding Agent not found on PATH." });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-doctor-"));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("Piren doctor", () => {
  it("reports ok checks for an initialized runnable agent", async () => {
    const init = await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.ok).toBe(true);
    expect(report.agentName).toBe("thor");
    expect(report.agentDir).toBe(init.agentDir);
    expect(report.vaultRoot).toBe(root);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "runnable-agent-policy", status: "ok" }),
      expect.objectContaining({ id: "vault-layout", status: "ok" }),
      expect.objectContaining({ id: "agent-files", status: "ok" }),
      expect.objectContaining({ id: "pi-runtime", status: "ok", message: expect.stringContaining("PATH") }),
    ]));
  });

  it("checks every enabled agent when no specific agent is selected", async () => {
    const thor = await initVault({ vaultRoot: root, agentName: "thor" });
    const heimdall = await initVault({ vaultRoot: root, agentName: "heimdall", force: true });
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n  - heimdall\n`);

    const report = await doctorPiren({ env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.ok).toBe(true);
    expect(report.agentName).toBeUndefined();
    expect(report.agentDir).toBeUndefined();
    expect(report.vaultRoot).toBe(root);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "agent-files:thor", status: "ok", message: expect.stringContaining(thor.agentDir) }),
      expect.objectContaining({ id: "agent-files:heimdall", status: "ok", message: expect.stringContaining(heimdall.agentDir) }),
      expect.objectContaining({ id: "pi-runtime", status: "ok" }),
    ]));
  });

  it("fails all-agent doctor when one enabled agent is missing required files", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const heimdall = await initVault({ vaultRoot: root, agentName: "heimdall", force: true });
    await unlink(join(heimdall.agentDir, "SOUL.md"));
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n  - heimdall\n`);

    const report = await doctorPiren({ env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "agent-files:heimdall", status: "fail", message: expect.stringContaining("SOUL.md") }),
    ]));
  });

  it("reports missing local pi as a failure", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: missingPiRuntime });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "pi-runtime", status: "fail", message: expect.stringContaining("curl -fsSL https://pi.dev/install.sh | sh") }),
    );
  });

  it("reports missing required agent files without creating them", async () => {
    const init = await initVault({ vaultRoot: root, agentName: "thor" });
    await unlink(join(init.agentDir, "SOUL.md"));
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      id: "agent-files",
      status: "fail",
      message: expect.stringContaining("SOUL.md"),
    }));
  });

  it("formats report checks for CLI output", async () => {
    const report = await doctorPiren({ cliAgentDir: join(root, "missing", "team", "thor"), env: {}, configPath: join(root, "missing-config.yml"), piRuntimeChecker: localPiRuntime });

    const output = formatDoctorReport(report);

    expect(output).toContain("Piren doctor");
    expect(output).toMatch(/\[FAIL\]/);
  });

  it("warns when allowed_agents is empty and vault_root is configured (unsafe allow-all)", async () => {
    const init = await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    // vault_root set, but no allowed_agents --- any agent could run
    await writeFile(configPath, "vault_root: " + root + "\n");

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.ok).toBe(true); // warn, not fail
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "policy-gap", status: "warn" }),
    ]));
  });

  it("warns when allowed_agents contains entries not found in vault team/", async () => {
    const init = await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    // odin exists in allowed but not in vault team/
    await writeFile(configPath, "vault_root: " + root + "\n" + "allowed_agents:\n" + "  - thor\n" + "  - odin\n");

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.ok).toBe(true); // warn, not fail
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "stale-allowed", status: "warn" }),
    ]));
  });

  it("warns when an agent appears in both allowed_agents and excluded_agents", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    await initVault({ vaultRoot: root, agentName: "odin", force: true });
    const configPath = join(root, "config.yml");
    // thor in both lists — excluded wins for execution, but it's a config smell
    await writeFile(configPath, "vault_root: " + root + "\n" + "allowed_agents:\n" + "  - thor\n" + "  - odin\n" + "excluded_agents:\n" + "  - thor\n");

    const report = await doctorPiren({ cliAgent: "odin", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.ok).toBe(true); // warn, not fail (odin is still runnable)
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "policy-overlap", status: "warn" }),
    ]));
  });

  it("warns when allowed_agents contains invalid agent name patterns", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    // "Bad Agent" has a space, "UPPER" has uppercase — both invalid
    await writeFile(configPath, "vault_root: " + root + "\n" + "allowed_agents:\n" + "  - thor\n" + "  - Bad Agent\n" + "  - UPPER\n");

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.ok).toBe(true); // warn, not fail
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "invalid-agent-name", status: "warn" }),
    ]));
  });

  it("reports ok when all declared packages are installed", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    await writeFile(configPath, "vault_root: " + root + "\n" + "allowed_agents:\n" + "  - thor\n" + "packages:\n" + '  - "@piren/web-search"\n');
    const fakeResolver = (name: string) => "/fake/node_modules/" + name + "/index.js";

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, packageResolver: fakeResolver, piRuntimeChecker: localPiRuntime });

    expect(report.ok).toBe(true);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "packages", status: "ok" }),
    );
  });

  it("warns when declared packages are not installed", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    await writeFile(configPath, "vault_root: " + root + "\n" + "allowed_agents:\n" + "  - thor\n" + "packages:\n" + '  - "@piren/web-search"\n' + '  - "@piren/missing"\n');
    const fakeResolver = (name: string) => {
      if (name === "@piren/missing") throw new Error("Cannot find module '@piren/missing'");
      return "/fake/node_modules/" + name + "/index.js";
    };

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, packageResolver: fakeResolver, piRuntimeChecker: localPiRuntime });

    expect(report.ok).toBe(true); // warn, not fail
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "packages", status: "warn", message: expect.stringContaining("@piren/missing") }),
    );
  });

  it("omits the packages check when no packages are declared", async () => {
    const init = await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.checks).not.toContainEqual(
      expect.objectContaining({ id: "packages" }),
    );
  });

  it("reports group membership (informational ok) for a selected agent when agent-groups/ exists", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    await initVault({ vaultRoot: root, agentName: "odin", force: true });
    const groupsDir = join(root, "agent-groups", "developers");
    await mkdir(groupsDir, { recursive: true });
    await writeFile(join(groupsDir, "config.yml"), "agents:\n  - thor\n  - odin\n");
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "agent-groups-membership", status: "ok", message: expect.stringContaining("developers") }),
    );
  });

  it("reports group membership for all runnable agents when no specific agent is selected", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    await initVault({ vaultRoot: root, agentName: "odin", force: true });
    const groupsDir = join(root, "agent-groups", "developers");
    await mkdir(groupsDir, { recursive: true });
    await writeFile(join(groupsDir, "config.yml"), "agents:\n  - thor\n  - odin\n");
    // reviewers: only odin
    const revDir = join(root, "agent-groups", "reviewers");
    await mkdir(revDir, { recursive: true });
    await writeFile(join(revDir, "config.yml"), "agents:\n  - odin\n");
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n  - odin\n`);

    const report = await doctorPiren({ env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "agent-groups-membership", status: "ok", message: expect.stringContaining("developers") }),
    );
  });

  it("does not emit agent-groups-membership when agent-groups/ is missing", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.checks).not.toContainEqual(
      expect.objectContaining({ id: "agent-groups-membership" }),
    );
  });

  it("warns on stale group agents (agents in config but not in team/)", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const groupsDir = join(root, "agent-groups", "developers");
    await mkdir(groupsDir, { recursive: true });
    await writeFile(join(groupsDir, "config.yml"), "agents:\n  - thor\n  - loki\n");
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "agent-groups-stale-agents", status: "warn", message: expect.stringContaining("loki") }),
    );
  });

  it("does not emit agent-groups-stale-agents when agent-groups/ is missing", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.checks).not.toContainEqual(
      expect.objectContaining({ id: "agent-groups-stale-agents" }),
    );
  });

  it("warns on skill conflicts between groups the agent belongs to", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    // developers group with skill "code-review" body A
    const devSkillsDir = join(root, "agent-groups", "developers", "skills");
    await mkdir(devSkillsDir, { recursive: true });
    await writeFile(join(root, "agent-groups", "developers", "config.yml"), "agents:\n  - thor\n");
    await writeFile(join(devSkillsDir, "code-review.md"), "Developer review process body.");
    // reviewers group with skill "code-review" body B (different)
    const revSkillsDir = join(root, "agent-groups", "reviewers", "skills");
    await mkdir(revSkillsDir, { recursive: true });
    await writeFile(join(root, "agent-groups", "reviewers", "config.yml"), "agents:\n  - thor\n");
    await writeFile(join(revSkillsDir, "code-review.md"), "Reviewer review process body.");
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "agent-groups-skill-conflicts", status: "warn", message: expect.stringContaining("code-review") }),
    );
  });

  it("does not warn on skill conflicts when bodies are identical", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const identicalBody = "Identical review process.";
    // developers group
    await mkdir(join(root, "agent-groups", "developers", "skills"), { recursive: true });
    await writeFile(join(root, "agent-groups", "developers", "config.yml"), "agents:\n  - thor\n");
    await writeFile(join(root, "agent-groups", "developers", "skills", "code-review.md"), identicalBody);
    // reviewers group with same body
    await mkdir(join(root, "agent-groups", "reviewers", "skills"), { recursive: true });
    await writeFile(join(root, "agent-groups", "reviewers", "config.yml"), "agents:\n  - thor\n");
    await writeFile(join(root, "agent-groups", "reviewers", "skills", "code-review.md"), identicalBody);
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.checks).not.toContainEqual(
      expect.objectContaining({ id: "agent-groups-skill-conflicts", status: "warn" }),
    );
  });

  it("only checks skill conflicts for groups the agent belongs to", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    // developers: thor is a member, has skill "code-review"
    await mkdir(join(root, "agent-groups", "developers", "skills"), { recursive: true });
    await writeFile(join(root, "agent-groups", "developers", "config.yml"), "agents:\n  - thor\n");
    await writeFile(join(root, "agent-groups", "developers", "skills", "code-review.md"), "Dev body.");
    // reviewers: thor is NOT a member, has conflicting skill "code-review"
    await mkdir(join(root, "agent-groups", "reviewers", "skills"), { recursive: true });
    await writeFile(join(root, "agent-groups", "reviewers", "config.yml"), "agents:\n  - odin\n");
    await writeFile(join(root, "agent-groups", "reviewers", "skills", "code-review.md"), "Reviewer body - different.");
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    // No conflict because thor is only in developers, not reviewers
    expect(report.checks).not.toContainEqual(
      expect.objectContaining({ id: "agent-groups-skill-conflicts", status: "warn" }),
    );
  });

  it("does not emit agent-groups-skill-conflicts when agent-groups/ is missing", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.checks).not.toContainEqual(
      expect.objectContaining({ id: "agent-groups-skill-conflicts" }),
    );
  });

  it("places group membership check before agent-files in output order", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const groupsDir = join(root, "agent-groups", "developers");
    await mkdir(groupsDir, { recursive: true });
    await writeFile(join(groupsDir, "config.yml"), "agents:\n  - thor\n");
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    const ids = report.checks.map((c) => c.id);
    const membershipIdx = ids.indexOf("agent-groups-membership");
    const agentFilesIdx = ids.indexOf("agent-files");
    expect(membershipIdx).not.toBe(-1);
    expect(agentFilesIdx).not.toBe(-1);
    expect(membershipIdx).toBeLessThan(agentFilesIdx);
  });

  it("warning/OK doctor scenarios do not depend on host Pi (hermetic)", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    // Empty allowed_agents yields a policy-gap warning (ok, not fail).
    await writeFile(configPath, `vault_root: ${root}\n`);

    // No pi on PATH, but the injected checker makes the result deterministic and
    // independent of the host (the CI runner has no pi during unit tests).
    const report = await doctorPiren({ cliAgent: "thor", env: { PATH: "/var/empty" }, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.ok).toBe(true); // warn, not fail — holds with NO pi on PATH
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "pi-runtime", status: "ok" }));
  });

  it("default pi-runtime check fails when PATH has no pi (CI no-Pi condition)", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    // No injected checker: the default checker consults PATH. With no pi
    // resolvable (the CI unit-test condition), pi-runtime fails and doctor is
    // not ok. This documents why non-Pi-discovery tests must inject a checker.
    const report = await doctorPiren({ cliAgent: "thor", env: { PATH: "/var/empty" }, configPath });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "pi-runtime", status: "fail" }));
  });
});
