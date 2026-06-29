import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
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

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      id: "agent-files",
      status: "fail",
      message: expect.stringContaining("SOUL.md"),
    }));
  });

  it("formats report checks for CLI output", async () => {
    const report = await doctorPiren({ cliAgentDir: join(root, "missing", "team", "thor"), env: {}, configPath: join(root, "missing-config.yml") });

    const output = formatDoctorReport(report);

    expect(output).toContain("Piren doctor");
    expect(output).toMatch(/\[FAIL\]/);
  });

  it("warns when allowed_agents is empty and vault_root is configured (unsafe allow-all)", async () => {
    const init = await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    // vault_root set, but no allowed_agents --- any agent could run
    await writeFile(configPath, "vault_root: " + root + "\n");

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath });

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

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath });

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

    const report = await doctorPiren({ cliAgent: "odin", env: {}, configPath });

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

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath });

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

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, packageResolver: fakeResolver });

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

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, packageResolver: fakeResolver });

    expect(report.ok).toBe(true); // warn, not fail
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "packages", status: "warn", message: expect.stringContaining("@piren/missing") }),
    );
  });

  it("omits the packages check when no packages are declared", async () => {
    const init = await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath });

    expect(report.checks).not.toContainEqual(
      expect.objectContaining({ id: "packages" }),
    );
  });
});
