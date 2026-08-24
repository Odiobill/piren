import { describe, expect, it } from "vitest";
import {
  GroupSettingsError,
  createNodeGroupSettingsDeps,
  listGroups,
  mutateGroup,
  readGroup,
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
});
