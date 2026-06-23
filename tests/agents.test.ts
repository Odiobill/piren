import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listPirenAgents, formatAgentsReport } from "../src/agents.js";
import { initVault } from "../src/init.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-agents-"));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("Piren agents listing", () => {
  it("lists vault-defined agents and marks the local runnable subset without selecting one", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    await mkdir(join(root, "team", "heimdall"), { recursive: true });
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n  - piren\nexcluded_agents:\n  - piren\n`);

    const report = await listPirenAgents({ configPath });

    expect(report.vaultRoot).toBe(root);
    expect(report.vaultAgents).toEqual(["heimdall", "thor"]);
    expect(report.allowedAgents).toEqual(["thor", "piren"]);
    expect(report.excludedAgents).toEqual(["piren"]);
    expect(report.runnableAgents).toEqual(["thor"]);
    expect(report.missingAllowedAgents).toEqual(["piren"]);

    const output = formatAgentsReport(report);
    expect(output).toContain("Piren agents");
    expect(output).toContain("[runnable] thor");
    expect(output).toContain("[stale] heimdall");
    expect(output).toContain("[missing] piren");
  });

  it("flags unsafe policy when allowed_agents is empty and vault_root is set", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    await writeFile(configPath, "vault_root: " + root + "\n");

    const report = await listPirenAgents({ configPath });

    expect(report.vaultAgents).toEqual(["thor"]);
    expect(report.allowedAgents).toEqual([]);
    expect(report.unsafePolicy).toBe(true);

    const output = formatAgentsReport(report);
    expect(output).toContain("WARNING: no allowed_agents configured");
  });

  it("flags stale vault directories missing SOUL.md or MEMORY.md", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    // heimdall is a raw directory with no agent files — stale
    await mkdir(join(root, "team", "heimdall"), { recursive: true });
    const configPath = join(root, "config.yml");
    await writeFile(configPath, "vault_root: " + root + "\n" + "allowed_agents:\n" + "  - thor\n");

    const report = await listPirenAgents({ configPath });

    expect(report.vaultAgents).toEqual(["heimdall", "thor"]);
    expect(report.runnableAgents).toEqual(["thor"]);
    expect(report.staleVaultAgents).toEqual(["heimdall"]);

    const output = formatAgentsReport(report);
    expect(output).toContain("[stale] heimdall");
  });
});
