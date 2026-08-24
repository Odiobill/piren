import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GroupSettingsError,
  createNodeGroupSettingsDeps,
  listGroups,
  listVaultAgents,
  mutateGroup,
  parseGroupModel,
  readGroup,
  revisionOf,
  validateAllGroups,
} from "../src/group-settings.js";

/**
 * ST-4 pure group-settings core: revision-checked atomic writes that
 * preserve unknown top-level YAML fields, never clobber, and never create
 * unless explicitly allowed.
 */

function fakeDeps(files: Map<string, string>): {
  deps: ReturnType<typeof createNodeGroupSettingsDeps>;
} {
  const real = createNodeGroupSettingsDeps();
  return {
    deps: {
      readFile: async (path) => files.get(path) ?? null,
      writeFileAtomic: async (path, content, expectedSource) => {
        if ((files.get(path) ?? null) !== expectedSource) {
          throw new GroupSettingsError("conflict", "changed");
        }
        files.set(path, content);
      },
      readdirSubdirs: async (path) => {
        const prefix = `${path}/`;
        return [...files.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split("/")[0]!);
      },
      mkdir: async () => {},
    },
  };
}

const ROOT = "/vault/agent-groups";

describe("group-settings core (ST-4)", () => {
  it("create writes the modelled keys and preserves unknown top-level fields on later merges", async () => {
    const files = new Map<string, string>();
    const { deps } = fakeDeps(files);
    await mutateGroup(deps, ROOT, {
      group: "research", expectedRevision: "absent", allowCreate: true,
      mutate: (data) => ({ ...data, agents: ["kimi"] }),
    });
    const written = files.get(`${ROOT}/research/config.yml`)!;
    expect(written).toContain("agents:");
    // A later merge preserves an unknown field a CLI/user added meanwhile.
    files.set(`${ROOT}/research/config.yml`, `${written}\nfuture_key: keep\n`);
    await mutateGroup(deps, ROOT, {
      group: "research", expectedRevision: "absent-invalid-on-purpose", allowCreate: false,
      mutate: (data) => ({ ...data, agents: ["kimi", "dipu"] }),
    }).catch(() => undefined); // revision mismatch -> conflict (checked separately)
  });

  it("a stale revision fails as conflict and never clobbers", async () => {
    const files = new Map<string, string>([[`${ROOT}/g/config.yml`, "agents:\n  - kimi\n"]]);
    const { deps } = fakeDeps(files);
    await expect(
      mutateGroup(deps, ROOT, {
        group: "g", expectedRevision: "rev-stale-0", allowCreate: false,
        mutate: (data) => ({ ...data, agents: [] }),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(files.get(`${ROOT}/g/config.yml`)).toBe("agents:\n  - kimi\n");
  });

  it("read/list expose bounded modelled state with findings for dangling fallback entries", async () => {
    const raw = [
      "agents:",
      "  - kimi",
      "fallback_order:",
      "  kimi:",
      "    - dipu",
      "",
    ].join("\n");
    const { deps } = fakeDeps(new Map([[`${ROOT}/g/config.yml`, raw]]));
    const detail = await readGroup(deps, ROOT, "g");
    expect(detail?.revision).toMatch(/^rev-/);
    expect(detail?.findings.some((f) => f.kind === "dangling-candidate")).toBe(true);

    // Create path refuses to clobber an existing group config.
    const created = fakeDeps(new Map([[`${ROOT}/g/config.yml`, raw]]));
    await expect(
      mutateGroup(created.deps, ROOT, { group: "g", expectedRevision: "absent", allowCreate: true, mutate: (d) => d }),
    ).rejects.toMatchObject({ code: "conflict" });

    const summaries = await listGroups(deps, ROOT);
    expect(summaries).toEqual([{ name: "g", revision: expect.any(String) }]);
  });

  it("a successful merge PRESERVES unknown top-level YAML keys byte-meaningfully", async () => {
    const files = new Map<string, string>();
    const { deps } = fakeDeps(files);
    await mutateGroup(deps, ROOT, {
      group: "research", expectedRevision: "absent", allowCreate: true,
      mutate: (data) => ({ ...data, agents: ["kimi"] }),
    });
    // A CLI/user replaces the file meanwhile: an unknown top-level key plus a
    // fallback entry appear alongside the modelled ones.
    const external = "future_key: keep\nagents:\n  - kimi\nfallback_order:\n  kimi:\n    - dipu\n";
    files.set(`${ROOT}/research/config.yml`, external);
    const updated = await mutateGroup(deps, ROOT, {
      group: "research",
      expectedRevision: revisionOf(external),
      allowCreate: false,
      mutate: (data) => ({ ...data, agents: ["kimi", "dipu"] }),
    });
    const written = files.get(`${ROOT}/research/config.yml`)!;
    expect(written).toContain("future_key: keep");
    expect(written).toContain("dipu");
    expect(updated.agents).toEqual(["kimi", "dipu"]);
    // The externally added fallback entry survives the merge.
    expect(updated.fallbackOrder["kimi"]).toEqual(["dipu"]);
    expect(written).toContain("fallback_order:");
  });

  it("create builds the standard skills/ directory like the group CLI", async () => {
    const made: string[] = [];
    const deps = {
      readFile: async () => null,
      writeFileAtomic: async () => {},
      readdirSubdirs: async () => [] as string[],
      mkdir: async (path: string) => {
        made.push(path);
      },
    };
    await mutateGroup(deps, ROOT, {
      group: "research", expectedRevision: "absent", allowCreate: true,
      mutate: (data) => data,
    });
    expect(made).toContain(`${ROOT}/research/skills`);
  });

  it("an unparseable source fails mutation closed as invalid and never writes", async () => {
    const raw = "agents: [broken\n\t:: not yaml\n";
    const files = new Map<string, string>([[`${ROOT}/g/config.yml`, raw]]);
    const { deps } = fakeDeps(files);
    await expect(
      mutateGroup(deps, ROOT, {
        group: "g",
        expectedRevision: revisionOf(raw),
        allowCreate: false,
        mutate: (data) => ({ ...data, agents: ["x"] }),
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(files.get(`${ROOT}/g/config.yml`)).toBe(raw);
  });
});

describe("node group-settings adapter distinguishes absence from I/O failure", () => {
  let dir: string;

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it("readFile returns null on ENOENT and fails closed with io on other errors", async () => {
    dir = mkdtempSync(join(tmpdir(), "group-settings-io-"));
    const deps = createNodeGroupSettingsDeps();
    expect(await deps.readFile(join(dir, "absent.yml"))).toBeNull();
    // Reading a DIRECTORY yields EISDIR - never treated as absent.
    await expect(deps.readFile(dir)).rejects.toMatchObject({ code: "io" });
  });

  it("readdirSubdirs returns [] on ENOENT and fails closed with io on other errors", async () => {
    dir = mkdtempSync(join(tmpdir(), "group-settings-io-"));
    const deps = createNodeGroupSettingsDeps();
    expect(await deps.readdirSubdirs(join(dir, "absent"))).toEqual([]);
    // Listing a FILE yields ENOTDIR - never silently empty.
    const filePath = join(dir, "plain.txt");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(filePath, "x", "utf8");
    await expect(deps.readdirSubdirs(filePath)).rejects.toMatchObject({ code: "io" });
  });

  it("writeFileAtomic fails closed when the current file cannot be read (not absent)", async () => {
    dir = mkdtempSync(join(tmpdir(), "group-settings-io-"));
    const deps = createNodeGroupSettingsDeps();
    // expectedSource null means 'create': an unreadable EXISTING target must
    // never be treated as absent and clobbered.
    await expect(deps.writeFileAtomic(dir, "agents: []\n", null)).rejects.toMatchObject({ code: "io" });
  });
});

describe("vault roster + cross-group validation core (ST-4 correction)", () => {
  function fakeWithTeam(files: Map<string, string>): ReturnType<typeof createNodeGroupSettingsDeps> {
    return {
      readFile: async (path) => files.get(path) ?? null,
      writeFileAtomic: async () => {},
      readdirSubdirs: async (path) => {
        const prefix = `${path}/`;
        return [...files.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split("/")[0]!);
      },
      mkdir: async () => {},
    };
  }

  it("listVaultAgents returns every vault-defined team/<agent>/ identity", async () => {
    const files = new Map<string, string>([
      ["/vault/team/kimi/SOUL.md", ""],
      ["/vault/team/dipu/SOUL.md", ""],
      ["/vault/team/offline-one/SOUL.md", ""],
    ]);
    expect(await listVaultAgents(fakeWithTeam(files), "/vault")).toEqual(["dipu", "kimi", "offline-one"]);
    expect(await listVaultAgents(fakeWithTeam(new Map()), "/vault")).toEqual([]);
  });

  it("validateAllGroups reports the CLI categories across groups", async () => {
    const files = new Map<string, string>([
      // ok group with one offline member
      ["/vault/agent-groups/dev/config.yml", "agents:\n  - kimi\n  - offline-one\n"],
      ["/vault/team/kimi/SOUL.md", ""],
      ["/vault/team/offline-one/SOUL.md", ""],
      // dangling fallback candidate
      ["/vault/agent-groups/research/config.yml", "agents:\n  - kimi\nfallback_order:\n  kimi:\n    - ghost\n"],
      // directory without config.yml
      ["/vault/agent-groups/empty/placeholder.txt", ""],
    ]);
    const issues = await validateAllGroups(fakeWithTeam(files), "/vault/agent-groups", "/vault/team");
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain("missing-config");
    expect(kinds).toContain("dangling-fallback");
    // offline-one IS vault-defined here, so no missing-agent-dir.
    expect(kinds.filter((k) => k === "missing-agent-dir")).toEqual([]);
    // kimi is declared in two groups -> info note per group.
    const dupes = issues.filter((i) => i.kind === "duplicate-across-groups");
    expect(dupes.map((i) => i.group).sort()).toEqual(["dev", "research"]);
    for (const issue of dupes) expect(issue.severity).toBe("info");
  });

  it("validateAllGroups reports missing-agent-dir for non-vault members", async () => {
    const files = new Map<string, string>([
      ["/vault/agent-groups/dev/config.yml", "agents:\n  - ghost-agent\n"],
    ]);
    const issues = await validateAllGroups(fakeWithTeam(files), "/vault/agent-groups", "/vault/team");
    expect(issues.some((i) => i.kind === "missing-agent-dir" && i.group === "dev")).toBe(true);
  });

  it("validateAllGroups returns no issues for a healthy single-group vault", async () => {
    const files = new Map<string, string>([
      ["/vault/agent-groups/dev/config.yml", "agents:\n  - kimi\n"],
      ["/vault/team/kimi/SOUL.md", ""],
    ]);
    expect(await validateAllGroups(fakeWithTeam(files), "/vault/agent-groups", "/vault/team")).toEqual([]);
  });

  it("parseGroupModel stays tolerant on malformed documents", () => {
    expect(parseGroupModel(":: not yaml")).toEqual({ agents: [], fallbackOrder: {} });
    expect(parseGroupModel("")).toEqual({ agents: [], fallbackOrder: {} });
  });
});
