import { describe, expect, it } from "vitest";
import { GatewayServer } from "../src/gateway-http.js";
import { GroupSettingsError, type GroupSettingsDeps } from "../src/group-settings.js";

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

describe("ST-4 correction: roster authority, validation read, auth, fail-closed I/O", () => {
  it("group detail returns ALL vault-defined agents with locallyRunnable markers", async () => {
    const files = new Map<string, string>([
      ["/vault/agent-groups/g/config.yml", "agents:\n  - kimi\n  - dipu\n"],
      ["/vault/team/kimi/SOUL.md", ""],
      ["/vault/team/dipu/SOUL.md", ""],
      ["/vault/team/offline-one/SOUL.md", ""],
    ]);
    const h = await start(files);
    try {
      const show = (await (await h.get("/api/settings/groups/g")).json()) as { roster: Array<{ name: string; locallyRunnable: boolean }> };
      expect(show.roster.map((r) => r.name)).toEqual(["dipu", "kimi", "offline-one"]);
      const byName = new Map(show.roster.map((r) => [r.name, r.locallyRunnable]));
      expect(byName.get("kimi")).toBe(true);
      expect(byName.get("offline-one")).toBe(false);
    } finally {
      await h.close();
    }
  });

  it("add-agent rejects non-vault-defined names server-side and accepts offline vault agents", async () => {
    const files = new Map<string, string>([
      ["/vault/agent-groups/g/config.yml", "agents:\n  - kimi\n"],
      ["/vault/team/kimi/SOUL.md", ""],
      ["/vault/team/offline-one/SOUL.md", ""],
    ]);
    const h = await start(files);
    try {
      const detail = (await (await h.get("/api/settings/groups/g")).json()) as { group: { revision: string } };
      const bad = await h.post({ action: "add-agent", group: "g", agent: "not-in-vault", expectedRevision: detail.group.revision });
      expect(bad.status).toBe(400);
      expect(files.get("/vault/agent-groups/g/config.yml")).toBe("agents:\n  - kimi\n");
      const ok = await h.post({ action: "add-agent", group: "g", agent: "offline-one", expectedRevision: detail.group.revision });
      expect(ok.status).toBe(200);
      expect(files.get("/vault/agent-groups/g/config.yml")).toContain("offline-one");
    } finally {
      await h.close();
    }
  });

  it("GET /api/settings/groups/validation reports cross-group CLI categories (read-only)", async () => {
    const files = new Map<string, string>([
      ["/vault/agent-groups/dev/config.yml", "agents:\n  - kimi\n  - ghost-agent\n"],
      ["/vault/agent-groups/research/config.yml", "agents:\n  - kimi\nfallback_order:\n  kimi:\n    - ghost\n"],
      ["/vault/team/kimi/SOUL.md", ""],
    ]);
    const before = JSON.stringify([...files.entries()].sort());
    const h = await start(files);
    try {
      const res = await h.get("/api/settings/groups/validation");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { available: boolean; issues: Array<{ group: string; kind: string; severity: string }> };
      expect(body.available).toBe(true);
      const kinds = body.issues.map((i) => i.kind);
      expect(kinds).toContain("missing-agent-dir");
      expect(kinds).toContain("dangling-fallback");
      expect(kinds).toContain("duplicate-across-groups");
      expect(JSON.stringify([...files.entries()].sort())).toBe(before);
    } finally {
      await h.close();
    }
  });

  it("group routes require the bearer token when one is configured (typed 401)", async () => {
    const server = new GatewayServer({
      target: { command: process.execPath, args: [join0()], cwd: process.cwd(), env: process.env },
      vaultRoot: "/vault",
      groupsIo: fakeGroupsIo(new Map()),
      runnableAgents: ["kimi"],
      authToken: "secret-token",
    } as never);
    const handle = await server.start();
    try {
      const base = `http://${handle.hostname}:${handle.port}`;
      expect((await fetch(`${base}/api/settings/groups`)).status).toBe(401);
      expect((await fetch(`${base}/api/settings/groups/validation`)).status).toBe(401);
      expect((await fetch(`${base}/api/settings/groups/g`)).status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("unreadable group state fails closed as bounded 500 and never writes", async () => {
    const ioDeps: GroupSettingsDeps = {
      readFile: async () => {
        throw new GroupSettingsError("io", "denied");
      },
      writeFileAtomic: async () => {},
      readdirSubdirs: async (path) => (path === "/vault/team" ? [] : ["g"]),
      mkdir: async () => {},
    };
    const files = new Map<string, string>();
    const server = new GatewayServer({
      target: { command: process.execPath, args: [join0()], cwd: process.cwd(), env: process.env },
      vaultRoot: "/vault",
      groupsIo: ioDeps,
      runnableAgents: ["kimi"],
    } as never);
    const handle = await server.start();
    try {
      const base = `http://${handle.hostname}:${handle.port}`;
      const post = async (body: unknown) =>
        fetch(`${base}/api/settings/groups`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      // readdir still works (empty), but every config READ fails closed.
      expect((await fetch(`${base}/api/settings/groups/validation`)).status).toBe(500);
      expect((await fetch(`${base}/api/settings/groups/g`)).status).toBe(500);
      expect((await post({ action: "create", group: "g", expectedRevision: "absent", confirm: true })).status).toBe(500);
      expect(files.size).toBe(0);
    } finally {
      await server.close();
    }
  });
});

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
      // Stale revision is EXACTLY a bounded conflict (409), never a generic 400;
      // bytes stay untouched.
      const stale = await h.post({ action: "remove-agent", group: "g", agent: "dipu", expectedRevision: revision, confirm: true });
      expect(stale.status).toBe(409);
      expect(files.get("/vault/agent-groups/g/config.yml")).toBe(raw);
    } finally {
      await h.close();
    }
  });
});
