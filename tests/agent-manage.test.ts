import { describe, expect, it } from "vitest";
import {
  AGENT_NAME_PATTERN,
  validateAgentName,
  addAllowedAgent,
  removeAllowedAgent,
  agentDirPath,
  planAddAgent,
  planRemoveAgent,
  planCloneAgent,
  executeAddAgent,
  executeCloneAgent,
  type AgentManageDeps,
  type AddAgentResult,
} from "../src/agent-manage.js";
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("agent-manage: name validation", () => {
  it("accepts lowercase kebab-case names", () => {
    expect(validateAgentName("piren").ok).toBe(true);
    expect(validateAgentName("research-agent").ok).toBe(true);
    expect(validateAgentName("a1").ok).toBe(true);
  });

  it("rejects names with slashes, dots, uppercase, or leading digits", () => {
    expect(validateAgentName("../escape").ok).toBe(false);
    expect(validateAgentName("UPPER").ok).toBe(false);
    expect(validateAgentName("1leading-digit").ok).toBe(false);
    expect(validateAgentName("has space").ok).toBe(false);
    expect(validateAgentName("").ok).toBe(false);
  });

  it("exposes the pattern so callers can pre-check", () => {
    expect(AGENT_NAME_PATTERN.test("piren")).toBe(true);
    expect(AGENT_NAME_PATTERN.test("../escape")).toBe(false);
  });
});

describe("agent-manage: allowed_agents list editing (pure)", () => {
  it("addAllowedAgent appends to an existing list without duplicates", () => {
    expect(addAllowedAgent(["piren"], "thor")).toEqual(["piren", "thor"]);
    expect(addAllowedAgent(["piren"], "piren")).toEqual(["piren"]);
    expect(addAllowedAgent([], "thor")).toEqual(["thor"]);
  });

  it("removeAllowedAgent drops a name and returns the rest", () => {
    expect(removeAllowedAgent(["piren", "thor"], "piren")).toEqual(["thor"]);
    expect(removeAllowedAgent(["piren"], "piren")).toEqual([]);
    expect(removeAllowedAgent(["piren"], "absent")).toEqual(["piren"]);
  });
});

describe("agent-manage: agent dir path", () => {
  it("resolves team/<agent> under the vault root", () => {
    expect(agentDirPath("/vault", "thor")).toBe("/vault/team/thor");
  });
});

describe("agent-manage: add plan", () => {
  it("plans scaffolding team/<name>/ and adding to allowed_agents", async () => {
    const vault = await mkdtemp(join(tmpdir(), "piren-agent-add-"));
    try {
      // Pre-seed an existing vault with one agent.
      await mkdir(join(vault, "team", "piren"), { recursive: true });
      await writeFile(join(vault, ".piren-vault"), "");
      await writeFile(join(vault, "steward-directives.md"), "# directives");
      const existingConfig = ["vault_root: " + vault, "", "allowed_agents:", "  - piren", ""].join("\n");

      const result = planAddAgent({
        vaultRoot: vault,
        agentName: "thor",
        existingConfig,
        force: false,
      });

      expect(result.shouldScaffold).toBe(true);
      expect(result.shouldUpdateConfig).toBe(true);
      expect(result.updatedConfig).toContain("- piren");
      expect(result.updatedConfig).toContain("- thor");
      // Existing config keys preserved (vault_root survives).
      expect(result.updatedConfig).toContain("vault_root:");
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it("refuses to add an agent whose team dir already exists without --force", async () => {
    const vault = await mkdtemp(join(tmpdir(), "piren-agent-add2-"));
    try {
      await mkdir(join(vault, "team", "existing"), { recursive: true });
      // The pure plan reports intent; the executor enforces existence. Verify
      // the executor path (with an injected exists dep) refuses without --force.
      const deps: AgentManageDeps = {
        exists: async () => true,
        scaffoldAgentDir: async () => join(vault, "team", "existing"),
        copyDir: async () => {},
        removeDir: async () => {},
        log: () => {},
      };
      const result = await executeAddAgent({
        vaultRoot: vault,
        agentName: "existing",
        existingConfig: "",
        force: false,
        deps,
      });
      expect(result.error).toMatch(/already exists|--force/i);
      expect(result.configUpdated).toBe(false);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});

describe("agent-manage: remove plan", () => {
  it("always drops the agent from allowed_agents and plans dir removal", async () => {
    const vault = await mkdtemp(join(tmpdir(), "piren-agent-rm-"));
    try {
      await mkdir(join(vault, "team", "thor"), { recursive: true });
      const existingConfig = ["vault_root: " + vault, "", "allowed_agents:", "  - piren", "  - thor", ""].join("\n");

      const result = planRemoveAgent({
        vaultRoot: vault,
        agentName: "thor",
        existingConfig,
      });

      expect(result.shouldRemoveDir).toBe(true);
      expect(result.dirPath).toBe(join(vault, "team", "thor"));
      expect(result.shouldUpdateConfig).toBe(true);
      expect(result.updatedConfig).toContain("- piren");
      expect(result.updatedConfig).not.toContain("- thor");
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it("still drops from allowed_agents even if the vault dir is already gone", async () => {
    const vault = await mkdtemp(join(tmpdir(), "piren-agent-rm2-"));
    try {
      const existingConfig = ["allowed_agents:", "  - thor", ""].join("\n");
      // The pure plan always reports dir-removal intent; the executor decides
      // whether the dir was actually present. With an injected exists=false dep
      // and confirmation, the dir is not removed but config is still updated.
      const deps: AgentManageDeps = {
        exists: async () => false,
        scaffoldAgentDir: async () => "",
        copyDir: async () => {},
        removeDir: async () => {},
        log: () => {},
      };
      const { executeRemoveAgent } = await import("../src/agent-manage.js");
      const result = await executeRemoveAgent({
        vaultRoot: vault,
        agentName: "thor",
        existingConfig,
        confirmedDeleteDir: true,
        deps,
      });
      expect(result.dirRemoved).toBe(false);
      expect(result.configUpdated).toBe(true);
      expect(result.updatedConfig).not.toContain("- thor");
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});

describe("agent-manage: clone plan", () => {
  it("plans copying an existing agent dir to a new name and permitting it", async () => {
    const vault = await mkdtemp(join(tmpdir(), "piren-agent-clone-"));
    try {
      // Source agent exists with identity files.
      await mkdir(join(vault, "team", "piren"), { recursive: true });
      await writeFile(join(vault, "team", "piren", "SOUL.md"), "# Piren\n");
      await writeFile(join(vault, "team", "piren", "MEMORY.md"), "# Memory\n");
      const existingConfig = ["vault_root: " + vault, "", "allowed_agents:", "  - piren", ""].join("\n");

      const result = planCloneAgent({
        vaultRoot: vault,
        sourceAgent: "piren",
        targetAgent: "thor",
        existingConfig,
      });

      expect(result.shouldCopy).toBe(true);
      expect(result.sourceDir).toBe(join(vault, "team", "piren"));
      expect(result.targetDir).toBe(join(vault, "team", "thor"));
      expect(result.updatedConfig).toContain("- piren");
      expect(result.updatedConfig).toContain("- thor");
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it("refuses to clone from a source agent that does not exist", async () => {
    const vault = await mkdtemp(join(tmpdir(), "pa-clone2-"));
    try {
      // Executor enforces source existence via the injected exists dep. We
      // distinguish source vs target by the trailing team/<name> segment.
      const deps: AgentManageDeps = {
        exists: async (p: string) => p.endsWith("/team/piren"),
        scaffoldAgentDir: async () => "",
        copyDir: async () => {},
        removeDir: async () => {},
        log: () => {},
      };
      const result = await executeCloneAgent({
        vaultRoot: vault,
        sourceAgent: "ghost",
        targetAgent: "thor",
        existingConfig: "",
        deps,
      });
      expect(result.error).toMatch(/not found|does not exist|source/i);
      expect(result.configUpdated).toBe(false);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it("refuses to clone onto a target agent that already exists", async () => {
    const vault = await mkdtemp(join(tmpdir(), "piren-agent-clone3-"));
    try {
      // Both source and target "exist" per the injected dep.
      const deps: AgentManageDeps = {
        exists: async () => true,
        scaffoldAgentDir: async () => "",
        copyDir: async () => {},
        removeDir: async () => {},
        log: () => {},
      };
      const result = await executeCloneAgent({
        vaultRoot: vault,
        sourceAgent: "piren",
        targetAgent: "thor",
        existingConfig: "",
        deps,
      });
      expect(result.error).toMatch(/already exists/i);
      expect(result.configUpdated).toBe(false);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});

describe("agent-manage: execution with injected deps", () => {
  function makeDeps(_vault: string): AgentManageDeps {
    return {
      exists: async (path: string) => {
        const { access } = await import("node:fs/promises");
        try {
          await access(path);
          return true;
        } catch {
          return false;
        }
      },
      scaffoldAgentDir: async (vaultRoot: string, agentName: string) => {
        const dir = join(vaultRoot, "team", agentName);
        await mkdir(join(dir, "inbox"), { recursive: true });
        await mkdir(join(dir, "sessions"), { recursive: true });
        await mkdir(join(dir, "devices"), { recursive: true });
        await writeFile(join(dir, "SOUL.md"), "# " + agentName + "\n");
        await writeFile(join(dir, "MEMORY.md"), "# " + agentName + " Memory\n");
        return dir;
      },
      copyDir: async (src: string, dest: string) => {
        // Minimal recursive copy for the test.
        const { cp } = await import("node:fs/promises");
        await cp(src, dest, { recursive: true });
      },
      removeDir: async (path: string) => {
        await rm(path, { recursive: true, force: true });
      },
      log: () => {},
    };
  }

  it("add scaffolds the dir and returns the result", async () => {
    const vault = await mkdtemp(join(tmpdir(), "piren-agent-exec-add-"));
    try {
      const deps = makeDeps(vault);
      const result: AddAgentResult = await (await import("../src/agent-manage.js")).executeAddAgent({
        vaultRoot: vault,
        agentName: "thor",
        existingConfig: "",
        force: false,
        deps,
      });
      expect(result.scaffoldedDir).toBe(join(vault, "team", "thor"));
      const entries = await readdir(join(vault, "team", "thor"));
      expect(entries).toContain("SOUL.md");
      expect(entries).toContain("MEMORY.md");
      expect(entries).toContain("inbox");
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it("clone copies the source dir contents to the target", async () => {
    const vault = await mkdtemp(join(tmpdir(), "piren-agent-exec-clone-"));
    try {
      // Source agent with a custom SOUL that must be copied verbatim.
      await mkdir(join(vault, "team", "piren"), { recursive: true });
      await writeFile(join(vault, "team", "piren", "SOUL.md"), "# Piren the original\n");
      const deps = makeDeps(vault);
      const result = await (await import("../src/agent-manage.js")).executeCloneAgent({
        vaultRoot: vault,
        sourceAgent: "piren",
        targetAgent: "thor",
        existingConfig: "",
        deps,
      });
      expect(result.targetDir).toBe(join(vault, "team", "thor"));
      const soul = await readFile(join(vault, "team", "thor", "SOUL.md"), "utf8");
      expect(soul).toBe("# Piren the original\n");
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});
