import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from "node:fs/promises";
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

      // The existing piren agent is untouched.
      await expect(access(join(vault, "team", "piren", "SOUL.md"))).resolves.toBeUndefined();

      // The SOUL title is derived from the name.
      const soul = await readFile(join(vault, "team", "thor", "SOUL.md"), "utf8");
      expect(soul).toContain("# Thor");
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
