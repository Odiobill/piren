import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPirenContext, resolveAgentDir } from "../src/bootstrap.js";

let root: string;
let vault: string;
let agentDir: string;

async function makeFixture() {
  root = await mkdtemp(join(tmpdir(), "piren-bootstrap-"));
  vault = join(root, "vault");
  agentDir = join(vault, "team", "thor");
  await mkdir(join(agentDir, "inbox"), { recursive: true });
  await mkdir(join(agentDir, "outbox"), { recursive: true });
  await mkdir(join(agentDir, "logs"), { recursive: true });
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await writeFile(join(vault, ".piren-vault"), "");
  await writeFile(join(vault, "steward-directives.md"), "# Steward\nStay boring.\n");
  await writeFile(join(agentDir, "SOUL.md"), "# Thor\nI am Thor.\n");
  await writeFile(join(agentDir, "MEMORY.md"), "# Memory\n");
  await writeFile(join(agentDir, "config.yml"), "model: test-model\n");
}

beforeEach(makeFixture);
afterEach(async () => rm(root, { recursive: true, force: true }));

describe("Piren bootstrap", () => {
  it("resolves the agent directory from CLI before environment and local config", async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), "piren-other-"));
    try {
      const configPath = join(root, "config.yml");
      await writeFile(configPath, `agent_dir: ${otherRoot}\n`);

      const resolved = await resolveAgentDir({
        cliAgentDir: agentDir,
        env: { PIREN_AGENT_DIR: otherRoot },
        configPath,
      });

      expect(resolved).toBe(agentDir);
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it("loads SOUL.md and steward-directives.md without using directives for discovery", async () => {
    const context = await loadPirenContext({ cliAgentDir: agentDir, env: {}, configPath: join(root, "missing-config.yml") });

    expect(context.agentName).toBe("thor");
    expect(context.agentDir).toBe(agentDir);
    expect(context.vaultRoot).toBe(vault);
    expect(context.soul).toContain("I am Thor");
    expect(context.stewardDirectives).toContain("Stay boring");
    await expect(stat(join(context.agentDir, "logs"))).resolves.toBeDefined();
  });

  it("uses vault_root plus explicit CLI agent to derive agent_dir", async () => {
    const configPath = join(root, "home-config.yml");
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\n`);

    const context = await loadPirenContext({ cliAgent: "thor", env: {}, configPath });

    expect(context.agentName).toBe("thor");
    expect(context.agentDir).toBe(agentDir);
    expect(context.vaultRoot).toBe(vault);
    expect(context.allowedAgents).toEqual(["thor"]);
  });

  it("uses PIREN_AGENT plus vault_root to derive agent_dir", async () => {
    const configPath = join(root, "env-agent.yml");
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\n`);

    const context = await loadPirenContext({ env: { PIREN_AGENT: "thor" }, configPath });

    expect(context.agentName).toBe("thor");
    expect(context.agentDir).toBe(agentDir);
  });

  it("infers the agent when exactly one allowed_agent is configured", async () => {
    const configPath = join(root, "single-agent.yml");
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\n`);

    const context = await loadPirenContext({ env: {}, configPath });

    expect(context.agentName).toBe("thor");
    expect(context.agentDir).toBe(agentDir);
  });

  it("rejects ambiguous vault_root config without explicit agent", async () => {
    const configPath = join(root, "ambiguous.yml");
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\n  - heimdall\n`);

    await expect(loadPirenContext({ env: {}, configPath })).rejects.toThrow(/pass --agent or set PIREN_AGENT/i);
  });

  it("rejects an agent blocked by local runnable-agent policy", async () => {
    const configPath = join(root, "blocked.yml");
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - heimdall\nexcluded_agents:\n  - thor\n`);

    await expect(loadPirenContext({ cliAgent: "thor", env: {}, configPath })).rejects.toThrow(/not allowed/i);
  });
});
