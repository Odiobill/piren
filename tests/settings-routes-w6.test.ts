import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayServer } from "../src/gateway-http.js";
import { type SettingsFoundationIo } from "../src/settings-foundation.js";

/**
 * W6 (0.2.0 amendment §2/§5/§5.1; ADR-0046): typed scheduler + vault-owned
 * agent-preference Settings routes over W4/W5. Proves: scheduler redacted
 * read (incl. the editable poll/stale/concurrency/device values) + closed
 * write with no scheduler operation; agent containment + runnable-only
 * access; the model-fallback confirmation matrix (enabled auto-switch and
 * models-only edit on an enabled declaration require confirmAutoSwitch;
 * disabled saves never do); redaction (no token/raw config); existing auth.
 */

const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");
function fakePiTarget() {
  return { command: process.execPath, args: [fakePiScript], cwd: process.cwd(), env: process.env };
}

function fakeIo(initial: Record<string, string> = {}): {
  io: SettingsFoundationIo;
  files: Map<string, string>;
  failOn: (op: keyof SettingsFoundationIo, error: unknown) => void;
} {
  const files = new Map<string, string>(Object.entries(initial));
  let failure: { op: keyof SettingsFoundationIo; error: unknown } | null = null;
  function enoent(): never {
    const e = new Error("ENOENT") as NodeJS.ErrnoException;
    e.code = "ENOENT";
    throw e;
  }
  const io: SettingsFoundationIo = {
    async readFile(path) {
      if (failure?.op === "readFile") throw failure.error;
      const value = files.get(path);
      if (value === undefined) enoent();
      return value;
    },
    async writeFile(path, content) {
      if (failure?.op === "writeFile") throw failure.error;
      files.set(path, content);
    },
    async fsync() {
      if (failure?.op === "fsync") throw failure.error;
    },
    async rename(from, to) {
      if (failure?.op === "rename") throw failure.error;
      const value = files.get(from);
      if (value === undefined) enoent();
      files.delete(from);
      files.set(to, value);
    },
    async unlink(path) {
      files.delete(path);
    },
  };
  return { io, files, failOn: (op, error) => (failure = { op, error }) };
}

const LOCAL = "vault_root: /vault\nscheduler:\n  enabled: true\n  poll_interval_seconds: 15\n  device_id: thor\n";
const AGENT_CFG = "model:\n  id: anthropic/claude-sonnet-4-6\n  fallback:\n    auto_switch: true\n    models:\n      - openrouter/kimi-k3\n";

async function startServer(overrides: Record<string, unknown> = {}): Promise<{ base: string; files: Map<string, string>; close: () => Promise<void> }> {
  const { io, files } = fakeIo({ "/tmp/config.yml": LOCAL, "/vault/team/kimi/config.yml": AGENT_CFG });
  const server = new GatewayServer({
    target: fakePiTarget(),
    settingsConfigPath: "/tmp/config.yml",
    settingsIo: io,
    vaultRoot: "/vault",
    runnableAgents: ["kimi", "dipu"],
    ...overrides,
  } as never);
  const handle = await server.start();
  return { base: `http://${handle.hostname}:${handle.port}`, files, close: () => server.close() };
}

const post = (base: string, path: string, body: unknown, auth?: string): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth !== undefined ? { authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
  });

describe("W6 scheduler settings route", () => {
  it("reads the redacted scheduler projection incl. poll/stale/concurrency/device values", async () => {
    const { base, close } = await startServer();
    try {
      const res = await fetch(`${base}/api/settings/scheduler`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.available).toBe(true);
      expect((json.scheduler as Record<string, unknown>).enabled).toBe(true);
      expect((json.scheduler as Record<string, unknown>).pollIntervalSeconds).toBe(15);
      expect((json.scheduler as Record<string, unknown>).deviceId).toBe("thor");
      expect((json.scheduler as Record<string, unknown>).staleAfterSeconds).toBeNull();
    } finally {
      await close();
    }
  });

  it("writes a closed scheduler intent atomically and never operates the scheduler", async () => {
    const { base, files, close } = await startServer();
    try {
      const res = await post(base, "/api/settings/scheduler", {
        surface: "local",
        family: "scheduler",
        block: { automation: { inbox_tasks: true }, staleAfterSeconds: 120 },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ wrote: true });
      expect(files.get("/tmp/config.yml")).toContain("inbox_tasks: true");
      expect(files.get("/tmp/config.yml")).toContain("stale_after_seconds: 120");
    } finally {
      await close();
    }
  });

  it("rejects an unknown scheduler block field (closed inventory)", async () => {
    const { base, close } = await startServer();
    try {
      expect((await post(base, "/api/settings/scheduler", { surface: "local", family: "scheduler", block: { retry_policy: "x" } })).status).toBe(400);
    } finally {
      await close();
    }
  });
});

describe("W6 agent-preference routes", () => {
  it("reads the redacted agent projection incl. the editable fallback declaration and review-loop values", async () => {
    const { base, close } = await startServer();
    try {
      const res = await fetch(`${base}/api/settings/agents/kimi`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.available).toBe(true);
      expect((json.model as Record<string, unknown>).id).toBe("anthropic/claude-sonnet-4-6");
      expect((json.modelFallback as Record<string, unknown>).models).toEqual(["openrouter/kimi-k3"]);
    } finally {
      await close();
    }
  });

  it("rejects a non-runnable agent with 403", async () => {
    const { base, close } = await startServer();
    try {
      expect((await fetch(`${base}/api/settings/agents/ghost`)).status).toBe(403);
      expect((await post(base, "/api/settings/agents/ghost", { surface: "agent", agent: "ghost", family: "model", block: { id: "x" } })).status).toBe(403);
    } finally {
      await close();
    }
  });

  it("rejects a route/body agent mismatch", async () => {
    const { base, close } = await startServer();
    try {
      expect((await post(base, "/api/settings/agents/kimi", { surface: "agent", agent: "dipu", family: "model", block: { id: "x" } })).status).toBe(400);
    } finally {
      await close();
    }
  });

  it("writes a model preference atomically", async () => {
    const { base, files, close } = await startServer();
    try {
      expect((await post(base, "/api/settings/agents/kimi", { surface: "agent", agent: "kimi", family: "model", block: { thinking: "medium" } })).status).toBe(200);
      expect(files.get("/vault/team/kimi/config.yml")).toContain("thinking: medium");
    } finally {
      await close();
    }
  });
});

describe("W6 model-fallback confirmation matrix", () => {
  it("enabling auto-switch (autoSwitch: true) requires confirmAutoSwitch", async () => {
    const { base, close } = await startServer();
    try {
      // Existing declaration has auto_switch true; a models-only edit leaves it enabled.
      const without = await post(base, "/api/settings/agents/kimi", { surface: "agent", agent: "kimi", family: "model-fallback", block: { models: ["openrouter/kimi-k3", "opencode-go/kimi-k3"] } });
      expect(without.status).toBe(400);
      expect((await without.json() as { error: string }).error).toMatch(/confirmation/i);

      const withConfirm = await post(base, "/api/settings/agents/kimi", {
        surface: "agent", agent: "kimi", family: "model-fallback",
        block: { models: ["openrouter/kimi-k3", "opencode-go/kimi-k3"] }, confirmAutoSwitch: true,
      });
      expect(withConfirm.status).toBe(200);
      expect(await withConfirm.json()).toEqual({ wrote: true });
    } finally {
      await close();
    }
  });

  it("disabling auto-switch never requires confirmation", async () => {
    const { base, close } = await startServer();
    try {
      const res = await post(base, "/api/settings/agents/kimi", { surface: "agent", agent: "kimi", family: "model-fallback", block: { autoSwitch: false, models: ["openrouter/kimi-k3"] } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ wrote: true });
    } finally {
      await close();
    }
  });

  it("a non-boolean confirmAutoSwitch is rejected by the closed parser", async () => {
    const { base, close } = await startServer();
    try {
      expect((await post(base, "/api/settings/agents/kimi", { surface: "agent", agent: "kimi", family: "model-fallback", block: { autoSwitch: true }, confirmAutoSwitch: "yes" })).status).toBe(400);
    } finally {
      await close();
    }
  });
});

describe("W6 routes: existing auth + redaction", () => {
  it("a configured token enforces Bearer on scheduler and agent routes", async () => {
    const { base, close } = await startServer({ authToken: "gw" });
    try {
      expect((await fetch(`${base}/api/settings/scheduler`)).status).toBe(401);
      expect((await fetch(`${base}/api/settings/agents/kimi`)).status).toBe(401);
      expect((await fetch(`${base}/api/settings/scheduler`, { headers: { authorization: "Bearer gw" } })).status).toBe(200);
    } finally {
      await close();
    }
  });

  it("never echoes the gateway token or raw config in a response", async () => {
    const { base, close } = await startServer({ authToken: "gateway-secret" });
    try {
      const res = await fetch(`${base}/api/settings/agents/kimi`, { headers: { authorization: "Bearer gateway-secret" } });
      const text = await res.text();
      expect(text).not.toContain("gateway-secret");
    } finally {
      await close();
    }
  });
});
