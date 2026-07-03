import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initVault, scaffoldAgentDirectory } from "../src/init.js";

describe("init: scaffoldAgentDirectory", () => {
  it("scaffolds a single agent dir inside an existing vault without re-initializing the vault", async () => {
    const vault = await mkdtemp(join(tmpdir(), "piren-scaffold-"));
    try {
      // Set up an existing vault with one agent already present.
      await initVault({ vaultRoot: vault, agentName: "piren" });

      // Adding a second agent must NOT trip initVault's "vault file already
      // exists" guard. It should only create the new agent's dir.
      const result = await scaffoldAgentDirectory({ vaultRoot: vault, agentName: "thor" });
      expect(result.agentDir).toBe(join(vault, "team", "thor"));

      // Identity files present.
      await expect(access(join(vault, "team", "thor", "SOUL.md"))).resolves.toBeUndefined();
      await expect(access(join(vault, "team", "thor", "MEMORY.md"))).resolves.toBeUndefined();
      await expect(access(join(vault, "team", "thor", "config.yml"))).resolves.toBeUndefined();

      // Subdirectories present.
      await expect(access(join(vault, "team", "thor", "inbox"))).resolves.toBeUndefined();
      await expect(access(join(vault, "team", "thor", "sessions"))).resolves.toBeUndefined();
      await expect(access(join(vault, "team", "thor", "cron", "jobs"))).resolves.toBeUndefined();
      await expect(access(join(vault, "team", "thor", "cron", "runs"))).resolves.toBeUndefined();

      // Fresh scaffolded cron directories must be empty: no jobs or runs are seeded.
      await expect(readdir(join(vault, "team", "thor", "cron", "jobs"))).resolves.toEqual([]);
      await expect(readdir(join(vault, "team", "thor", "cron", "runs"))).resolves.toEqual([]);

      // The existing piren agent is untouched.
      await expect(access(join(vault, "team", "piren", "SOUL.md"))).resolves.toBeUndefined();

      // The SOUL title is derived from the name.
      const soul = await readFile(join(vault, "team", "thor", "SOUL.md"), "utf8");
      expect(soul).toContain("# Thor");

      const config = await readFile(join(vault, "team", "thor", "config.yml"), "utf8");
      expect(config).not.toContain("model: {}");
      expect(config).toContain("No model is configured yet");
      expect(config).toContain("used by `piren worker`");
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it("initializes the first agent with explanatory empty config comments", async () => {
    const vault = await mkdtemp(join(tmpdir(), "piren-init-config-"));
    try {
      await initVault({ vaultRoot: vault, agentName: "piren" });
      const config = await readFile(join(vault, "team", "piren", "config.yml"), "utf8");
      expect(config).not.toContain("model: {}");
      expect(config).toContain("No model is configured yet");
      expect(config).toContain("poll_interval_active_seconds");
      expect(config).toContain("used by `piren worker`");
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it("rejects an invalid agent name", async () => {
    const vault = await mkdtemp(join(tmpdir(), "piren-scaffold2-"));
    try {
      await expect(scaffoldAgentDirectory({ vaultRoot: vault, agentName: "BAD" })).rejects.toThrow(/invalid agent name/i);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});
