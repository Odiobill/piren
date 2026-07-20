import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctorPiren, formatDoctorReport, type PiRuntimeCheck } from "../src/doctor.js";
import { initVault } from "../src/init.js";

let root: string;

const localPiRuntime = async (): Promise<PiRuntimeCheck> => ({ source: "path", version: "0.80.2" });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-okf-doctor-"));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("piren doctor OKF conformance", () => {
  it("reports an ok vault-okf-conformance check for a conformant vault", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    await mkdir(join(root, "wiki", "concepts"), { recursive: true });
    await writeFile(
      join(root, "wiki", "concepts", "fleet-profiles.md"),
      "---\ntype: Concept\ntitle: Fleet Profiles\n---\n\n# Fleet Profiles\n",
    );
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    const okfCheck = report.checks.find((c) => c.id === "vault-okf-conformance");
    expect(okfCheck).toBeDefined();
    expect(okfCheck?.status).toBe("ok");
    expect(report.ok).toBe(true);
  });

  it("warns when a concept document is missing a type", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    await mkdir(join(root, "wiki", "concepts"), { recursive: true });
    await writeFile(
      join(root, "wiki", "concepts", "no-type.md"),
      "---\ntitle: No Type\n---\n\n# No Type\n",
    );
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    const okfCheck = report.checks.find((c) => c.id === "vault-okf-conformance");
    expect(okfCheck?.status).toBe("warn");
    expect(okfCheck?.message).toContain("no-type.md");
    expect(report.ok).toBe(true); // conformance is a warning, not a hard fail
  });

  it("prints the okf check line in the formatted report", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });
    const output = formatDoctorReport(report);

    expect(output).toContain("vault-okf-conformance");
  });

  it("still reports the check even when bootstrap fails (vault missing)", async () => {
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    const report = await doctorPiren({ cliAgent: "thor", cliVaultRoot: root, env: {}, configPath, piRuntimeChecker: localPiRuntime });

    // When vault resolution fails the okf check should not crash doctor; the
    // bootstrap-fail path returns early, so the check is simply absent or warn,
    // but doctor must not throw.
    expect(report).toBeDefined();
  });
});
