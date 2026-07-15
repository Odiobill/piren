import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  isValidSkillName,
  parseScope,
  formatScope,
  resolveSkillPath,
  scanAllSkills,
  resolveEffectiveSkills,
  filterSkills,
  showSkill,
  explainSkill,
  createSkill,
  moveSkill,
  promoteSkill,
  demoteSkill,
  listConflicts,
  validateSkills,
  formatSkillList,
  formatSkillShow,
  formatSkillExplain,
  formatSkillConflicts,
  formatSkillValidation,
  createRealSkillCliDeps,
  type SkillCliDeps,
  type ScannedSkill,
  type SkillListOptions,
  type ParsedScope,
} from "../src/skill-cli.js";

// ---------------------------------------------------------------------------
// Fake filesystem for injected deps
// ---------------------------------------------------------------------------

interface FakeEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

class FakeFs {
  private files = new Map<string, string>();
  private dirs = new Set<string>();

  constructor() {
    this.dirs.add("");
    this.dirs.add("/");
  }

  private norm(p: string): string {
    return p.replace(/\\/g, "/").replace(/\/+$/, "");
  }

  private registerParents(p: string): void {
    const parts = p.split("/").filter(Boolean);
    let acc = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      acc += "/" + parts[i];
      this.dirs.add(acc);
    }
  }

  file(path: string, content: string): this {
    const p = this.norm(path);
    this.files.set(p, content);
    this.registerParents(p);
    return this;
  }

  dir(path: string): this {
    const p = this.norm(path);
    this.dirs.add(p);
    this.registerParents(p);
    return this;
  }

  mkdir(path: string, _opts?: { recursive?: boolean }): void {
    const p = this.norm(path);
    this.dirs.add(p);
    this.registerParents(p);
  }

  readFile(path: string): string {
    const p = this.norm(path);
    const content = this.files.get(p);
    if (content === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    return content;
  }

  writeFile(path: string, content: string): void {
    const p = this.norm(path);
    this.files.set(p, content);
    this.registerParents(p);
  }

  stat(path: string): { isDirectory(): boolean } {
    const p = this.norm(path);
    if (this.dirs.has(p)) return { isDirectory: () => true };
    if (this.files.has(p)) return { isDirectory: () => false };
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  }

  readdir(path: string): FakeEntry[] {
    const p = this.norm(path);
    if (!this.dirs.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });

    const prefix = p === "" ? "" : p + "/";
    const results: FakeEntry[] = [];
    const seen = new Set<string>();

    for (const dir of this.dirs) {
      if (!dir.startsWith(prefix) || dir === p) continue;
      const name = dir.slice(prefix.length).split("/")[0];
      if (name && !seen.has(name)) {
        seen.add(name);
        results.push({
          name,
          isDirectory: () => true,
          isFile: () => false,
        });
      }
    }
    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const name = rest.split("/")[0];
      // Only direct children
      if (name && !rest.includes("/") && !seen.has(name)) {
        seen.add(name);
        results.push({
          name,
          isDirectory: () => false,
          isFile: () => true,
        });
      }
    }
    return results;
  }

  rename(oldPath: string, newPath: string): void {
    const content = this.readFile(oldPath);
    this.files.delete(this.norm(oldPath));
    this.writeFile(newPath, content);
  }

  unlink(path: string): void {
    const p = this.norm(path);
    if (!this.files.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    this.files.delete(p);
  }

  rmdir(path: string): void {
    const p = this.norm(path);
    if (!this.dirs.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    this.dirs.delete(p);
  }

  access(path: string): void {
    const p = this.norm(path);
    if (!this.dirs.has(p) && !this.files.has(p)) {
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    }
  }

  toDeps(): SkillCliDeps {
    const self = this;
    return {
      readFile: (p) => Promise.resolve(self.readFile(p)),
      writeFile: (p, c) => Promise.resolve(self.writeFile(p, c)),
      mkdir: (p, o) => { self.mkdir(p, o); return Promise.resolve(); },
      stat: (p) => Promise.resolve(self.stat(p)),
      readdir: (p) => Promise.resolve(self.readdir(p)),
      rename: (a, b) => { self.rename(a, b); return Promise.resolve(); },
      unlink: (p) => { self.unlink(p); return Promise.resolve(); },
      rmdir: (p) => { self.rmdir(p); return Promise.resolve(); },
      access: (p) => { self.access(p); return Promise.resolve(); },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VAULT = "/vault";

function skillContent(name: string, description?: string): string {
  const desc = description ?? "";
  return [
    "---",
    "type: Skill",
    `name: ${name}`,
    `description: ${desc}`,
    "---",
    "",
    `Body of ${name}.`,
    "",
  ].join("\n");
}

function setupBasicVault(fs: FakeFs): void {
  fs.dir(join(VAULT, "skills"));
  fs.dir(join(VAULT, "team", "dipu", "skills"));
  fs.dir(join(VAULT, "team", "zai", "skills"));
  fs.dir(join(VAULT, "agent-groups", "devs", "skills"));
  fs.dir(join(VAULT, "agent-groups", "ops", "skills"));
  // Group configs
  fs.file(
    join(VAULT, "agent-groups", "devs", "config.yml"),
    "agents:\n  - dipu\n  - zai\n",
  );
  fs.file(
    join(VAULT, "agent-groups", "ops", "config.yml"),
    "agents:\n  - dipu\n",
  );
  // Agent identities (required for scope existence checks)
  fs.file(join(VAULT, "team", "dipu", "SOUL.md"), "# Dipu\n");
  fs.file(join(VAULT, "team", "zai", "SOUL.md"), "# Zai\n");
}

// ---------------------------------------------------------------------------
// Name & scope validation
// ---------------------------------------------------------------------------

describe("isValidSkillName", () => {
  it("accepts valid names", () => {
    expect(isValidSkillName("my-skill")).toBe(true);
    expect(isValidSkillName("piren_tdd")).toBe(true);
    expect(isValidSkillName("a")).toBe(true);
  });

  it("rejects empty, dot, and dot-dot", () => {
    expect(isValidSkillName("")).toBe(false);
    expect(isValidSkillName(".")).toBe(false);
    expect(isValidSkillName("..")).toBe(false);
  });

  it("rejects path separators", () => {
    expect(isValidSkillName("foo/bar")).toBe(false);
    expect(isValidSkillName("foo\\bar")).toBe(false);
  });

  it("rejects YAML-unsafe characters (colons, tabs, newlines)", () => {
    expect(isValidSkillName("bad: name")).toBe(false);
    expect(isValidSkillName("tab\tname")).toBe(false);
    expect(isValidSkillName("new\nline")).toBe(false);
  });

  it("accepts normal names with spaces, dashes, underscores", () => {
    expect(isValidSkillName("my-skill")).toBe(true);
    expect(isValidSkillName("my_skill")).toBe(true);
    expect(isValidSkillName("My Skill 1")).toBe(true);
    expect(isValidSkillName("PirenTDD")).toBe(true);
    expect(isValidSkillName("a")).toBe(true);
  });
});

describe("parseScope", () => {
  it("parses 'shared'", () => {
    expect(parseScope("shared")).toEqual({ kind: "shared" });
  });

  it("parses 'group:devs'", () => {
    expect(parseScope("group:devs")).toEqual({ kind: "group", group: "devs" });
  });

  it("parses 'agent:dipu'", () => {
    expect(parseScope("agent:dipu")).toEqual({ kind: "agent", agent: "dipu" });
  });

  it("returns null for invalid scope", () => {
    expect(parseScope("invalid")).toBeNull();
    expect(parseScope("")).toBeNull();
    expect(parseScope("group:")).toBeNull();
  });
});

describe("formatScope", () => {
  it("formats shared", () => {
    expect(formatScope({ kind: "shared" })).toBe("shared");
  });

  it("formats group", () => {
    expect(formatScope({ kind: "group", group: "devs" })).toBe("group:devs");
  });

  it("formats agent", () => {
    expect(formatScope({ kind: "agent", agent: "dipu" })).toBe("agent:dipu");
  });
});

describe("resolveSkillPath", () => {
  it("resolves shared path", () => {
    const result = resolveSkillPath(VAULT, "my-skill", { kind: "shared" });
    expect(result.vaultRelativePath).toBe("skills/my-skill.md");
    expect(result.absolutePath).toBe(join(VAULT, "skills", "my-skill.md"));
  });

  it("resolves group path", () => {
    const result = resolveSkillPath(VAULT, "my-skill", { kind: "group", group: "devs" });
    expect(result.vaultRelativePath).toBe("agent-groups/devs/skills/my-skill.md");
    expect(result.absolutePath).toBe(join(VAULT, "agent-groups", "devs", "skills", "my-skill.md"));
  });

  it("resolves agent path", () => {
    const result = resolveSkillPath(VAULT, "my-skill", { kind: "agent", agent: "dipu" });
    expect(result.vaultRelativePath).toBe("team/dipu/skills/my-skill.md");
    expect(result.absolutePath).toBe(join(VAULT, "team", "dipu", "skills", "my-skill.md"));
  });
});

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

describe("scanAllSkills", () => {
  it("returns empty for a fresh vault", async () => {
    const fs = new FakeFs();
    const result = await scanAllSkills(fs.toDeps(), VAULT);
    expect(result).toEqual([]);
  });

  it("scans skills from all scopes", async () => {
    const fs = new FakeFs();
    setupBasicVault(fs);
    fs.file(join(VAULT, "skills", "shared-skill.md"), skillContent("shared-skill", "A shared skill"));
    fs.file(join(VAULT, "agent-groups", "devs", "skills", "group-skill.md"), skillContent("group-skill", "A group skill"));
    fs.file(join(VAULT, "team", "dipu", "skills", "agent-skill.md"), skillContent("agent-skill", "An agent skill"));

    const result = await scanAllSkills(fs.toDeps(), VAULT);
    expect(result.length).toBe(3);
    expect(result.map((s) => s.name).sort()).toEqual(["agent-skill", "group-skill", "shared-skill"]);
  });

  it("annotates skills with correct source and scope", async () => {
    const fs = new FakeFs();
    setupBasicVault(fs);
    fs.file(join(VAULT, "skills", "test.md"), skillContent("test"));
    fs.file(join(VAULT, "agent-groups", "devs", "skills", "test.md"), skillContent("test"));
    fs.file(join(VAULT, "team", "dipu", "skills", "test.md"), skillContent("test"));

    const result = await scanAllSkills(fs.toDeps(), VAULT);
    const shared = result.find((s) => s.source === "shared");
    const group = result.find((s) => s.source === "group");
    const agent = result.find((s) => s.source === "agent");

    expect(shared).toBeDefined();
    expect(group).toBeDefined();
    expect(agent).toBeDefined();
    expect(shared!.scope).toBe("shared");
    expect(group!.scope).toBe("devs");
    expect(agent!.scope).toBe("dipu");
  });

  it("handles directory-based SKILL.md skills", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills", "my-dir-skill"));
    fs.file(join(VAULT, "skills", "my-dir-skill", "SKILL.md"), skillContent("my-dir-skill", "A directory skill"));

    const result = await scanAllSkills(fs.toDeps(), VAULT);
    expect(result.length).toBe(1);
    expect(result[0]!.name).toBe("my-dir-skill");
    expect(result[0]!.isDirectory).toBe(true);
    expect(result[0]!.path).toBe("skills/my-dir-skill/SKILL.md");
  });

  it("tolerates missing skills directories", async () => {
    const fs = new FakeFs();
    // No skills/ dir at all
    const result = await scanAllSkills(fs.toDeps(), VAULT);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveSkills
// ---------------------------------------------------------------------------

describe("resolveEffectiveSkills", () => {
  it("applies precedence: agent > group > shared", async () => {
    const fs = new FakeFs();
    setupBasicVault(fs);
    // Same name in all three scopes
    fs.file(join(VAULT, "skills", "overlap.md"), skillContent("overlap", "Shared version"));
    fs.file(join(VAULT, "agent-groups", "devs", "skills", "overlap.md"), skillContent("overlap", "Group version"));
    fs.file(join(VAULT, "team", "dipu", "skills", "overlap.md"), skillContent("overlap", "Agent version"));

    const result = await resolveEffectiveSkills(fs.toDeps(), VAULT, "dipu");
    const overlap = result.find((s) => s.name === "overlap");
    expect(overlap).toBeDefined();
    expect(overlap!.description).toBe("Agent version");
    expect(overlap!.source).toBe("agent");
  });

  it("falls back to group when agent doesn't have the skill", async () => {
    const fs = new FakeFs();
    setupBasicVault(fs);
    fs.file(join(VAULT, "skills", "only-group.md"), skillContent("only-group", "Shared"));
    fs.file(join(VAULT, "agent-groups", "devs", "skills", "only-group.md"), skillContent("only-group", "Group"));

    const result = await resolveEffectiveSkills(fs.toDeps(), VAULT, "dipu");
    const skill = result.find((s) => s.name === "only-group");
    expect(skill).toBeDefined();
    expect(skill!.source).toBe("group");
  });

  it("falls back to shared when no agent or group has it", async () => {
    const fs = new FakeFs();
    setupBasicVault(fs);
    fs.file(join(VAULT, "skills", "only-shared.md"), skillContent("only-shared", "Shared"));

    const result = await resolveEffectiveSkills(fs.toDeps(), VAULT, "dipu");
    const skill = result.find((s) => s.name === "only-shared");
    expect(skill).toBeDefined();
    expect(skill!.source).toBe("shared");
  });

  it("excludes skills from groups the agent doesn't belong to", async () => {
    const fs = new FakeFs();
    setupBasicVault(fs);
    fs.file(join(VAULT, "agent-groups", "ops", "skills", "ops-only.md"), skillContent("ops-only", "Ops group"));
    // dipu is in ops group, zai is not

    const dipuResult = await resolveEffectiveSkills(fs.toDeps(), VAULT, "dipu");
    expect(dipuResult.find((s) => s.name === "ops-only")).toBeDefined();

    const zaiResult = await resolveEffectiveSkills(fs.toDeps(), VAULT, "zai");
    expect(zaiResult.find((s) => s.name === "ops-only")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// filterSkills
// ---------------------------------------------------------------------------

describe("filterSkills", () => {
  it("filters by agent using effective resolution", async () => {
    const fs = new FakeFs();
    setupBasicVault(fs);
    fs.file(join(VAULT, "skills", "s1.md"), skillContent("s1"));
    fs.file(join(VAULT, "team", "dipu", "skills", "s2.md"), skillContent("s2"));

    const all = await scanAllSkills(fs.toDeps(), VAULT);
    const filtered = await filterSkills(fs.toDeps(), VAULT, all, { agent: "dipu" });
    expect(filtered.map((s) => s.name).sort()).toEqual(["s1", "s2"]);
  });

  it("filters by group scope", async () => {
    const fs = new FakeFs();
    setupBasicVault(fs);
    fs.file(join(VAULT, "agent-groups", "devs", "skills", "g1.md"), skillContent("g1"));
    fs.file(join(VAULT, "agent-groups", "ops", "skills", "g2.md"), skillContent("g2"));

    const all = await scanAllSkills(fs.toDeps(), VAULT);
    const filtered = await filterSkills(fs.toDeps(), VAULT, all, { group: "devs" });
    expect(filtered.map((s) => s.name)).toEqual(["g1"]);
  });

  it("filters by source type", async () => {
    const fs = new FakeFs();
    setupBasicVault(fs);
    fs.file(join(VAULT, "skills", "s1.md"), skillContent("s1"));
    fs.file(join(VAULT, "team", "dipu", "skills", "a1.md"), skillContent("a1"));

    const all = await scanAllSkills(fs.toDeps(), VAULT);
    const filtered = await filterSkills(fs.toDeps(), VAULT, all, { scope: "shared" });
    expect(filtered.map((s) => s.name)).toEqual(["s1"]);
  });
});

// ---------------------------------------------------------------------------
// showSkill
// ---------------------------------------------------------------------------

describe("showSkill", () => {
  it("shows the effective skill for an agent (precedence)", async () => {
    const fs = new FakeFs();
    setupBasicVault(fs);
    fs.file(join(VAULT, "skills", "s.md"), skillContent("s", "Shared desc"));
    fs.file(join(VAULT, "team", "dipu", "skills", "s.md"), skillContent("s", "Agent desc"));

    const result = await showSkill(fs.toDeps(), VAULT, "s", "dipu");
    expect(result).not.toBeNull();
    expect(result!.skill.description).toBe("Agent desc");
    expect(result!.skill.source).toBe("agent");
  });

  it("returns null for unknown skill", async () => {
    const fs = new FakeFs();
    setupBasicVault(fs);
    const result = await showSkill(fs.toDeps(), VAULT, "nonexistent", "dipu");
    expect(result).toBeNull();
  });

  it("falls back to shared when no agent provided", async () => {
    const fs = new FakeFs();
    setupBasicVault(fs);
    fs.file(join(VAULT, "skills", "s.md"), skillContent("s", "Shared"));

    const result = await showSkill(fs.toDeps(), VAULT, "s");
    expect(result).not.toBeNull();
    expect(result!.skill.source).toBe("shared");
  });
});

// ---------------------------------------------------------------------------
// explainSkill
// ---------------------------------------------------------------------------

describe("explainSkill", () => {
  it("shows effective and shadowed copies", async () => {
    const fs = new FakeFs();
    setupBasicVault(fs);
    fs.file(join(VAULT, "skills", "multi.md"), skillContent("multi", "Shared version"));
    fs.file(join(VAULT, "agent-groups", "devs", "skills", "multi.md"), skillContent("multi", "Group version"));
    fs.file(join(VAULT, "team", "dipu", "skills", "multi.md"), skillContent("multi", "Agent version"));

    const result = await explainSkill(fs.toDeps(), VAULT, "multi", "dipu");
    expect(result).not.toBeNull();
    expect(result!.effective.source).toBe("agent");
    expect(result!.shadowed.length).toBe(2);
    expect(result!.shadowed.map((s) => s.source).sort()).toEqual(["group", "shared"]);
  });

  it("returns null for unknown skill", async () => {
    const fs = new FakeFs();
    setupBasicVault(fs);
    const result = await explainSkill(fs.toDeps(), VAULT, "nonexistent", "dipu");
    expect(result).toBeNull();
  });

  it("shows no shadowed when only one copy exists", async () => {
    const fs = new FakeFs();
    setupBasicVault(fs);
    fs.file(join(VAULT, "skills", "solo.md"), skillContent("solo"));

    const result = await explainSkill(fs.toDeps(), VAULT, "solo", "dipu");
    expect(result).not.toBeNull();
    expect(result!.effective.source).toBe("shared");
    expect(result!.shadowed.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createSkill
// ---------------------------------------------------------------------------

describe("createSkill", () => {
  it("creates a shared skill file with frontmatter", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));

    const result = await createSkill(fs.toDeps(), VAULT, "new-skill", { kind: "shared" });
    expect(result.path).toBe("skills/new-skill.md");

    const content = fs.readFile(join(VAULT, "skills", "new-skill.md"));
    expect(content).toContain("type: Skill");
    expect(content).toContain("name: new-skill");
    expect(content).toContain("description:");
  });

  it("creates a group-scoped skill", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "agent-groups", "devs", "skills"));
    fs.file(join(VAULT, "agent-groups", "devs", "config.yml"), "agents: []\n");

    const result = await createSkill(fs.toDeps(), VAULT, "group-skill", { kind: "group", group: "devs" });
    expect(result.path).toBe("agent-groups/devs/skills/group-skill.md");
  });

  it("creates an agent-scoped skill", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "team", "dipu", "skills"));
    fs.file(join(VAULT, "team", "dipu", "SOUL.md"), "# Dipu\n");

    const result = await createSkill(fs.toDeps(), VAULT, "agent-skill", { kind: "agent", agent: "dipu" });
    expect(result.path).toBe("team/dipu/skills/agent-skill.md");
  });

  it("refuses to overwrite without --force", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    fs.file(join(VAULT, "skills", "existing.md"), skillContent("existing"));

    await expect(
      createSkill(fs.toDeps(), VAULT, "existing", { kind: "shared" }),
    ).rejects.toThrow(/already exists/);
  });

  it("overwrites with --force", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    fs.file(join(VAULT, "skills", "existing.md"), skillContent("existing", "Old"));

    const result = await createSkill(
      fs.toDeps(),
      VAULT,
      "existing",
      { kind: "shared" },
      { force: true },
    );
    expect(result.path).toBe("skills/existing.md");
    const content = fs.readFile(join(VAULT, "skills", "existing.md"));
    expect(content).not.toContain("Old");
  });
});

// ---------------------------------------------------------------------------
// moveSkill
// ---------------------------------------------------------------------------

describe("moveSkill", () => {
  it("moves a skill between scopes", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    fs.dir(join(VAULT, "team", "dipu", "skills"));
    fs.file(join(VAULT, "team", "dipu", "SOUL.md"), "# Dipu\n");
    fs.file(join(VAULT, "skills", "movable.md"), skillContent("movable", "Will move"));

    const result = await moveSkill(
      fs.toDeps(),
      VAULT,
      "movable",
      { kind: "shared" },
      { kind: "agent", agent: "dipu" },
    );
    expect(result.fromPath).toBe("skills/movable.md");
    expect(result.toPath).toBe("team/dipu/skills/movable.md");

    // Source should be gone
    expect(() => fs.readFile(join(VAULT, "skills", "movable.md"))).toThrow();

    // Target should exist
    const content = fs.readFile(join(VAULT, "team", "dipu", "skills", "movable.md"));
    expect(content).toContain("Will move");
  });

  it("refuses to overwrite target without --force", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    fs.dir(join(VAULT, "team", "dipu", "skills"));
    fs.file(join(VAULT, "team", "dipu", "SOUL.md"), "# Dipu\n");
    fs.file(join(VAULT, "skills", "dup.md"), skillContent("dup", "Source"));
    fs.file(join(VAULT, "team", "dipu", "skills", "dup.md"), skillContent("dup", "Target"));

    await expect(
      moveSkill(fs.toDeps(), VAULT, "dup", { kind: "shared" }, { kind: "agent", agent: "dipu" }),
    ).rejects.toThrow(/already exists/);
  });

  it("overwrites target with --force", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    fs.dir(join(VAULT, "team", "dipu", "skills"));
    fs.file(join(VAULT, "team", "dipu", "SOUL.md"), "# Dipu\n");
    fs.file(join(VAULT, "skills", "dup.md"), skillContent("dup", "Source"));
    fs.file(join(VAULT, "team", "dipu", "skills", "dup.md"), skillContent("dup", "Target"));

    await moveSkill(
      fs.toDeps(),
      VAULT,
      "dup",
      { kind: "shared" },
      { kind: "agent", agent: "dipu" },
      { force: true },
    );

    const content = fs.readFile(join(VAULT, "team", "dipu", "skills", "dup.md"));
    expect(content).toContain("Source");
  });

  it("throws when source skill not found", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    fs.dir(join(VAULT, "team", "dipu", "skills"));

    await expect(
      moveSkill(fs.toDeps(), VAULT, "nonexistent", { kind: "shared" }, { kind: "agent", agent: "dipu" }),
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// promoteSkill / demoteSkill
// ---------------------------------------------------------------------------

describe("promoteSkill", () => {
  it("promotes from agent to shared", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    fs.dir(join(VAULT, "team", "dipu", "skills"));
    fs.file(join(VAULT, "team", "dipu", "SOUL.md"), "# Dipu\n");
    fs.file(join(VAULT, "team", "dipu", "skills", "up.md"), skillContent("up", "Promote me"));

    const result = await promoteSkill(fs.toDeps(), VAULT, "up", "dipu", "shared");
    expect(result.toPath).toBe("skills/up.md");

    const content = fs.readFile(join(VAULT, "skills", "up.md"));
    expect(content).toContain("Promote me");
  });

  it("promotes from agent to group", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "team", "dipu", "skills"));
    fs.dir(join(VAULT, "agent-groups", "devs", "skills"));
    fs.file(join(VAULT, "team", "dipu", "SOUL.md"), "# Dipu\n");
    fs.file(join(VAULT, "agent-groups", "devs", "config.yml"), "agents: []\n");
    fs.file(join(VAULT, "team", "dipu", "skills", "up.md"), skillContent("up", "Promote me"));

    const result = await promoteSkill(fs.toDeps(), VAULT, "up", "dipu", { kind: "group", group: "devs" });
    expect(result.toPath).toBe("agent-groups/devs/skills/up.md");
  });
});

describe("demoteSkill", () => {
  it("demotes from shared to agent", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    fs.dir(join(VAULT, "team", "dipu", "skills"));
    fs.file(join(VAULT, "team", "dipu", "SOUL.md"), "# Dipu\n");
    fs.file(join(VAULT, "skills", "down.md"), skillContent("down", "Demote me"));

    const result = await demoteSkill(fs.toDeps(), VAULT, "down", "shared", "dipu");
    expect(result.toPath).toBe("team/dipu/skills/down.md");

    const content = fs.readFile(join(VAULT, "team", "dipu", "skills", "down.md"));
    expect(content).toContain("Demote me");
  });

  it("demotes from group to agent", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "agent-groups", "devs", "skills"));
    fs.dir(join(VAULT, "team", "dipu", "skills"));
    fs.file(join(VAULT, "team", "dipu", "SOUL.md"), "# Dipu\n");
    fs.file(join(VAULT, "agent-groups", "devs", "config.yml"), "agents: []\n");
    fs.file(join(VAULT, "agent-groups", "devs", "skills", "down.md"), skillContent("down", "Demote me"));

    const result = await demoteSkill(fs.toDeps(), VAULT, "down", { kind: "group", group: "devs" }, "dipu");
    expect(result.toPath).toBe("team/dipu/skills/down.md");
  });
});

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

describe("listConflicts", () => {
  it("reports same-name skills across scopes", async () => {
    const fs = new FakeFs();
    setupBasicVault(fs);
    fs.file(join(VAULT, "skills", "dup.md"), skillContent("dup", "Shared"));
    fs.file(join(VAULT, "team", "dipu", "skills", "dup.md"), skillContent("dup", "Agent"));

    const result = await listConflicts(fs.toDeps(), VAULT);
    expect(result.length).toBe(1);
    expect(result[0]!.name).toBe("dup");
    expect(result[0]!.entries.length).toBe(2);
  });

  it("returns empty when no conflicts", async () => {
    const fs = new FakeFs();
    setupBasicVault(fs);
    fs.file(join(VAULT, "skills", "a.md"), skillContent("a"));
    fs.file(join(VAULT, "team", "dipu", "skills", "b.md"), skillContent("b"));

    const result = await listConflicts(fs.toDeps(), VAULT);
    expect(result.length).toBe(0);
  });

  it("filters conflicts for a specific agent (only visible scopes)", async () => {
    const fs = new FakeFs();
    setupBasicVault(fs);
    // dipu is in devs and ops, zai is only in devs
    fs.file(join(VAULT, "skills", "dup.md"), skillContent("dup", "Shared"));
    fs.file(join(VAULT, "agent-groups", "ops", "skills", "dup.md"), skillContent("dup", "Ops"));

    // For zai (not in ops), ops group skill is invisible, so no conflict
    const zaiResult = await listConflicts(fs.toDeps(), VAULT, "zai");
    expect(zaiResult.length).toBe(0);

    // For dipu (in ops), both skills visible -> conflict
    const dipuResult = await listConflicts(fs.toDeps(), VAULT, "dipu");
    expect(dipuResult.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

describe("validateSkills", () => {
  it("reports skills missing type field", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    fs.file(join(VAULT, "skills", "bad.md"), [
      "---",
      "name: bad",
      "---",
      "",
      "Body.",
    ].join("\n"));

    const issues = await validateSkills(fs.toDeps(), VAULT);
    expect(issues.length).toBe(1);
    expect(issues[0]!.kind).toBe("missing-type");
  });

  it("reports skills with empty type field", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    fs.file(join(VAULT, "skills", "bad.md"), [
      "---",
      "type:",
      "name: bad",
      "---",
      "",
    ].join("\n"));

    const issues = await validateSkills(fs.toDeps(), VAULT);
    expect(issues.length).toBe(1);
    expect(issues[0]!.kind).toBe("missing-type");
  });

  it("reports unparseable frontmatter", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    fs.file(join(VAULT, "skills", "bad.md"), [
      "---",
      "type: Skill",
      "  - unclosed: [",
      "---",
      "",
    ].join("\n"));

    const issues = await validateSkills(fs.toDeps(), VAULT);
    expect(issues.length).toBe(1);
    expect(issues[0]!.kind).toBe("unparseable-frontmatter");
  });

  it("reports missing frontmatter", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    fs.file(join(VAULT, "skills", "nofm.md"), "Just a Markdown file, no frontmatter.");

    const issues = await validateSkills(fs.toDeps(), VAULT);
    expect(issues.length).toBe(1);
    expect(issues[0]!.kind).toBe("missing-frontmatter");
  });

  it("passes valid skills", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    fs.file(join(VAULT, "skills", "good.md"), skillContent("good"));

    const issues = await validateSkills(fs.toDeps(), VAULT);
    expect(issues.length).toBe(0);
  });

  it("validates across all scopes", async () => {
    const fs = new FakeFs();
    setupBasicVault(fs);
    fs.file(join(VAULT, "skills", "bad-shared.md"), "No frontmatter.");
    fs.file(join(VAULT, "team", "dipu", "skills", "bad-agent.md"), "Also no frontmatter.");

    const issues = await validateSkills(fs.toDeps(), VAULT);
    expect(issues.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

describe("formatSkillList", () => {
  it("renders a compact table", () => {
    const skills: ScannedSkill[] = [
      {
        name: "alpha",
        description: "First skill",
        body: "",
        source: "shared",
        scope: "shared",
        path: "skills/alpha.md",
        isDirectory: false,
      },
      {
        name: "beta",
        description: "",
        body: "",
        source: "agent",
        scope: "dipu",
        path: "team/dipu/skills/beta.md",
        isDirectory: false,
      },
    ];

    const output = formatSkillList(skills);
    expect(output).toContain("alpha");
    expect(output).toContain("beta");
    expect(output).toContain("First skill");
    expect(output).toContain("shared:shared");
    expect(output).toContain("agent:dipu");
    expect(output).toContain("NAME");
    expect(output).toContain("SOURCE");
    expect(output).toContain("DESCRIPTION");
  });

  it("shows 'No skills found' for empty list", () => {
    expect(formatSkillList([])).toBe("No skills found.");
  });
});

describe("formatSkillShow", () => {
  it("renders full skill body", () => {
    const result = {
      skill: {
        name: "test",
        description: "A test skill",
        body: "This is the body.",
        source: "shared" as const,
        scope: "shared",
        path: "skills/test.md",
        isDirectory: false,
      },
    };

    const output = formatSkillShow(result);
    expect(output).toContain("Name: test");
    expect(output).toContain("Source: shared:shared");
    expect(output).toContain("A test skill");
    expect(output).toContain("This is the body.");
  });
});

describe("formatSkillExplain", () => {
  it("shows effective and shadowed", () => {
    const result = {
      effective: {
        name: "multi",
        description: "Agent version",
        body: "",
        source: "agent" as const,
        scope: "dipu",
        path: "team/dipu/skills/multi.md",
        isDirectory: false,
      },
      shadowed: [
        {
          name: "multi",
          description: "Shared version",
          body: "",
          source: "shared" as const,
          scope: "shared",
          path: "skills/multi.md",
          isDirectory: false,
        },
      ],
    };

    const output = formatSkillExplain(result);
    expect(output).toContain("Effective (active)");
    expect(output).toContain("agent:dipu");
    expect(output).toContain("Shadowed (inactive)");
    expect(output).toContain("shared:shared");
  });

  it("shows 'none' when no shadowed", () => {
    const result = {
      effective: {
        name: "solo",
        description: "",
        body: "",
        source: "shared" as const,
        scope: "shared",
        path: "skills/solo.md",
        isDirectory: false,
      },
      shadowed: [],
    };

    const output = formatSkillExplain(result);
    expect(output).toContain("none");
  });
});

describe("formatSkillConflicts", () => {
  it("reports conflicts", () => {
    const conflicts = [
      {
        name: "dup",
        entries: [
          { source: "shared" as const, scope: "shared", path: "skills/dup.md" },
          { source: "agent" as const, scope: "dipu", path: "team/dipu/skills/dup.md" },
        ],
      },
    ];

    const output = formatSkillConflicts(conflicts);
    expect(output).toContain("1 skill name conflict");
    expect(output).toContain("dup");
    expect(output).toContain("shared:shared");
    expect(output).toContain("agent:dipu");
  });

  it("shows 'No skill conflicts found' for empty", () => {
    expect(formatSkillConflicts([])).toBe("No skill conflicts found.");
  });
});

describe("formatSkillValidation", () => {
  it("reports validation issues", () => {
    const issues = [
      {
        kind: "missing-type" as const,
        path: "skills/bad.md",
        message: "Missing type",
      },
    ];

    const output = formatSkillValidation(issues);
    expect(output).toContain("1 skill validation issue");
    expect(output).toContain("[missing-type]");
  });

  it("shows pass message for no issues", () => {
    expect(formatSkillValidation([])).toBe("All skill files passed validation.");
  });
});

// ---------------------------------------------------------------------------
// Real adapter smoke
// ---------------------------------------------------------------------------

describe("createRealSkillCliDeps", () => {
  it("returns a valid deps object", () => {
    const deps = createRealSkillCliDeps();
    expect(typeof deps.readFile).toBe("function");
    expect(typeof deps.writeFile).toBe("function");
    expect(typeof deps.mkdir).toBe("function");
    expect(typeof deps.stat).toBe("function");
    expect(typeof deps.readdir).toBe("function");
    expect(typeof deps.rename).toBe("function");
    expect(typeof deps.unlink).toBe("function");
    expect(typeof deps.rmdir).toBe("function");
    expect(typeof deps.access).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Blocker 1 — Vault containment (path traversal rejection)
// ---------------------------------------------------------------------------

describe("YAML-dangerous skill name rejection (re-review Blocker 2)", () => {
  it("createSkill rejects colon in name", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    await expect(
      createSkill(fs.toDeps(), VAULT, "bad: name", { kind: "shared" }),
    ).rejects.toThrow(/Invalid skill name/);
  });

  it("createSkill rejects tab in name", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    await expect(
      createSkill(fs.toDeps(), VAULT, "tab\tname", { kind: "shared" }),
    ).rejects.toThrow(/Invalid skill name/);
  });

  it("createSkill rejects newline in name", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    await expect(
      createSkill(fs.toDeps(), VAULT, "new\nline", { kind: "shared" }),
    ).rejects.toThrow(/Invalid skill name/);
  });
});

describe("vault containment (Blocker 1)", () => {
  it("createSkill rejects traversal names (../../escaped)", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    await expect(
      createSkill(fs.toDeps(), VAULT, "../../escaped", { kind: "shared" }),
    ).rejects.toThrow(/Invalid skill name/);
  });

  it("createSkill rejects traversal names (../outside)", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    await expect(
      createSkill(fs.toDeps(), VAULT, "../outside", { kind: "shared" }),
    ).rejects.toThrow(/Invalid skill name/);
  });

  it("createSkill rejects absolute-path-like names", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    await expect(
      createSkill(fs.toDeps(), VAULT, "/etc/passwd", { kind: "shared" }),
    ).rejects.toThrow(/Invalid skill name/);
  });

  it("createSkill accepts normal names (non-regression)", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    const result = await createSkill(fs.toDeps(), VAULT, "normal-skill", { kind: "shared" });
    expect(result.path).toBe("skills/normal-skill.md");
  });

  it("moveSkill rejects traversal in from scope", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    fs.dir(join(VAULT, "team", "dipu", "skills"));
    fs.file(join(VAULT, "team", "dipu", "SOUL.md"), "# Dipu\n");
    await expect(
      moveSkill(fs.toDeps(), VAULT, "../../etc", { kind: "shared" }, { kind: "agent", agent: "dipu" }),
    ).rejects.toThrow(/Invalid skill name/);
  });

  it("moveSkill rejects traversal in to scope", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    fs.dir(join(VAULT, "team", "dipu", "skills"));
    fs.file(join(VAULT, "skills", "s.md"), skillContent("s"));
    await expect(
      moveSkill(fs.toDeps(), VAULT, "s", { kind: "shared" }, { kind: "agent", agent: "../../dipu" }),
    ).rejects.toThrow(/not found/);
  });

  it("promoteSkill rejects traversal in agent name", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    fs.dir(join(VAULT, "team", "dipu", "skills"));
    fs.file(join(VAULT, "team", "dipu", "skills", "s.md"), skillContent("s"));
    await expect(
      promoteSkill(fs.toDeps(), VAULT, "../outside", "../dipu", "shared"),
    ).rejects.toThrow(/Invalid skill name/);
  });

  it("demoteSkill rejects traversal in agent name", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    fs.dir(join(VAULT, "team", "dipu", "skills"));
    fs.file(join(VAULT, "skills", "s.md"), skillContent("s"));
    await expect(
      demoteSkill(fs.toDeps(), VAULT, "s", "shared", "../../dipu"),
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// Blocker 2 — explainSkill precedence with multi-group collision
// ---------------------------------------------------------------------------

describe("explainSkill multi-group precedence (Blocker 2)", () => {
  it("reports later group as effective when multiple groups collide", async () => {
    const fs = new FakeFs();
    // dipu is in both devs and ops. In the group resolution order (devs first, ops second),
    // ops should override devs for same-name skills.
    fs.dir(join(VAULT, "agent-groups", "devs", "skills"));
    fs.dir(join(VAULT, "agent-groups", "ops", "skills"));
    fs.file(join(VAULT, "agent-groups", "devs", "config.yml"), "agents:\n  - dipu\n");
    fs.file(join(VAULT, "agent-groups", "ops", "config.yml"), "agents:\n  - dipu\n");
    fs.file(join(VAULT, "agent-groups", "devs", "skills", "same.md"), skillContent("same", "devs version"));
    fs.file(join(VAULT, "agent-groups", "ops", "skills", "same.md"), skillContent("same", "ops version"));

    const result = await explainSkill(fs.toDeps(), VAULT, "same", "dipu");
    expect(result).not.toBeNull();
    // later group (ops) wins
    expect(result!.effective.source).toBe("group");
    expect(result!.effective.scope).toBe("ops");
    expect(result!.effective.description).toBe("ops version");
    // earlier group (devs) is shadowed
    expect(result!.shadowed.length).toBe(1);
    expect(result!.shadowed[0]!.scope).toBe("devs");
  });

  it("resolveEffectiveSkills also picks later group for collision", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "agent-groups", "devs", "skills"));
    fs.dir(join(VAULT, "agent-groups", "ops", "skills"));
    fs.file(join(VAULT, "agent-groups", "devs", "config.yml"), "agents:\n  - dipu\n");
    fs.file(join(VAULT, "agent-groups", "ops", "config.yml"), "agents:\n  - dipu\n");
    fs.file(join(VAULT, "agent-groups", "devs", "skills", "same.md"), skillContent("same", "devs version"));
    fs.file(join(VAULT, "agent-groups", "ops", "skills", "same.md"), skillContent("same", "ops version"));

    const effective = await resolveEffectiveSkills(fs.toDeps(), VAULT, "dipu");
    const same = effective.find((s) => s.name === "same");
    expect(same).toBeDefined();
    expect(same!.scope).toBe("ops");
  });
});

// ---------------------------------------------------------------------------
// Blocker 3 — Nonexistent group/agent scope rejection
// ---------------------------------------------------------------------------

describe("nonexistent scope rejection (Blocker 3)", () => {
  it("createSkill rejects nonexistent group scope", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "agent-groups"));
    // No config.yml for "missing" group
    await expect(
      createSkill(fs.toDeps(), VAULT, "test", { kind: "group", group: "missing" }),
    ).rejects.toThrow(/group.*not found/i);
  });

  it("createSkill rejects nonexistent agent scope", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "team"));
    // No SOUL.md for "nonexistent" agent
    await expect(
      createSkill(fs.toDeps(), VAULT, "test", { kind: "agent", agent: "nonexistent" }),
    ).rejects.toThrow(/agent.*not found/i);
  });

  it("createSkill accepts existing group scope", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "agent-groups", "devs", "skills"));
    fs.file(join(VAULT, "agent-groups", "devs", "config.yml"), "agents: []\n");
    const result = await createSkill(fs.toDeps(), VAULT, "test", { kind: "group", group: "devs" });
    expect(result.path).toBe("agent-groups/devs/skills/test.md");
  });

  it("createSkill accepts existing agent scope", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "team", "dipu", "skills"));
    fs.file(join(VAULT, "team", "dipu", "SOUL.md"), "# Dipu\n");
    const result = await createSkill(fs.toDeps(), VAULT, "test", { kind: "agent", agent: "dipu" });
    expect(result.path).toBe("team/dipu/skills/test.md");
  });

  it("createSkill accepts shared scope without existence checks", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    const result = await createSkill(fs.toDeps(), VAULT, "test", { kind: "shared" });
    expect(result.path).toBe("skills/test.md");
  });

  it("moveSkill rejects nonexistent target group", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    fs.file(join(VAULT, "skills", "s.md"), skillContent("s"));
    await expect(
      moveSkill(fs.toDeps(), VAULT, "s", { kind: "shared" }, { kind: "group", group: "missing" }),
    ).rejects.toThrow(/group.*not found/i);
  });

  it("moveSkill rejects nonexistent target agent", async () => {
    const fs = new FakeFs();
    fs.dir(join(VAULT, "skills"));
    fs.file(join(VAULT, "skills", "s.md"), skillContent("s"));
    await expect(
      moveSkill(fs.toDeps(), VAULT, "s", { kind: "shared" }, { kind: "agent", agent: "nonexistent" }),
    ).rejects.toThrow(/agent.*not found/i);
  });
});
