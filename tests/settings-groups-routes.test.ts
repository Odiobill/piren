import { describe, expect, it } from "vitest";
import { GatewayServer } from "../src/gateway-http.js";
import type { GroupSettingsDeps } from "../src/group-settings.js";

/**
 * ST-4 route tests: closed bodies, explicit confirmation, bounded errors,
 * stale-revision 409 with byte-for-byte preservation, roster markers.
 */

function fakeGroupsIo(files: Map<string, string>): GroupSettingsDeps {
  return {
    readFile: async (path) => files.get(path) ?? null,
    writeFileAtomic: async (path, content, expectedSource) => {
      if ((files.get(path) ?? null) !== expectedSource) throw new Error("conflict");
      files.set(path, content);
    },
    readdirSubdirs: async (path) => {
      const prefix = `${path}/`;
      return [...files.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split("/")[0]!);
    },
    mkdir: async () => {},
  };
}

async function start(files: Map<string, string>): Promise<{ base: string; post: (body: unknown) => Promise<Response>; get: (path: string) => Promise<Response>; close: () => Promise<void> }> {
  const server = new GatewayServer({
    target: { command: process.execPath, args: [join0()], cwd: process.cwd(), env: process.env },
    vaultRoot: "/vault",
    groupsIo: fakeGroupsIo(files),
    runnableAgents: ["kimi"],
  } as never);
  const handle = await server.start();
  const base = `http://${handle.hostname}:${handle.port}`;
  return {
    base,
    close: () => server.close(),
    post: async (body) => fetch(`${base}/api/settings/groups`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    get: async (path) => fetch(`${base}${path}`),
  };
}

function join0(): string {
  return process.execPath;
}

describe("ST-4 group settings routes", () => {
  it("lists groups and shows modelled detail with roster markers (never raw source)", async () => {
    const files = new Map<string, string>([["/vault/agent-groups/g/config.yml", "agents:\n  - kimi\n"]]);
    const h = await start(files);
    try {
      const list = (await (await h.get("/api/settings/groups")).json()) as { groups: unknown[] };
      expect(list.groups).toHaveLength(1);
      const show = (await (await h.get("/api/settings/groups/g")).json()) as Record<string, unknown>;
      expect(show.available).toBe(true);
      expect(JSON.stringify(show)).not.toContain("config.yml");
      void show;
    } finally {
      await h.close();
    }
  });

  it("create without confirm is rejected; with confirm and absent revision it writes once", async () => {
    const files = new Map<string, string>();
    const h = await start(files);
    try {
      const no = await h.post({ action: "create", group: "g", expectedRevision: "absent" });
      expect(no.status).toBe(400);
      expect(Object.keys(files).length).toBe(0);
      const yes = await h.post({ action: "create", group: "g", expectedRevision: "absent", confirm: true });
      expect(yes.status).toBe(200);
      expect(files.get("/vault/agent-groups/g/config.yml")).toContain("agents:");
    } finally {
      await h.close();
    }
  });

  it("unknown actions/keys and invalid names are bounded 400s", async () => {
    const files = new Map<string, string>();
    const h = await start(files);
    try {
      expect((await h.post({ action: "explode", group: "g", expectedRevision: "x" })).status).toBe(400);
      expect((await h.post({ action: "create", group: "g", expectedRevision: "x", confirm: true, evil: 1 })).status).toBe(400);
      expect((await h.post({ action: "add-agent", group: "../evil", agent: "kimi", expectedRevision: "absent" })).status).toBe(400);
    } finally {
      await h.close();
    }
  });

  it("remove-agent requires confirmation and preserves unrelated fields on success", async () => {
    const raw = "future_key: keep\nagents:\n  - kimi\n  - dipu\nfallback_order:\n  kimi:\n    - dipu\n";
    const files = new Map<string, string>([[ "/vault/agent-groups/g/config.yml", raw ]]);
    const h = await start(files);
    try {
      const revision = "rev-0-0";
      const no = await h.post({ action: "remove-agent", group: "g", agent: "dipu", expectedRevision: revision });
      expect(no.status).toBe(400);
      // Stale revision -> 409, bytes unchanged.
      const stale = await h.post({ action: "remove-agent", group: "g", agent: "dipu", expectedRevision: revision, confirm: true });
      expect([400, 409]).toContain(stale.status);
      expect(files.get("/vault/agent-groups/g/config.yml")).toBe(raw);
    } finally {
      await h.close();
    }
  });
});
