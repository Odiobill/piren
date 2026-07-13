import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  isValidGroupName,
  readGroupConfig,
  writeGroupConfig,
  createGroup,
  addAgentToGroup,
  removeAgentFromGroup,
  setFallbackOrder,
  validateGroups,
  formatGroupList,
  formatGroupConfig,
  formatValidationReport,
  type GroupConfigData,
  type GroupWriteDeps,
  type ValidationIssue,
} from "../src/group-config.js";

// ---------------------------------------------------------------------------
// Fake filesystem for injected deps. Keeps the pure core testable without a
// real tmpdir. Structurally compatible with node:fs/promises Dirent/Stats so
// the real adapter in the module is trivial.
// ---------------------------------------------------------------------------

interface FakeEntry {
  name: string;
  isDirectory(): boolean;
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

  async readFile(path: string): Promise<string> {
    const p = this.norm(path);
    const content = this.files.get(p);
    if (content === undefined) throw new Error(`ENOENT: no such file: ${path}`);
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const p = this.norm(path);
    this.files.set(p, content);
    this.registerParents(p);
  }

  async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
    const p = this.norm(path);
    this.dirs.add(p);
    this.registerParents(p);
  }

  async stat(path: string): Promise<{ isDirectory(): boolean }> {
    const p = this.norm(path);
    if (this.dirs.has(p)) return { isDirectory: () => true };
    if (this.files.has(p)) return { isDirectory: () => false };
    throw new Error(`ENOENT: no such file or directory: ${path}`);
  }

  async readdir(path: string): Promise<FakeEntry[]> {
    const p = this.norm(path);
    const prefix = p === "" || p === "/" ? "/" : p + "/";
    const children = new Map<string, boolean>();
    const consider = (candidate: string, isDir: boolean): void => {
      if (candidate === p || candidate === "") return;
      if (!candidate.startsWith(prefix)) return;
      const rest = candidate.slice(prefix.length);
      const name = rest.split("/")[0];
      if (!name) return;
      children.set(name, isDir || children.get(name) === true);
    };
    for (const d of this.dirs) consider(d, true);
    for (const f of this.files.keys()) consider(f, false);
    return [...children.entries()].map(([name, isDir]) => ({
      name,
      isDirectory: () => isDir,
    }));
  }
}

function deps(fs: FakeFs): GroupWriteDeps {
  return {
    readFile: (p: string) => fs.readFile(p),
    writeFile: (p: string, c: string) => fs.writeFile(p, c),
    mkdir: (p: string, opts?: { recursive?: boolean }) => fs.mkdir(p, opts),
    stat: (p: string) => fs.stat(p),
    readdir: (p: string) => fs.readdir(p),
  };
}

function seedVault(fs: FakeFs, vaultRoot: string): void {
  fs.dir(join(vaultRoot, "agent-groups"));
  fs.dir(join(vaultRoot, "team"));
}

async function seedGroup(
  fs: FakeFs,
  vaultRoot: string,
  group: string,
  data: GroupConfigData,
): Promise<void> {
  await fs.mkdir(join(vaultRoot, "agent-groups", group), { recursive: true });
  await fs.writeFile(
    join(vaultRoot, "agent-groups", group, "config.yml"),
    serialize(data),
  );
}

// Serialize the same way the yaml library would, for seeding readable fixtures.
function serialize(data: GroupConfigData): string {
  const lines: string[] = [];
  if (data.agents.length === 0) {
    lines.push("agents: []");
  } else {
    lines.push("agents:");
    for (const a of data.agents) lines.push(`  - ${a}`);
  }
  const keys = Object.keys(data.fallback_order);
  if (keys.length === 0) {
    lines.push("fallback_order: {}");
  } else {
    lines.push("fallback_order:");
    for (const k of keys) {
      lines.push(`  ${k}:`);
      const list = data.fallback_order[k] ?? [];
      if (list.length === 0) {
        lines.push("    []");
      } else {
        for (const c of list) lines.push(`    - ${c}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// isValidGroupName
// ---------------------------------------------------------------------------

describe("isValidGroupName", () => {
  it("accepts plain kebab-case names", () => {
    expect(isValidGroupName("developers")).toBe(true);
    expect(isValidGroupName("qa-team")).toBe(true);
    expect(isValidGroupName("on_call")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidGroupName("")).toBe(false);
  });

  it("rejects . and ..", () => {
    expect(isValidGroupName(".")).toBe(false);
    expect(isValidGroupName("..")).toBe(false);
  });

  it("rejects names with path separators", () => {
    expect(isValidGroupName("foo/bar")).toBe(false);
    expect(isValidGroupName("foo\\bar")).toBe(false);
    expect(isValidGroupName("/absolute")).toBe(false);
    expect(isValidGroupName("trailing/")).toBe(false);
  });

  it("rejects names that would be invisible to parseGroupConfigs (leading dot)", () => {
    expect(isValidGroupName(".hidden")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readGroupConfig
// ---------------------------------------------------------------------------

describe("readGroupConfig", () => {
  it("returns null when the group has no config.yml", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    const result = await readGroupConfig(deps(fs), "/vault", "missing");
    expect(result).toBeNull();
  });

  it("parses a valid config into GroupConfigData", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    await seedGroup(fs, "/vault", "developers", {
      agents: ["dipu", "zai", "sam"],
      fallback_order: { zai: ["dipu", "sam"], dipu: ["zai"] },
    });
    const result = await readGroupConfig(deps(fs), "/vault", "developers");
    expect(result).toEqual({
      agents: ["dipu", "zai", "sam"],
      fallback_order: { zai: ["dipu", "sam"], dipu: ["zai"] },
    });
  });

  it("treats missing fields as empty (tolerant parse)", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    fs.dir(join("/vault", "agent-groups", "developers"));
    fs.file(join("/vault", "agent-groups", "developers", "config.yml"), "agents:\n  - dipu\n");
    const result = await readGroupConfig(deps(fs), "/vault", "developers");
    expect(result).toEqual({ agents: ["dipu"], fallback_order: {} });
  });
});

// ---------------------------------------------------------------------------
// readGroupConfig (path traversal guard)
// ---------------------------------------------------------------------------
//
// readGroupConfig builds `<vaultRoot>/agent-groups/<group>/config.yml`. Because
// node:path.join normalizes `..`, an unchecked group name can escape the
// agent-groups/ directory and even the vault on the read path. assertGroupName
// must run before any filesystem access so traversal vectors are rejected.

describe("readGroupConfig (path traversal guard)", () => {
  it("rejects a traversal group name before touching the filesystem", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    // Sentinel: readFile must never be reached. If validation fails to run
    // first, this throws a distinctive error and the assertion below fails.
    const guardedDeps: GroupWriteDeps = {
      ...deps(fs),
      readFile: (_path: string): Promise<string> => {
        throw new Error("readFile MUST NOT be called for an invalid group name");
      },
    };
    await expect(readGroupConfig(guardedDeps, "/vault", "../../../etc/passwd")).rejects.toThrow(
      /invalid group name/i,
    );
  });

  it("rejects '.', '..', separator, absolute, and leading-dot names", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    for (const bad of ["..", ".", "foo/bar", "foo\\bar", "/abs", ".hidden", "trailing/"]) {
      await expect(readGroupConfig(deps(fs), "/vault", bad)).rejects.toThrow(/invalid group name/i);
    }
  });

  it("propagates the guard to addAgentToGroup, removeAgentFromGroup, and setFallbackOrder", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    // These consumers all read the config first; an invalid group name must be
    // rejected before any filesystem access, not surfaced as 'does not exist'.
    await expect(addAgentToGroup(deps(fs), "/vault", "../escape", "dipu")).rejects.toThrow(
      /invalid group name/i,
    );
    await expect(removeAgentFromGroup(deps(fs), "/vault", "foo/bar", "dipu")).rejects.toThrow(
      /invalid group name/i,
    );
    await expect(setFallbackOrder(deps(fs), "/vault", ".", "dipu", [])).rejects.toThrow(
      /invalid group name/i,
    );
  });
});

// ---------------------------------------------------------------------------
// writeGroupConfig
// ---------------------------------------------------------------------------

describe("writeGroupConfig", () => {
  it("writes deterministic YAML that round-trips through readGroupConfig", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    const data: GroupConfigData = {
      agents: ["dipu", "zai", "sam"],
      fallback_order: { zai: ["dipu", "sam"] },
    };
    await writeGroupConfig(deps(fs), "/vault", "developers", data);
    const written = await fs.readFile(join("/vault", "agent-groups", "developers", "config.yml"));
    expect(written).toContain("agents:");
    expect(written).toContain("  - dipu");
    expect(written).toContain("fallback_order:");
    // Round-trip.
    const read = await readGroupConfig(deps(fs), "/vault", "developers");
    expect(read).toEqual(data);
  });

  it("writes empty config deterministically", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    await writeGroupConfig(deps(fs), "/vault", "fresh", {
      agents: [],
      fallback_order: {},
    });
    const written = await fs.readFile(join("/vault", "agent-groups", "fresh", "config.yml"));
    expect(written).toBe("agents: []\nfallback_order: {}\n");
  });
});

// ---------------------------------------------------------------------------
// createGroup
// ---------------------------------------------------------------------------

describe("createGroup", () => {
  it("creates the group directory, a skills subdir, and an empty config.yml", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    await createGroup(deps(fs), "/vault", "developers");
    const configStat = await fs.stat(join("/vault", "agent-groups", "developers", "config.yml"));
    expect(configStat.isDirectory()).toBe(false);
    const skillsStat = await fs.stat(join("/vault", "agent-groups", "developers", "skills"));
    expect(skillsStat.isDirectory()).toBe(true);
    const written = await fs.readFile(join("/vault", "agent-groups", "developers", "config.yml"));
    expect(written).toBe("agents: []\nfallback_order: {}\n");
  });

  it("refuses to overwrite an existing group without force", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    await createGroup(deps(fs), "/vault", "developers");
    await expect(createGroup(deps(fs), "/vault", "developers")).rejects.toThrow(
      /already exists|force/i,
    );
  });

  it("overwrites when force is set", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    await createGroup(deps(fs), "/vault", "developers");
    // Force re-create must not throw.
    await expect(createGroup(deps(fs), "/vault", "developers", { force: true })).resolves.toBeUndefined();
  });

  it("refuses an invalid group name", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    await expect(createGroup(deps(fs), "/vault", "../escape")).rejects.toThrow(/invalid group name/i);
  });
});

// ---------------------------------------------------------------------------
// addAgentToGroup
// ---------------------------------------------------------------------------

describe("addAgentToGroup", () => {
  it("adds an agent to an existing group", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    await seedGroup(fs, "/vault", "developers", {
      agents: ["dipu"],
      fallback_order: {},
    });
    const result = await addAgentToGroup(deps(fs), "/vault", "developers", "zai");
    expect(result.added).toBe(true);
    const read = await readGroupConfig(deps(fs), "/vault", "developers");
    expect(read?.agents).toEqual(["dipu", "zai"]);
  });

  it("no-ops (added=false) when the agent is already present and preserves order", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    await seedGroup(fs, "/vault", "developers", {
      agents: ["dipu", "zai"],
      fallback_order: {},
    });
    const result = await addAgentToGroup(deps(fs), "/vault", "developers", "dipu");
    expect(result.added).toBe(false);
    const read = await readGroupConfig(deps(fs), "/vault", "developers");
    expect(read?.agents).toEqual(["dipu", "zai"]);
  });

  it("refuses if the group does not exist", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    await expect(addAgentToGroup(deps(fs), "/vault", "ghost", "zai")).rejects.toThrow(
      /does not exist/i,
    );
  });
});

// ---------------------------------------------------------------------------
// removeAgentFromGroup
// ---------------------------------------------------------------------------

describe("removeAgentFromGroup", () => {
  it("removes an agent and its fallback_order entries", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    await seedGroup(fs, "/vault", "developers", {
      agents: ["dipu", "zai", "sam"],
      fallback_order: { zai: ["dipu", "sam"], dipu: ["zai"] },
    });
    const result = await removeAgentFromGroup(deps(fs), "/vault", "developers", "dipu");
    expect(result.removed).toBe(true);
    expect(result.existed).toBe(true);
    const read = await readGroupConfig(deps(fs), "/vault", "developers");
    expect(read?.agents).toEqual(["zai", "sam"]);
    // dipu removed from agents and from any fallback_order lists.
    expect(read?.fallback_order).toEqual({ zai: ["sam"] });
  });

  it("reports existed=false when the agent was not a member", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    await seedGroup(fs, "/vault", "developers", {
      agents: ["dipu"],
      fallback_order: {},
    });
    const result = await removeAgentFromGroup(deps(fs), "/vault", "developers", "ghost");
    expect(result.removed).toBe(false);
    expect(result.existed).toBe(false);
  });

  it("refuses if the group does not exist", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    await expect(removeAgentFromGroup(deps(fs), "/vault", "ghost", "dipu")).rejects.toThrow(
      /does not exist/i,
    );
  });
});

// ---------------------------------------------------------------------------
// setFallbackOrder
// ---------------------------------------------------------------------------

describe("setFallbackOrder", () => {
  it("creates a fallback_order entry for a member agent", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    await seedGroup(fs, "/vault", "developers", {
      agents: ["dipu", "zai", "sam"],
      fallback_order: {},
    });
    await setFallbackOrder(deps(fs), "/vault", "developers", "zai", ["dipu", "sam"]);
    const read = await readGroupConfig(deps(fs), "/vault", "developers");
    expect(read?.fallback_order.zai).toEqual(["dipu", "sam"]);
  });

  it("replaces an existing fallback_order entry", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    await seedGroup(fs, "/vault", "developers", {
      agents: ["dipu", "zai", "sam"],
      fallback_order: { zai: ["dipu"] },
    });
    await setFallbackOrder(deps(fs), "/vault", "developers", "zai", ["sam"]);
    const read = await readGroupConfig(deps(fs), "/vault", "developers");
    expect(read?.fallback_order.zai).toEqual(["sam"]);
  });

  it("preserves other fallback_order entries when setting one", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    await seedGroup(fs, "/vault", "developers", {
      agents: ["dipu", "zai", "sam"],
      fallback_order: { dipu: ["zai"] },
    });
    await setFallbackOrder(deps(fs), "/vault", "developers", "zai", ["sam"]);
    const read = await readGroupConfig(deps(fs), "/vault", "developers");
    expect(read?.fallback_order).toEqual({ dipu: ["zai"], zai: ["sam"] });
  });

  it("refuses if the agent is not a member of the group", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    await seedGroup(fs, "/vault", "developers", {
      agents: ["dipu"],
      fallback_order: {},
    });
    await expect(setFallbackOrder(deps(fs), "/vault", "developers", "zai", ["dipu"])).rejects.toThrow(
      /not a member|not in group/i,
    );
  });

  it("refuses if the group does not exist", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    await expect(setFallbackOrder(deps(fs), "/vault", "ghost", "dipu", ["zai"])).rejects.toThrow(
      /does not exist/i,
    );
  });
});

// ---------------------------------------------------------------------------
// validateGroups
// ---------------------------------------------------------------------------

describe("validateGroups", () => {
  it("returns no issues for a clean vault", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    fs.dir(join("/vault", "team", "dipu"));
    fs.dir(join("/vault", "team", "zai"));
    await seedGroup(fs, "/vault", "developers", {
      agents: ["dipu", "zai"],
      fallback_order: { zai: ["dipu"] },
    });
    const issues = await validateGroups(deps(fs), "/vault");
    expect(issues).toEqual([]);
  });

  it("reports a group directory that has no config.yml", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    fs.dir(join("/vault", "agent-groups", "ghosts"));
    const issues = await validateGroups(deps(fs), "/vault");
    expect(issues.some((i) => i.kind === "missing-config" && i.group === "ghosts")).toBe(true);
  });

  it("reports fallback_order entries referencing non-member agents", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    fs.dir(join("/vault", "team", "dipu"));
    fs.dir(join("/vault", "team", "zai"));
    await seedGroup(fs, "/vault", "developers", {
      agents: ["dipu", "zai"],
      fallback_order: { zai: ["dipu", "sam"] }, // sam not a member
    });
    const issues = await validateGroups(deps(fs), "/vault");
    expect(issues.some((i) => i.kind === "dangling-fallback" && i.group === "developers")).toBe(true);
  });

  it("reports groups referencing agents with no team/<agent>/ directory", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    fs.dir(join("/vault", "team", "dipu"));
    // zai declared but team/zai missing
    await seedGroup(fs, "/vault", "developers", {
      agents: ["dipu", "zai"],
      fallback_order: {},
    });
    const issues = await validateGroups(deps(fs), "/vault");
    expect(issues.some((i) => i.kind === "missing-agent-dir" && i.group === "developers")).toBe(true);
  });

  it("reports duplicate agents across groups as info (not error)", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    fs.dir(join("/vault", "team", "dipu"));
    await seedGroup(fs, "/vault", "developers", { agents: ["dipu"], fallback_order: {} });
    await seedGroup(fs, "/vault", "reviewers", { agents: ["dipu"], fallback_order: {} });
    const issues = await validateGroups(deps(fs), "/vault");
    const dup = issues.find((i) => i.kind === "duplicate-across-groups");
    expect(dup).toBeDefined();
    expect(dup?.severity).toBe("info");
  });

  it("returns no issues when agent-groups/ is empty or missing", async () => {
    const fs = new FakeFs();
    seedVault(fs, "/vault");
    const issues = await validateGroups(deps(fs), "/vault");
    expect(issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

describe("formatters", () => {
  it("formatGroupList lists group names with agent counts", () => {
    const out = formatGroupList([
      { name: "developers", config: { agents: ["dipu", "zai"], fallback_order: {} } },
      { name: "reviewers", config: { agents: [], fallback_order: {} } },
    ]);
    expect(out).toContain("Agent groups");
    expect(out).toContain("developers");
    expect(out).toContain("reviewers");
  });

  it("formatGroupConfig renders the group config as YAML", () => {
    const out = formatGroupConfig("developers", {
      agents: ["dipu", "zai"],
      fallback_order: { zai: ["dipu"] },
    });
    expect(out).toContain("developers");
    expect(out).toContain("agents:");
    expect(out).toContain("fallback_order:");
  });

  it("formatValidationReport renders each issue and a summary", () => {
    const issues: ValidationIssue[] = [
      { group: "developers", kind: "missing-agent-dir", severity: "error", message: "no team/zai" },
      { group: "reviewers", kind: "duplicate-across-groups", severity: "info", message: "dipu in 2 groups" },
    ];
    const out = formatValidationReport(issues);
    expect(out).toContain("developers");
    expect(out).toContain("reviewers");
    expect(out.toLowerCase()).toContain("error");
    expect(out.toLowerCase()).toContain("note");
  });
});
