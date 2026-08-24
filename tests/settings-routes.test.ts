import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayServer } from "../src/gateway-http.js";
import { SettingsFoundationError, type SettingsFoundationIo } from "../src/settings-foundation.js";

/**
 * W5 (0.2.0 amendment §5; ADR-0046): typed transport Settings routes over the
 * W4 foundation. The routes inherit the EXISTING gateway auth gate (no token
 * => open on the loopback dev default; a configured token => Bearer enforced
 * on every /api/* route). Reads are fully redacted; writes go through the
 * atomic/revision-checked foundation and never echo a submitted token in any
 * response, error, or URL. No platform/service contact occurs anywhere.
 */

const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");

function fakePiTarget() {
  return { command: process.execPath, args: [fakePiScript], cwd: process.cwd(), env: process.env };
}

/** In-memory foundation io with an optional injected failure hook. */
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

const TELEGRAM_CONFIG =
  "vault_root: /vault\n" +
  "telegram:\n" +
  "  bot_token: SECRETTOKEN123\n" +
  "  allowed_chat_ids:\n" +
  "    - 123456789\n" +
  "  default_agent: piren\n" +
  "  feedback:\n" +
  "    enabled: true\n";

async function start(overrides: Record<string, unknown> = {}): Promise<{ base: string; close: () => Promise<void> }> {
  const server = new GatewayServer({
    target: fakePiTarget(),
    settingsConfigPath: "/tmp/config.yml",
    settingsIo: fakeIo({ "/tmp/config.yml": TELEGRAM_CONFIG }).io,
    ...overrides,
  } as never);
  const handle = await server.start();
  return { base: `http://${handle.hostname}:${handle.port}`, close: () => server.close() };
}

describe("W5 transport Settings routes: redacted reads", () => {
  it("GET /api/settings/telegram returns only the redacted projection (no token text anywhere)", async () => {
    const { base, close } = await start();
    try {
      const res = await fetch(`${base}/api/settings/telegram`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json).toEqual({
        available: true,
        telegram: {
          configured: true,
          allowedChatIds: 1,
          allowedChatIdValues: [123456789],
          defaultAgent: "piren",
          feedbackEnabled: true,
        },
      });
      // Hostile proof: the token never appears in the body.
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(JSON.stringify(json)).not.toContain("SECRETTOKEN123");
    } finally {
      await close();
    }
  });

  it("GET /api/settings/discord returns the discord projection incl. the W5 feedback field", async () => {
    const discordConfig =
      "vault_root: /vault\n" +
      "discord:\n" +
      "  bot_token: DISCTOKEN\n" +
      "  allowed_guild_ids:\n" +
      "    - '1'\n" +
      "  allowed_channel_ids:\n" +
      "    - '2'\n" +
      "  feedback:\n" +
      "    enabled: false\n";
    const { io } = fakeIo({ "/tmp/config.yml": discordConfig });
    const server = new GatewayServer({ target: fakePiTarget(), settingsConfigPath: "/tmp/config.yml", settingsIo: io } as never);
    const handle = await server.start();
    try {
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/settings/discord`);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json).toEqual({
        available: true,
        discord: {
          configured: true,
          allowedGuildIds: 1,
          allowedGuildIdValues: ["1"],
          allowedChannelIds: 1,
          allowedChannelIdValues: ["2"],
          allowedThreadIds: null,
          allowedThreadIdValues: null,
          allowedDmUserIds: null,
          allowedDmUserIdValues: null,
          defaultAgent: null,
          feedbackEnabled: false,
        },
      });
      expect(JSON.stringify(json)).not.toContain("DISCTOKEN");
    } finally {
      await server.close();
    }
  });

  it("missing config reads fail closed with a bounded non-secret state", async () => {
    const { io } = fakeIo(); // no config file
    const server = new GatewayServer({ target: fakePiTarget(), settingsConfigPath: "/tmp/config.yml", settingsIo: io } as never);
    const handle = await server.start();
    try {
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/settings/telegram`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ available: false, reason: "Local config is not present." });
    } finally {
      await server.close();
    }
  });
});

describe("W5 transport Settings routes: closed writes", () => {
  it("POST /api/settings/telegram applies the intent and returns only { wrote: true }", async () => {
    const { io, files } = fakeIo({ "/tmp/config.yml": TELEGRAM_CONFIG });
    const server = new GatewayServer({ target: fakePiTarget(), settingsConfigPath: "/tmp/config.yml", settingsIo: io, runnableAgents: ["other"] } as never);
    const handle = await server.start();
    try {
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/settings/telegram`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          surface: "local",
          family: "telegram",
          block: { botToken: "NEWTOKEN999", allowedChatIds: [1, 2], defaultAgent: "other" },
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ wrote: true });
      // The token went ONLY into the written document, never the response.
      const written = files.get("/tmp/config.yml") ?? "";
      expect(written).toContain("NEWTOKEN999");
      expect(written).toContain("allowed_chat_ids");
    } finally {
      await server.close();
    }
  });

  it("rejects unknown block fields with a bounded 400 (closed inventory)", async () => {
    const { base, close } = await start();
    try {
      const res = await fetch(`${base}/api/settings/telegram`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ surface: "local", family: "telegram", block: { unknown_field: true } }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as Record<string, unknown>).not.toHaveProperty("unknown_field");
    } finally {
      await close();
    }
  });

  it("rejects a family mismatch (discord block on the telegram route)", async () => {
    const { base, close } = await start();
    try {
      const res = await fetch(`${base}/api/settings/telegram`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ surface: "local", family: "discord", block: { defaultAgent: "x" } }),
      });
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });

  it("maps foundation error codes to bounded statuses without echoing anything", async () => {
    const { io, failOn } = fakeIo({ "/tmp/config.yml": TELEGRAM_CONFIG });
    const server = new GatewayServer({ target: fakePiTarget(), settingsConfigPath: "/tmp/config.yml", settingsIo: io, runnableAgents: ["x"] } as never);
    const handle = await server.start();
    const base = `http://${handle.hostname}:${handle.port}`;
    const body = JSON.stringify({ surface: "local", family: "telegram", block: { defaultAgent: "x" } });
    try {
      failOn("rename", new SettingsFoundationError("revision-changed", "changed"));
      expect((await fetch(`${base}/api/settings/telegram`, { method: "POST", headers: { "content-type": "application/json" }, body })).status).toBe(409);
      failOn("writeFile", new SettingsFoundationError("write-failed", "failed"));
      expect((await fetch(`${base}/api/settings/telegram`, { method: "POST", headers: { "content-type": "application/json" }, body })).status).toBe(500);
      // The error body is bounded and carries no token/config content.
      const res = await fetch(`${base}/api/settings/telegram`, { method: "POST", headers: { "content-type": "application/json" }, body });
      const text = await res.text();
      expect(text).not.toContain("SECRETTOKEN123");
      expect(text).not.toContain("failed"); // the raw io error text stays server-side
    } finally {
      await server.close();
    }
  });
});

describe("W5 transport Settings routes: existing auth gate", () => {
  it("loopback default (no token) serves the routes without Bearer", async () => {
    const { base, close } = await start();
    try {
      expect((await fetch(`${base}/api/settings/telegram`)).status).toBe(200);
    } finally {
      await close();
    }
  });

  it("a configured token enforces Bearer on reads AND writes (401 without, 200 with)", async () => {
    const { io } = fakeIo({ "/tmp/config.yml": TELEGRAM_CONFIG });
    const server = new GatewayServer({
      target: fakePiTarget(),
      settingsConfigPath: "/tmp/config.yml",
      settingsIo: io,
      authToken: "gateway-secret",
    } as never);
    const handle = await server.start();
    const base = `http://${handle.hostname}:${handle.port}`;
    try {
      // Without Bearer: fail closed.
      expect((await fetch(`${base}/api/settings/telegram`)).status).toBe(401);
      expect((await fetch(`${base}/api/settings/telegram`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surface: "local", family: "telegram", block: { defaultAgent: "x" } }) })).status).toBe(401);
      // With the valid Bearer: served.
      const ok = await fetch(`${base}/api/settings/telegram`, { headers: { authorization: "Bearer gateway-secret" } });
      expect(ok.status).toBe(200);
      // The gateway token never appears in any response.
      expect(await ok.text()).not.toContain("gateway-secret");
    } finally {
      await server.close();
    }
  });
});
