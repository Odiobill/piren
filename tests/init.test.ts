import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPirenContext } from "../src/bootstrap.js";
import { initVault } from "../src/init.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-init-"));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("Piren vault initialization", () => {
  it("creates a minimal vault fixture for one agent in any directory", async () => {
    const result = await initVault({ vaultRoot: root, agentName: "thor" });

    expect(result.vaultRoot).toBe(root);
    expect(result.agentDir).toBe(join(root, "team", "thor"));
    await expect(stat(join(root, ".piren-vault"))).resolves.toBeDefined();
    await expect(stat(join(root, "steward-directives.md"))).resolves.toBeDefined();
    await expect(stat(join(root, "team", "thor", "SOUL.md"))).resolves.toBeDefined();
    await expect(stat(join(root, "team", "thor", "MEMORY.md"))).resolves.toBeDefined();
    await expect(stat(join(root, "team", "thor", "config.yml"))).resolves.toBeDefined();
    await expect(stat(join(root, "team", "thor", "inbox"))).resolves.toBeDefined();
    await expect(stat(join(root, "team", "thor", "outbox"))).resolves.toBeDefined();
    await expect(stat(join(root, "team", "thor", "devices"))).resolves.toBeDefined();
    await expect(stat(join(root, "team", "thor", "logs"))).resolves.toBeDefined();
    await expect(stat(join(root, "team", "thor", "sessions"))).resolves.toBeDefined();
    await expect(stat(join(root, "agent-groups"))).resolves.toBeDefined();
    await expect(stat(join(root, "team", "groups"))).rejects.toThrow();
    await expect(stat(join(root, "Projects"))).resolves.toBeDefined();
    await expect(stat(join(root, "wiki", "concepts"))).resolves.toBeDefined();
    await expect(stat(join(root, "wiki", "entities"))).resolves.toBeDefined();

    const directives = await readFile(join(root, "steward-directives.md"), "utf8");
    expect(directives).toContain("Use OKF frontmatter with a non-empty type field");
    expect(directives).toContain("wiki_update_concept");
    const soul = await readFile(join(root, "team", "thor", "SOUL.md"), "utf8");
    expect(soul).toContain("When importing existing project material");
    expect(soul).toContain("wiki/concepts");

    const config = await readFile(join(root, "team", "thor", "config.yml"), "utf8");
    expect(config).not.toContain("allowed_agents:");
    expect(config).toContain("model:");
  });

  it("defaults the first agent to piren when no agent name is specified", async () => {
    const result = await initVault({ vaultRoot: root });

    expect(result.agentName).toBe("piren");
    expect(result.agentDir).toBe(join(root, "team", "piren"));
    await expect(stat(join(root, "team", "piren", "SOUL.md"))).resolves.toBeDefined();

    const config = await readFile(join(root, "team", "piren", "config.yml"), "utf8");
    expect(config).not.toContain("allowed_agents:");
    expect(config).toContain("model:");
  });

  it("creates a vault that can be immediately bootstrapped", async () => {
    const result = await initVault({ vaultRoot: root, agentName: "thor" });

    const context = await loadPirenContext({ cliAgentDir: result.agentDir, env: {}, configPath: join(root, "missing-config.yml") });

    expect(context.vaultRoot).toBe(root);
    expect(context.agentName).toBe("thor");
    expect(context.soul).toContain("# Thor");
    expect(context.stewardDirectives).toContain("# Steward Directives");
  });

  it("refuses to overwrite existing files unless force is enabled", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });

    await expect(initVault({ vaultRoot: root, agentName: "thor" })).rejects.toThrow(/already exists/i);
    await expect(initVault({ vaultRoot: root, agentName: "thor", force: true })).resolves.toBeDefined();
  });

  it("normalizes unsafe agent names", async () => {
    await expect(initVault({ vaultRoot: root, agentName: "../thor" })).rejects.toThrow(/agent name/i);
    await expect(initVault({ vaultRoot: root, agentName: "Thor Prime" })).rejects.toThrow(/agent name/i);
  });
});
