import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { GatewayServer } from "../src/gateway-http.js";
import { type SettingsFoundationIo } from "../src/settings-foundation.js";

/**
 * 0.2.5 S7 — gateway scheduler agent-scope Settings routes. GET exposes the
 * gateway-authoritative runnable roster plus each class's effective selected
 * runnable set (computed server-side by the existing
 * `resolveSchedulerAgentScope`; null = unrestricted, [] = none) and bounded
 * resolver warnings, never the raw declared container. POST accepts the
 * closed per-class intent and rejects duplicate or non-runnable submitted
 * names with a bounded 400 before any write. Saving never operates the
 * scheduler.
 */

const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");
function fakePiTarget() {
  return { command: process.execPath, args: [fakePiScript], cwd: process.cwd(), env: process.env };
}

function fakeIo(initial: Record<string, string> = {}): { io: SettingsFoundationIo; files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(initial));
  const io: SettingsFoundationIo = {
    async readFile(path) {
      const value = files.get(path);
      if (value === undefined) {
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return value;
    },
    async writeFile(path, content) {
      files.set(path, content);
    },
    async fsync() {},
    async rename(from, to) {
      const value = files.get(from);
      if (value === undefined) throw new Error("rename source missing");
      files.delete(from);
      files.set(to, value);
    },
    async unlink(path) {
      files.delete(path);
    },
  };
  return { io, files };
}

async function startServer(
  initialConfig: string,
  runnableAgents: string[] = ["kimi", "dipu"],
): Promise<{ base: string; files: Map<string, string>; close: () => Promise<void> }> {
  const { io, files } = fakeIo({ "/tmp/config.yml": initialConfig });
  const server = new GatewayServer({
    target: fakePiTarget(),
    settingsConfigPath: "/tmp/config.yml",
    settingsIo: io,
    runnableAgents,
  } as never);
  const handle = await server.start();
  return { base: `http://${handle.hostname}:${handle.port}`, files, close: () => server.close() };
}

const post = (base: string, path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("S7 scheduler settings GET: runnable roster + effective agent scope", () => {
  it("exposes the roster, unrestricted classes as null, and never leaks the raw container", async () => {
    const { base, close } = await startServer("vault_root: /vault\nscheduler:\n  poll_interval_seconds: 15\n");
    try {
      const res = await fetch(`${base}/api/settings/scheduler`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.available).toBe(true);
      expect(json.runnableAgents).toEqual(["kimi", "dipu"]);
      expect(json.agentScopeWarnings).toEqual([]);
      const scheduler = json.scheduler as Record<string, unknown>;
      expect(scheduler.agentScope).toEqual({ inboxTasks: null, agentCron: null, scriptCron: null });
      expect(scheduler).not.toHaveProperty("agentScopeRaw");
      expect(JSON.stringify(json)).not.toContain("agentScopeRaw");
    } finally {
      await close();
    }
  });

  it("computes effective sets server-side with the existing resolver (allow intersection + exclude wins)", async () => {
    const seeded = [
      "scheduler:",
      "  agent_scope:",
      "    inbox_tasks:",
      "      allow:",
      "        - kimi",
      "        - ghost",
      "    agent_cron:",
      "      exclude:",
      "        - kimi",
      "    script_cron:",
      "      allow: []",
      "",
    ].join("\n");
    const { base, close } = await startServer(seeded);
    try {
      const res = await fetch(`${base}/api/settings/scheduler`);
      const json = (await res.json()) as Record<string, unknown>;
      const scheduler = json.scheduler as Record<string, unknown>;
      // `allow` intersects with the runnable roster; `exclude` wins from the
      // full roster; an explicit empty allow is the truthful none.
      expect(scheduler.agentScope).toEqual({
        inboxTasks: ["kimi"],
        agentCron: ["dipu"],
        scriptCron: [],
      });
      // The bounded resolver warning for the non-runnable configured name is
      // surfaced (count-only, never the configured value).
      const warnings = json.agentScopeWarnings as string[];
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("inbox_tasks.allow");
      expect(warnings[0]).toContain("not locally enabled agents");
      expect(JSON.stringify(json)).not.toContain("ghost");
    } finally {
      await close();
    }
  });

  it("a malformed present agent_scope fails closed with the resolver warning, truthfully", async () => {
    const { base, close } = await startServer("scheduler:\n  agent_scope: oops\n");
    try {
      const res = await fetch(`${base}/api/settings/scheduler`);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.available).toBe(true);
      expect((json.scheduler as Record<string, unknown>).agentScope).toEqual({
        inboxTasks: [],
        agentCron: [],
        scriptCron: [],
      });
      expect((json.agentScopeWarnings as string[]).length).toBe(1);
    } finally {
      await close();
    }
  });
});

describe("S7 scheduler settings POST: closed per-class intent + runnable rejection", () => {
  const SEEDED = [
    "scheduler:",
    "  automation:",
    "    inbox_tasks: true",
    "  agent_scope:",
    "    inbox_tasks:",
    "      allow:",
    "        - kimi",
    "      exclude:",
    "        - dipu",
    "    agent_cron:",
    "      allow:",
    "      - dipu",
    "",
  ].join("\n");

  it("writes a per-class subset (replace allow, clear exclude) and preserves untouched classes", async () => {
    const { base, files, close } = await startServer(SEEDED);
    try {
      const res = await post(base, "/api/settings/scheduler", {
        surface: "local",
        family: "scheduler",
        block: { agentScope: { inbox_tasks: ["dipu"] } },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ wrote: true });
      const written = files.get("/tmp/config.yml") ?? "";
      expect(written).toContain("allow:\n        - dipu");
      expect(written).not.toContain("exclude");
      expect(written).toContain("agent_cron");
      expect(written).toContain("inbox_tasks: true");
    } finally {
      await close();
    }
  });

  it("explicit null clears the recognized allow/exclude for that class only", async () => {
    const { base, files, close } = await startServer(SEEDED);
    try {
      const res = await post(base, "/api/settings/scheduler", {
        surface: "local",
        family: "scheduler",
        block: { agentScope: { inbox_tasks: null } },
      });
      expect(res.status).toBe(200);
      const written = parseYaml(files.get("/tmp/config.yml") ?? "") as Record<string, any>;
      expect(written.scheduler.agent_scope).toEqual({ agent_cron: { allow: ["dipu"] } });
      expect(written.scheduler.automation).toEqual({ inbox_tasks: true });
    } finally {
      await close();
    }
  });

  it("rejects duplicate submitted names with a bounded 400 before any write", async () => {
    const { base, files, close } = await startServer(SEEDED);
    try {
      const res = await post(base, "/api/settings/scheduler", {
        surface: "local",
        family: "scheduler",
        block: { agentScope: { inbox_tasks: ["kimi", "kimi"] } },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as Record<string, unknown>).error).toMatch(/duplicate/i);
      expect(files.get("/tmp/config.yml")).toBe(SEEDED);
    } finally {
      await close();
    }
  });

  it("rejects non-runnable submitted names with a bounded 400 before any write (no echo)", async () => {
    const { base, files, close } = await startServer(SEEDED);
    try {
      const res = await post(base, "/api/settings/scheduler", {
        surface: "local",
        family: "scheduler",
        block: { agentScope: { agent_cron: ["kimi", "ghost"] } },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/not locally runnable/i);
      expect(JSON.stringify(body)).not.toContain("ghost");
      expect(files.get("/tmp/config.yml")).toBe(SEEDED);
    } finally {
      await close();
    }
  });

  it("rejects malformed submitted values before any write (shape strict)", async () => {
    const { base, files, close } = await startServer(SEEDED);
    try {
      const res = await post(base, "/api/settings/scheduler", {
        surface: "local",
        family: "scheduler",
        block: { agentScope: { inbox_tasks: [42] } },
      });
      expect(res.status).toBe(400);
      expect(files.get("/tmp/config.yml")).toBe(SEEDED);
    } finally {
      await close();
    }
  });
});
