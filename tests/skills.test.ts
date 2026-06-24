import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadVaultSkills } from "../src/skills.js";

async function makeVault(): Promise<{ vault: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "piren-skills-"));
  const vault = join(root, "vault");
  const sharedSkills = join(vault, "skills");
  const agentSkills = join(vault, "team", "thor", "skills");
  await mkdir(sharedSkills, { recursive: true });
  await mkdir(agentSkills, { recursive: true });
  return {
    vault,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("loadVaultSkills", () => {
  it("returns an empty list when no skills exist", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      const result = await loadVaultSkills(vault, "thor");
      expect(result.skills).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("loads a shared skill from vault/skills/ with name and description", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeFile(
        join(vault, "skills", "check-disk.md"),
        [
          "---",
          "name: check-disk",
          'description: "Check disk usage and report high partitions."',
          "---",
          "",
          "# Check Disk",
          "",
          "1. Run df -h",
        ].join("\n"),
      );
      const result = await loadVaultSkills(vault, "thor");
      expect(result.skills).toHaveLength(1);
      const skill = result.skills[0];
      expect(skill?.name).toBe("check-disk");
      expect(skill?.description).toBe("Check disk usage and report high partitions.");
      expect(skill?.body).toContain("# Check Disk");
      expect(skill?.source).toBe("shared");
    } finally {
      await cleanup();
    }
  });

  it("loads an agent-specific skill from team/<agent>/skills/", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeFile(
        join(vault, "team", "thor", "skills", "deploy.md"),
        [
          "---",
          "name: deploy",
          'description: "Deploy the app to staging."',
          "---",
          "",
          "# Deploy",
        ].join("\n"),
      );
      const result = await loadVaultSkills(vault, "thor");
      expect(result.skills).toHaveLength(1);
      const skill = result.skills[0];
      expect(skill?.name).toBe("deploy");
      expect(skill?.source).toBe("agent");
    } finally {
      await cleanup();
    }
  });

  it("agent-specific skills override shared skills with the same name", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeFile(
        join(vault, "skills", "common.md"),
        [
          "---",
          "name: common",
          'description: "Shared version."',
          "---",
          "",
          "# Shared Common",
        ].join("\n"),
      );
      await writeFile(
        join(vault, "team", "thor", "skills", "common.md"),
        [
          "---",
          "name: common",
          'description: "Agent override version."',
          "---",
          "",
          "# Agent Common",
        ].join("\n"),
      );
      const result = await loadVaultSkills(vault, "thor");
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]?.description).toBe("Agent override version.");
      expect(result.skills[0]?.source).toBe("agent");
    } finally {
      await cleanup();
    }
  });

  it("loads SKILL.md from a skill directory", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await mkdir(join(vault, "skills", "dir-skill"), { recursive: true });
      await writeFile(
        join(vault, "skills", "dir-skill", "SKILL.md"),
        [
          "---",
          "name: dir-skill",
          'description: "A skill inside a directory."',
          "---",
          "",
          "# Dir Skill",
        ].join("\n"),
      );
      const result = await loadVaultSkills(vault, "thor");
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]?.name).toBe("dir-skill");
      expect(result.skills[0]?.body).toContain("# Dir Skill");
    } finally {
      await cleanup();
    }
  });

  it("derives the name from the filename when frontmatter has no name", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeFile(
        join(vault, "skills", "no-name.md"),
        [
          "---",
          'description: "Skill without a name field."',
          "---",
          "",
          "# No Name",
        ].join("\n"),
      );
      const result = await loadVaultSkills(vault, "thor");
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]?.name).toBe("no-name");
    } finally {
      await cleanup();
    }
  });

  it("skips files without valid frontmatter (missing description) gracefully", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeFile(
        join(vault, "skills", "malformed.md"),
        [
          "---",
          "name: malformed",
          "---",
          "",
          "# No description",
        ].join("\n"),
      );
      const result = await loadVaultSkills(vault, "thor");
      // A skill without a description is still loaded (name + body), but
      // description is empty. The loader is tolerant: it does not crash.
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]?.name).toBe("malformed");
      expect(result.skills[0]?.description).toBe("");
    } finally {
      await cleanup();
    }
  });

  it("combines shared and agent-specific skills without name collisions", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeFile(
        join(vault, "skills", "shared-a.md"),
        [
          "---",
          "name: shared-a",
          'description: "Shared A."',
          "---",
          "",
          "# A",
        ].join("\n"),
      );
      await writeFile(
        join(vault, "team", "thor", "skills", "agent-b.md"),
        [
          "---",
          "name: agent-b",
          'description: "Agent B."',
          "---",
          "",
          "# B",
        ].join("\n"),
      );
      const result = await loadVaultSkills(vault, "thor");
      expect(result.skills).toHaveLength(2);
      const names = result.skills.map((s) => s.name).sort();
      expect(names).toEqual(["agent-b", "shared-a"]);
    } finally {
      await cleanup();
    }
  });

  it("does not load agent-specific skills from a different agent", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeFile(
        join(vault, "team", "thor", "skills", "thor-only.md"),
        [
          "---",
          "name: thor-only",
          'description: "Only for thor."',
          "---",
          "",
          "# Thor Only",
        ].join("\n"),
      );
      // A different agent should not see thor's skills.
      const result = await loadVaultSkills(vault, "loki");
      expect(result.skills).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
