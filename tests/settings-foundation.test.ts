import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseSettingsIntent } from "../src/settings-foundation.js";

/**
 * W4 (0.2.0 amendment §5; ADR-0046) — closed intent model tests: the
 * foundation accepts exactly the declared Tier A kinds/fields and rejects
 * everything else (never a generic YAML/JSON/object patcher). Supplied
 * secrets (write-only bot tokens) are accepted structurally but never echoed
 * in errors or results.
 */

const HOSTILE_TOKEN = "123456:ABC-secret-token_xyz\"'\\\n<script>";

describe("parseSettingsIntent: closed kind model", () => {
  it("accepts every declared local family", () => {
    for (const family of ["telegram", "discord", "scheduler"]) {
      const raw =
        family === "telegram"
          ? { surface: "local", family, block: { allowedChatIds: [42] } }
          : family === "discord"
            ? { surface: "local", family, block: { allowedGuildIds: ["123456789012345678"] } }
            : { surface: "local", family, block: { automation: { inbox_tasks: true } } };
      const result = parseSettingsIntent(raw);
      expect(result.ok).toBe(true);
    }
  });

  it("accepts every declared agent family", () => {
    const cases = [
      { surface: "agent", agent: "kimi", family: "model", block: { id: "anthropic/claude-sonnet-4-6", thinking: "high" } },
      { surface: "agent", agent: "kimi", family: "model-fallback", block: { models: ["openrouter/kimi-k3"] } },
      { surface: "agent", agent: "kimi", family: "context-injection", mode: "session_start_only" },
      { surface: "agent", agent: "kimi", family: "self-improvement", block: { autoNudge: true } },
    ];
    for (const raw of cases) {
      expect(parseSettingsIntent(raw).ok, JSON.stringify(raw)).toBe(true);
    }
  });

  it("rejects unknown kinds, surfaces, and families with bounded errors", () => {
    for (const raw of [
      { surface: "local", family: "gateway", block: {} },
      { surface: "local", family: "provider-credentials", block: {} },
      { surface: "browser", family: "telegram", block: {} },
      { surface: "agent", agent: "kimi", family: "soul", block: {} },
      { surface: "agent", agent: "kimi", family: "allowed-agents", block: {} },
      "telegram",
      42,
      null,
      undefined,
      [],
    ]) {
      const result = parseSettingsIntent(raw);
      expect(result.ok, JSON.stringify(raw)).toBe(false);
      if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("rejects unknown envelope fields as well as block fields (never a generic patch envelope)", () => {
    for (const raw of [
      { surface: "local", family: "telegram", block: { allowedChatIds: [42] }, revision: "opaque" },
      { surface: "agent", agent: "kimi", family: "context-injection", mode: "per_turn", block: {} },
    ]) {
      expect(parseSettingsIntent(raw).ok).toBe(false);
    }
  });

  it("rejects unknown fields inside a block (closed inventory, no outside keys)", () => {
    const result = parseSettingsIntent({
      surface: "local",
      family: "telegram",
      block: { allowedChatIds: [42], bot_token_backup: "x", yaml: "raw: text" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown|unrecognized/i);
  });

  it("rejects an empty block (a patch must change at least one field)", () => {
    expect(parseSettingsIntent({ surface: "local", family: "scheduler", block: {} }).ok).toBe(false);
  });

  it("rejects malformed field types", () => {
    for (const raw of [
      { surface: "local", family: "telegram", block: { allowedChatIds: "42" } },
      { surface: "local", family: "telegram", block: { allowedChatIds: [42.5] } },
      { surface: "local", family: "scheduler", block: { enabled: "yes" } },
      { surface: "local", family: "scheduler", block: { pollIntervalSeconds: 0 } },
      { surface: "local", family: "scheduler", block: { automation: { inbox_tasks: "true" } } },
      { surface: "local", family: "scheduler", block: { automation: { unknown_class: true } } },
      { surface: "agent", agent: "kimi", family: "context-injection", mode: "sometimes" },
      { surface: "agent", agent: "kimi", family: "model", block: { thinking: "banana" } },
      { surface: "agent", agent: "kimi", family: "self-improvement", block: { reviewLoopIntervalTurns: -1 } },
    ]) {
      expect(parseSettingsIntent(raw).ok, JSON.stringify(raw)).toBe(false);
    }
  });

  it("rejects invalid agent names and traversal", () => {
    for (const agent of ["../kimi", "a/b", "Kimi", "", ".", "..", "a b", "kim_i"]) {
      const result = parseSettingsIntent({ surface: "agent", agent, family: "model", block: { id: "x/y" } });
      expect(result.ok, agent).toBe(false);
    }
  });
});

describe("parseSettingsIntent: write-only secrets", () => {
  it("accepts a structural bot token but never echoes it in errors", () => {
    const ok = parseSettingsIntent({
      surface: "local",
      family: "telegram",
      block: { botToken: HOSTILE_TOKEN, allowedChatIds: [42] },
    });
    expect(ok.ok).toBe(true);

    // A block that fails validation for ANOTHER reason must not leak the token.
    const bad = parseSettingsIntent({
      surface: "local",
      family: "telegram",
      block: { botToken: HOSTILE_TOKEN, allowedChatIds: "nope" },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).not.toContain("123456");
      expect(bad.error).not.toContain("ABC-secret");
    }
  });

  it("rejects empty/blank and non-string tokens without echoing them", () => {
    for (const botToken of ["", "   ", 42, null]) {
      const result = parseSettingsIntent({
        surface: "local",
        family: "discord",
        block: { botToken },
      });
      expect(result.ok).toBe(false);
    }
  });

  it("validates fallback declarations through the delivered model-fallback rules", () => {
    expect(
      parseSettingsIntent({
        surface: "agent",
        agent: "kimi",
        family: "model-fallback",
        block: { models: ["openrouter/kimi-k3", "opencode-go/kimi-k3"], autoSwitch: false },
      }).ok,
    ).toBe(true);
    // Duplicates / too many / malformed ids fail via the delivered parser.
    expect(
      parseSettingsIntent({
        surface: "agent",
        agent: "kimi",
        family: "model-fallback",
        block: { models: ["a/b", "a/b"] },
      }).ok,
    ).toBe(false);
    expect(
      parseSettingsIntent({
        surface: "agent",
        agent: "kimi",
        family: "model-fallback",
        block: { models: ["not-a-model-id!"] },
      }).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Redacted read/projection helpers
// ---------------------------------------------------------------------------

import {
  readLocalConfigRedacted,
  readAgentConfigRedacted,
  type SettingsFoundationIo,
} from "../src/settings-foundation.js";

function fakeFs(files: Map<string, string>): { io: SettingsFoundationIo; calls: string[] } {
  const calls: string[] = [];
  const io: SettingsFoundationIo = {
    async readFile(path: string): Promise<string> {
      calls.push(`read:${path}`);
      const content = files.get(path);
      if (content === undefined) {
        const error = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return content;
    },
    async writeFile(path: string): Promise<void> {
      calls.push(`write:${path}`);
      throw new Error("read-only fake: writes must not happen");
    },
    async fsync(path: string): Promise<void> {
      calls.push(`fsync:${path}`);
      throw new Error("read-only fake");
    },
    async rename(from: string, to: string): Promise<void> {
      calls.push(`rename:${from}->${to}`);
      throw new Error("read-only fake");
    },
    async unlink(path: string): Promise<void> {
      calls.push(`unlink:${path}`);
      throw new Error("read-only fake");
    },
  };
  return { io, calls };
}

const LOCAL_DOC = [
  "vault_root: /srv/vault",
  "allowed_agents:",
  "  - kimi",
  "telegram:",
  "  bot_token: \"123456:ABC-secret-token_xyz\"",
  "  allowed_chat_ids:",
  "    - 42",
  "    - -100",
  "  default_agent: kimi",
  "  feedback:",
  "    enabled: false",
  "discord:",
  "  bot_token: \"discord-secret-token\"",
  "  allowed_guild_ids:",
  "    - \"111\"",
  "scheduler:",
  "  enabled: true",
  "  automation:",
  "    inbox_tasks: true",
  "    agent_cron: false",
  "    script_cron: true",
  "  device_id: thor",
  "gateway-token: shhh",
  "unknown_future_block:",
  "  nested: value",
  "",
].join("\n");

describe("readLocalConfigRedacted", () => {
  it("projects only bounded non-secret family state", async () => {
    const { io } = fakeFs(new Map([["/cfg/config.yml", LOCAL_DOC]]));
    const projection = await readLocalConfigRedacted(io, "/cfg/config.yml");

    expect(projection.available).toBe(true);
    expect(projection.telegram).toEqual({
      configured: true,
      allowedChatIds: 2,
      defaultAgent: "kimi",
      feedbackEnabled: false,
    });
    expect(projection.discord).toEqual({
      configured: true,
      allowedGuildIds: 1,
      allowedChannelIds: 0,
      allowedThreadIds: null,
      allowedDmUserIds: null,
      defaultAgent: null,
      feedbackEnabled: null,
    });
    expect(projection.scheduler).toMatchObject({
      present: true,
      legacyMasterGate: "ignored",
      automation: { inboxTasks: true, agentCron: false, scriptCron: true },
      deviceIdConfigured: true,
    });
  });

  it("never leaks secrets, raw YAML, or unknown fields anywhere in the projection", async () => {
    const { io } = fakeFs(new Map([["/cfg/config.yml", LOCAL_DOC]]));
    const serialized = JSON.stringify(await readLocalConfigRedacted(io, "/cfg/config.yml"));

    for (const forbidden of ["123456", "ABC-secret", "discord-secret-token", "shhh", "bot_token", "gateway-token", "unknown_future_block", "nested", "vault_root", "/srv/vault"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("marks unconfigured families explicitly without inventing state", async () => {
    const { io } = fakeFs(new Map([["/cfg/config.yml", "vault_root: /v\n"]]));
    const projection = await readLocalConfigRedacted(io, "/cfg/config.yml");

    expect(projection.available).toBe(true);
    expect(projection.telegram?.configured).toBe(false);
    expect(projection.discord?.configured).toBe(false);
    expect(projection.scheduler?.present).toBe(false);
    expect(projection.scheduler?.legacyMasterGate).toBe("absent");
  });

  it("fails closed with a bounded reason for a missing config (no directory creation)", async () => {
    const { io, calls } = fakeFs(new Map());
    const projection = await readLocalConfigRedacted(io, "/cfg/config.yml");

    expect(projection.available).toBe(false);
    expect(projection.reason).toMatch(/not present|missing/i);
    expect(projection.reason).not.toContain("/cfg");
    // Read-only: zero write/fsync/rename/unlink calls, zero mkdir side effects.
    expect(calls.filter((c) => !c.startsWith("read:"))).toEqual([]);
  });

  it("fails closed with a bounded reason for malformed config (no content echo)", async () => {
    const { io } = fakeFs(new Map([["/cfg/config.yml", "scheduler: [unclosed\n  : : :"]]));
    const projection = await readLocalConfigRedacted(io, "/cfg/config.yml");

    expect(projection.available).toBe(false);
    expect(projection.reason).toMatch(/parse|malformed/i);
    expect(projection.reason).not.toContain("unclosed");
  });

  it("fails closed when a declared local inventory block is not a mapping", async () => {
    const projection = await readLocalConfigRedacted(
      fakeFs(new Map([["/cfg/config.yml", "telegram: malformed-block\n"]])).io,
      "/cfg/config.yml",
    );
    expect(projection.available).toBe(false);
    expect(projection.reason).toMatch(/malformed/i);
  });

  it("propagates non-ENOENT read failures as bounded read-failed errors", async () => {
    const io: SettingsFoundationIo = {
      async readFile() {
        const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      },
      writeFile: async () => {},
      fsync: async () => {},
      rename: async () => {},
      unlink: async () => {},
    };
    await expect(readLocalConfigRedacted(io, "/cfg")).rejects.toMatchObject({ code: "read-failed" });
  });
});

describe("readAgentConfigRedacted", () => {
  const AGENT_DOC = [
    "model:",
    "  id: anthropic/claude-sonnet-4-6",
    "  thinking: high",
    "  fallback:",
    "    auto_switch: true",
    "    models:",
    "      - openrouter/kimi-k3",
    "      - opencode-go/kimi-k3",
    "context_injection:",
    "  mode: session_start_only",
    "self_improvement:",
    "  auto_nudge: true",
    "  review_loop:",
    "    enabled: true",
    "    interval_turns: 10",
    "polling:",
    "  interval_seconds: 60",
    "",
  ].join("\n");

  it("projects bounded agent preference state (no raw config, no unknown keys)", async () => {
    const vault = "/vault";
    const { io, calls } = fakeFs(new Map([["/vault/team/kimi/config.yml", AGENT_DOC]]));
    const projection = await readAgentConfigRedacted(io, vault, "kimi");

    expect(calls).toEqual(["read:/vault/team/kimi/config.yml"]);
    expect(projection.available).toBe(true);
    expect(projection.model).toEqual({ id: "anthropic/claude-sonnet-4-6", thinking: "high" });
    expect(projection.modelFallback).toEqual({
      declared: true,
      autoSwitch: true,
      modelCount: 2,
      models: ["openrouter/kimi-k3", "opencode-go/kimi-k3"],
    });
    expect(projection.contextInjection).toEqual({ mode: "session_start_only" });
    expect(projection.selfImprovement).toMatchObject({ autoNudge: true, reviewLoopEnabled: true });
    // Unknown agent-config keys (polling) never appear.
    expect(JSON.stringify(projection)).not.toContain("polling");
    expect(JSON.stringify(projection)).not.toContain("interval_seconds");
  });

  it("exposes only the editable fallback declaration (models list) while hiding raw config and unknown keys", async () => {
    const { io } = fakeFs(new Map([["/vault/team/kimi/config.yml", AGENT_DOC]]));
    const serialized = JSON.stringify(await readAgentConfigRedacted(io, "/vault", "kimi"));
    // The W6 contract permits the fallback-model list ONLY because it is the
    // explicitly editable model.fallback declaration itself.
    expect(serialized).toContain("openrouter/kimi-k3");
    expect(serialized).toContain("opencode-go/kimi-k3");
    // No other raw config or unknown key leaks.
    expect(serialized).not.toContain("polling");
    expect(serialized).not.toContain("interval_seconds");
    expect(serialized).not.toContain("review_loop");
  });

  it("fails closed for missing and malformed agent configs", async () => {
    const missing = await readAgentConfigRedacted(fakeFs(new Map()).io, "/vault", "kimi");
    expect(missing.available).toBe(false);
    expect(missing.reason).toMatch(/not present|missing/i);

    const malformed = await readAgentConfigRedacted(
      fakeFs(new Map([["/vault/team/kimi/config.yml", "model: [unclosed\n: : :"]])).io,
      "/vault",
      "kimi",
    );
    expect(malformed.available).toBe(false);
    expect(malformed.reason).toMatch(/parse|malformed/i);
  });

  it("fails closed when a declared agent inventory block is not a mapping", async () => {
    const projection = await readAgentConfigRedacted(
      fakeFs(new Map([["/vault/team/kimi/config.yml", "model: malformed-block\n"]])).io,
      "/vault",
      "kimi",
    );
    expect(projection.available).toBe(false);
    expect(projection.reason).toMatch(/malformed/i);
  });

  it("rejects invalid agent names before any read", async () => {
    const { io, calls } = fakeFs(new Map());
    await expect(readAgentConfigRedacted(io, "/vault", "../kimi")).rejects.toMatchObject({ code: "invalid-agent" });
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Atomic write primitive
// ---------------------------------------------------------------------------

import { writeFileAtomicChecked } from "../src/settings-foundation.js";

interface StatefulFakeFs {
  io: SettingsFoundationIo;
  files: Map<string, string>;
  modes: Map<string, number>;
  calls: string[];
  fail: { write?: boolean; fsync?: boolean; rename?: boolean; unlink?: boolean };
}

function statefulFs(initial: Map<string, string> = new Map()): StatefulFakeFs {
  const files = new Map(initial);
  const modes = new Map<string, number>();
  const calls: string[] = [];
  const fail: StatefulFakeFs["fail"] = {};
  const io: SettingsFoundationIo = {
    async readFile(path: string): Promise<string> {
      calls.push(`read:${path}`);
      const content = files.get(path);
      if (content === undefined) {
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return content;
    },
    async writeFile(path: string, content: string, mode: number): Promise<void> {
      calls.push(`write:${path}`);
      if (fail.write) throw new Error("injected write failure");
      files.set(path, content);
      modes.set(path, mode);
    },
    async fsync(path: string): Promise<void> {
      calls.push(`fsync:${path}`);
      if (fail.fsync) throw new Error("injected fsync failure");
    },
    async rename(from: string, to: string): Promise<void> {
      calls.push(`rename:${from}->${to}`);
      if (fail.rename) throw new Error("injected rename failure");
      const content = files.get(from);
      if (content === undefined) throw new Error("rename source missing");
      files.delete(from);
      files.set(to, content);
    },
    async unlink(path: string): Promise<void> {
      calls.push(`unlink:${path}`);
      if (fail.unlink) throw new Error("injected unlink failure");
      files.delete(path);
    },
  };
  return { io, files, modes, calls, fail };
}

describe("writeFileAtomicChecked", () => {
  const NOW = () => 1700000000000;

  it("writes new content through temp+fsync+rename with owner-only mode", async () => {
    const fs = statefulFs(new Map([["/cfg/config.yml", "old: true\n"]]));

    await writeFileAtomicChecked(fs.io, "/cfg/config.yml", "new: true\n", { expectedSource: "old: true\n", nowMs: NOW });

    expect(fs.files.get("/cfg/config.yml")).toBe("new: true\n");
    // Temp file landed with 0600 and was renamed away (no residue).
    const tempPaths = [...fs.files.keys()].filter((p) => p.includes(".tmp-"));
    expect(tempPaths).toEqual([]);
    expect(fs.modes.get("/cfg/config.yml.tmp-" + process.pid + "-1700000000000")).toBe(0o600);
    const writeCall = fs.calls.find((c) => c.startsWith("write:"));
    expect(writeCall).toContain(".tmp-");
    const order = fs.calls.filter((c) => c.startsWith("write:") || c.startsWith("fsync:") || c.startsWith("rename:"));
    expect(order.map((c) => c.split(":")[0])).toEqual(["write", "fsync", "rename"]);
  });

  it("refuses to clobber when the source bytes changed since the mutation started (revision race)", async () => {
    const fs = statefulFs(new Map([["/cfg/config.yml", "CONCURRENTLY CHANGED\n"]]));

    await expect(
      writeFileAtomicChecked(fs.io, "/cfg/config.yml", "new: true\n", { expectedSource: "old: true\n", nowMs: NOW }),
    ).rejects.toMatchObject({ code: "revision-changed" });

    expect(fs.files.get("/cfg/config.yml")).toBe("CONCURRENTLY CHANGED\n");
    expect(fs.calls.filter((c) => c.startsWith("write:"))).toEqual([]);
  });

  it("refuses when a new file appears where none was expected", async () => {
    const fs = statefulFs(new Map([["/cfg/config.yml", "surprise\n"]]));

    await expect(
      writeFileAtomicChecked(fs.io, "/cfg/config.yml", "new: true\n", { expectedSource: null, nowMs: NOW }),
    ).rejects.toMatchObject({ code: "revision-changed" });
    expect(fs.files.get("/cfg/config.yml")).toBe("surprise\n");
  });

  it("refuses when the expected file disappeared", async () => {
    const fs = statefulFs(new Map());

    await expect(
      writeFileAtomicChecked(fs.io, "/cfg/config.yml", "new: true\n", { expectedSource: "old: true\n", nowMs: NOW }),
    ).rejects.toMatchObject({ code: "revision-changed" });
  });

  it("write failure: original bytes intact, temp cleaned up, bounded error", async () => {
    const fs = statefulFs(new Map([["/cfg/config.yml", "old: true\n"]]));
    fs.fail.write = true;

    await expect(
      writeFileAtomicChecked(fs.io, "/cfg/config.yml", "new: true\n", { expectedSource: "old: true\n", nowMs: NOW }),
    ).rejects.toMatchObject({ code: "write-failed" });

    expect(fs.files.get("/cfg/config.yml")).toBe("old: true\n");
    expect([...fs.files.keys()].filter((p) => p.includes(".tmp-"))).toEqual([]);
    expect(fs.calls.some((c) => c.startsWith("unlink:"))).toBe(true);
  });

  it("fsync failure: original bytes intact, temp cleaned up", async () => {
    const fs = statefulFs(new Map([["/cfg/config.yml", "old: true\n"]]));
    fs.fail.fsync = true;

    await expect(
      writeFileAtomicChecked(fs.io, "/cfg/config.yml", "new: true\n", { expectedSource: "old: true\n", nowMs: NOW }),
    ).rejects.toMatchObject({ code: "write-failed" });

    expect(fs.files.get("/cfg/config.yml")).toBe("old: true\n");
    expect([...fs.files.keys()].filter((p) => p.includes(".tmp-"))).toEqual([]);
    expect(fs.calls.some((c) => c.startsWith("unlink:"))).toBe(true);
  });

  it("rename failure: original bytes intact, temp cleaned up", async () => {
    const fs = statefulFs(new Map([["/cfg/config.yml", "old: true\n"]]));
    fs.fail.rename = true;

    await expect(
      writeFileAtomicChecked(fs.io, "/cfg/config.yml", "new: true\n", { expectedSource: "old: true\n", nowMs: NOW }),
    ).rejects.toMatchObject({ code: "write-failed" });

    expect(fs.files.get("/cfg/config.yml")).toBe("old: true\n");
    expect([...fs.files.keys()].filter((p) => p.includes(".tmp-"))).toEqual([]);
  });

  it("cleanup failure never masks the original write error", async () => {
    const fs = statefulFs(new Map([["/cfg/config.yml", "old: true\n"]]));
    fs.fail.rename = true;
    fs.fail.unlink = true;

    await expect(
      writeFileAtomicChecked(fs.io, "/cfg/config.yml", "new: true\n", { expectedSource: "old: true\n", nowMs: NOW }),
    ).rejects.toMatchObject({ code: "write-failed", message: expect.not.stringContaining("unlink") });
  });

  it("errors are bounded and never echo content", async () => {
    const fs = statefulFs(new Map([["/cfg/config.yml", "old: true\n"]]));
    fs.fail.write = true;
    const SECRETISH = "bot_token: 999:supersecret";

    const error = await writeFileAtomicChecked(fs.io, "/cfg/config.yml", SECRETISH, {
      expectedSource: "old: true\n",
      nowMs: NOW,
    }).catch((e: unknown) => e);
    expect(JSON.stringify(error)).not.toContain("supersecret");
  });
});

describe("createNodeSettingsFoundationIo (real temp fs)", () => {
  it("round-trips an atomic write on a real filesystem", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "piren-settings-foundation-"));
    try {
      const { createNodeSettingsFoundationIo } = await import("../src/settings-foundation.js");
      const io = createNodeSettingsFoundationIo();
      const path = join(root, "config.yml");
      await writeFileAtomicChecked(io, path, "a: 1\n", { expectedSource: null });
      expect(await io.readFile(path)).toBe("a: 1\n");
      await writeFileAtomicChecked(io, path, "a: 2\n", { expectedSource: "a: 1\n" });
      expect(await io.readFile(path)).toBe("a: 2\n");
      const { readdir } = await import("node:fs/promises");
      expect((await readdir(root)).filter((f) => f.includes(".tmp-"))).toEqual([]);
      if (process.platform !== "win32") {
        const { stat } = await import("node:fs/promises");
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Mutation adapters (local + agent)
// ---------------------------------------------------------------------------

import { applyLocalSettingsIntent, applyAgentSettingsIntent } from "../src/settings-foundation.js";

const LOCAL_BASE = [
  "vault_root: /srv/vault",
  "allowed_agents:",
  "  - kimi",
  "telegram:",
  "  bot_token: \"123456:ABC-secret-token_xyz\"",
  "  allowed_chat_ids:",
  "    - 42",
  "  feedback:",
  "    enabled: true",
  "    reaction_on_receive: \"👀\"",
  "  custom_future_field: keep",
  "unknown_top_level:",
  "  nested: preserve",
  "",
].join("\n");

describe("applyLocalSettingsIntent", () => {
  const NOW = () => 1700000000000;

  it("merges a telegram patch preserving unprompted fields, unknown keys, and the existing token", async () => {
    const fs = statefulFs(new Map([["/cfg/config.yml", LOCAL_BASE]]));
    const result = await applyLocalSettingsIntent(fs.io, "/cfg/config.yml", {
      surface: "local",
      family: "telegram",
      block: { allowedChatIds: [42, -100], defaultAgent: "kimi" },
    }, { nowMs: NOW });

    expect(result).toEqual({ wrote: true, surface: "local", family: "telegram" });
    const written = parseYaml(fs.files.get("/cfg/config.yml")!) as Record<string, any>;
    expect(written.telegram.allowed_chat_ids).toEqual([42, -100]);
    expect(written.telegram.default_agent).toBe("kimi");
    expect(written.telegram.bot_token).toBe("123456:ABC-secret-token_xyz");
    expect(written.telegram.feedback).toEqual({ enabled: true, reaction_on_receive: "👀" });
    expect(written.telegram.custom_future_field).toBe("keep");
    expect(written.unknown_top_level).toEqual({ nested: "preserve" });
    expect(written.vault_root).toBe("/srv/vault");
  });

  it("a supplied write-only bot token lands in the document but never in the result or errors", async () => {
    const fs = statefulFs(new Map([["/cfg/config.yml", LOCAL_BASE]]));
    const result = await applyLocalSettingsIntent(fs.io, "/cfg/config.yml", {
      surface: "local",
      family: "telegram",
      block: { botToken: "999:brand-new-secret" },
    }, { nowMs: NOW });

    const written = parseYaml(fs.files.get("/cfg/config.yml")!) as Record<string, any>;
    expect(written.telegram.bot_token).toBe("999:brand-new-secret");
    expect(JSON.stringify(result)).not.toContain("brand-new-secret");
    expect(JSON.stringify(result)).not.toContain("bot_token");
  });

  it("a write failure with a supplied secret never leaks it in the error", async () => {
    const fs = statefulFs(new Map([["/cfg/config.yml", LOCAL_BASE]]));
    fs.fail.rename = true;
    const error = await applyLocalSettingsIntent(fs.io, "/cfg/config.yml", {
      surface: "local",
      family: "discord",
      block: { botToken: "discord-new-secret", allowedGuildIds: ["111"] },
    }, { nowMs: NOW }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "write-failed" });
    expect(JSON.stringify(error)).not.toContain("discord-new-secret");
    // Original bytes intact.
    expect(fs.files.get("/cfg/config.yml")).toBe(LOCAL_BASE);
  });

  it("merges a scheduler patch per-key, clears device_id on null, and preserves unknown scheduler keys", async () => {
    const existing = [
      "scheduler:",
      "  enabled: false",
      "  device_id: thor",
      "  future_key: keep",
      "  automation:",
      "    inbox_tasks: false",
      "    agent_cron: false",
      "    script_cron: false",
      "",
    ].join("\n");
    const fs = statefulFs(new Map([["/cfg/config.yml", existing]]));

    await applyLocalSettingsIntent(fs.io, "/cfg/config.yml", {
      surface: "local",
      family: "scheduler",
      block: { automation: { inbox_tasks: true }, deviceId: null, pollIntervalSeconds: 45 },
    }, { nowMs: NOW });

    const written = parseYaml(fs.files.get("/cfg/config.yml")!) as Record<string, any>;
    // The retired master key is never written, rewritten, or removed by Settings.
    expect(written.scheduler).toEqual({
      enabled: false,
      future_key: "keep",
      poll_interval_seconds: 45,
      automation: { inbox_tasks: true, agent_cron: false, script_cron: false },
    });
    expect(fs.files.get("/cfg/config.yml")).not.toContain("device_id");
  });

  it("refuses to clobber a concurrently changed config (original bytes intact)", async () => {
    const fs = statefulFs(new Map([["/cfg/config.yml", LOCAL_BASE]]));
    // Simulate a concurrent edit between the adapter's initial read and its
    // revision check by mutating the map inside a wrapped readFile.
    let reads = 0;
    const racingIo: SettingsFoundationIo = {
      ...fs.io,
      async readFile(path: string) {
        reads += 1;
        if (reads === 2) fs.files.set(path, "concurrent: edit\n");
        return fs.io.readFile(path);
      },
    };

    await expect(
      applyLocalSettingsIntent(racingIo, "/cfg/config.yml", {
        surface: "local",
        family: "scheduler",
        block: { automation: { inbox_tasks: true } },
      }, { nowMs: NOW }),
    ).rejects.toMatchObject({ code: "revision-changed" });
    expect(fs.files.get("/cfg/config.yml")).toBe("concurrent: edit\n");
  });

  it("fails closed on malformed existing config without writing", async () => {
    const fs = statefulFs(new Map([["/cfg/config.yml", "telegram: [unclosed\n: : :"]]));
    await expect(
      applyLocalSettingsIntent(fs.io, "/cfg/config.yml", {
        surface: "local",
        family: "telegram",
        block: { allowedChatIds: [1] },
      }, { nowMs: NOW }),
    ).rejects.toMatchObject({ code: "malformed-config" });
    expect(fs.files.get("/cfg/config.yml")).toBe("telegram: [unclosed\n: : :");
  });

  it("refuses a malformed target family block rather than replacing it", async () => {
    const original = "telegram: not-a-mapping\nunknown: preserve\n";
    const fs = statefulFs(new Map([["/cfg/config.yml", original]]));

    await expect(
      applyLocalSettingsIntent(fs.io, "/cfg/config.yml", {
        surface: "local",
        family: "telegram",
        block: { allowedChatIds: [1] },
      }, { nowMs: NOW }),
    ).rejects.toMatchObject({ code: "malformed-config" });
    expect(fs.files.get("/cfg/config.yml")).toBe(original);
  });

  it("creates a new config when none exists and NEVER writes a retired master gate (ST-1A)", async () => {
    const fs = statefulFs(new Map());
    await applyLocalSettingsIntent(fs.io, "/cfg/config.yml", {
      surface: "local",
      family: "scheduler",
      block: { automation: { inbox_tasks: true } },
    }, { nowMs: NOW });
    const written = parseYaml(fs.files.get("/cfg/config.yml")!) as Record<string, any>;
    expect(written.scheduler.automation.inbox_tasks).toBe(true);
    expect(written.scheduler).not.toHaveProperty("enabled");
  });
});

describe("applyAgentSettingsIntent", () => {
  const NOW = () => 1700000000000;
  const AGENT_BASE = [
    "model:",
    "  id: anthropic/claude-sonnet-4-6",
    "  thinking: medium",
    "  fallback:",
    "    auto_switch: true",
    "    models:",
    "      - openrouter/kimi-k3",
    "context_injection:",
    "  mode: per_turn",
    "polling:",
    "  interval_seconds: 60",
    "",
  ].join("\n");

  function agentFs(doc: string = AGENT_BASE): StatefulFakeFs {
    return statefulFs(new Map([["/vault/team/kimi/config.yml", doc]]));
  }

  it("merges a model patch preserving fallback, models list, and unknown keys", async () => {
    const fs = agentFs();
    const result = await applyAgentSettingsIntent(fs.io, "/vault", {
      surface: "agent",
      agent: "kimi",
      family: "model",
      block: { thinking: "high" },
    }, { nowMs: NOW });

    expect(result).toEqual({ wrote: true, surface: "agent", family: "model" });
    const written = parseYaml(fs.files.get("/vault/team/kimi/config.yml")!) as Record<string, any>;
    expect(written.model.thinking).toBe("high");
    expect(written.model.id).toBe("anthropic/claude-sonnet-4-6");
    expect(written.model.fallback.models).toEqual(["openrouter/kimi-k3"]);
    expect(written.polling).toEqual({ interval_seconds: 60 });
  });

  it("merges a model-fallback patch per-key", async () => {
    const fs = agentFs();
    await applyAgentSettingsIntent(fs.io, "/vault", {
      surface: "agent",
      agent: "kimi",
      family: "model-fallback",
      block: { models: ["opencode-go/kimi-k3", "openrouter/kimi-k3"], autoSwitch: false },
    }, { nowMs: NOW });

    const written = parseYaml(fs.files.get("/vault/team/kimi/config.yml")!) as Record<string, any>;
    expect(written.model.fallback).toEqual({ auto_switch: false, models: ["opencode-go/kimi-k3", "openrouter/kimi-k3"] });
    expect(written.model.id).toBe("anthropic/claude-sonnet-4-6");
  });

  it("sets context-injection mode preserving sibling keys", async () => {
    const fs = agentFs();
    await applyAgentSettingsIntent(fs.io, "/vault", {
      surface: "agent",
      agent: "kimi",
      family: "context-injection",
      mode: "session_start_only",
    }, { nowMs: NOW });
    const written = parseYaml(fs.files.get("/vault/team/kimi/config.yml")!) as Record<string, any>;
    expect(written.context_injection.mode).toBe("session_start_only");
  });

  it("merges a self-improvement patch with snake_case mapping incl. nested review_loop", async () => {
    const fs = agentFs();
    await applyAgentSettingsIntent(fs.io, "/vault", {
      surface: "agent",
      agent: "kimi",
      family: "self-improvement",
      block: { autoNudge: true, reviewLoopEnabled: true, reviewLoopIntervalTurns: 12 },
    }, { nowMs: NOW });
    const written = parseYaml(fs.files.get("/vault/team/kimi/config.yml")!) as Record<string, any>;
    expect(written.self_improvement).toEqual({
      auto_nudge: true,
      review_loop: { enabled: true, interval_turns: 12 },
    });
  });

  it("rejects invalid agent names before any read (no traversal)", async () => {
    const fs = agentFs();
    for (const agent of ["../kimi", "a/b", "..", "Kimi"]) {
      await expect(
        applyAgentSettingsIntent(fs.io, "/vault", { surface: "agent", agent, family: "model", block: { id: "x/y" } }, { nowMs: NOW }),
      ).rejects.toMatchObject({ code: "invalid-agent" });
    }
    expect(fs.calls.filter((c) => c.startsWith("read:"))).toEqual([]);
  });

  it("fails closed when the agent config is missing (strict raw contract, no creation)", async () => {
    const fs = statefulFs(new Map());
    await expect(
      applyAgentSettingsIntent(fs.io, "/vault", {
        surface: "agent",
        agent: "kimi",
        family: "model",
        block: { id: "x/y" },
      }, { nowMs: NOW }),
    ).rejects.toMatchObject({ code: "not-found" });
    expect(fs.calls.filter((c) => c.startsWith("write:"))).toEqual([]);
  });

  it("fails closed on malformed agent config without writing", async () => {
    const fs = agentFs("model: [unclosed\n: : :");
    await expect(
      applyAgentSettingsIntent(fs.io, "/vault", {
        surface: "agent",
        agent: "kimi",
        family: "model",
        block: { id: "x/y" },
      }, { nowMs: NOW }),
    ).rejects.toMatchObject({ code: "malformed-config" });
    expect(fs.files.get("/vault/team/kimi/config.yml")).toBe("model: [unclosed\n: : :");
  });

  it("revalidates the merged fallback declaration rather than writing an invalid preserved list", async () => {
    const original = [
      "model:",
      "  fallback:",
      "    auto_switch: true",
      "    models:",
      "      - not-a-valid-model-id!",
      "unknown: preserve",
      "",
    ].join("\n");
    const fs = agentFs(original);

    await expect(
      applyAgentSettingsIntent(fs.io, "/vault", {
        surface: "agent",
        agent: "kimi",
        family: "model-fallback",
        block: { autoSwitch: false },
      }, { nowMs: NOW }),
    ).rejects.toMatchObject({ code: "malformed-config" });
    expect(fs.files.get("/vault/team/kimi/config.yml")).toBe(original);
  });

  it("refuses a malformed model block rather than replacing it", async () => {
    const original = "model: not-a-mapping\nunknown: preserve\n";
    const fs = agentFs(original);

    await expect(
      applyAgentSettingsIntent(fs.io, "/vault", {
        surface: "agent",
        agent: "kimi",
        family: "model",
        block: { thinking: "high" },
      }, { nowMs: NOW }),
    ).rejects.toMatchObject({ code: "malformed-config" });
    expect(fs.files.get("/vault/team/kimi/config.yml")).toBe(original);
  });

  it("refuses to clobber a concurrently changed agent config", async () => {
    const fs = agentFs();
    fs.files.set("/vault/team/kimi/config.yml", AGENT_BASE);
    const racingIo: SettingsFoundationIo = {
      ...fs.io,
      async readFile(path: string) {
        const priorReads = fs.calls.filter((c) => c === `read:${path}`).length;
        if (priorReads === 1) fs.files.set(path, "concurrent: edit\n");
        return fs.io.readFile(path);
      },
    };
    await expect(
      applyAgentSettingsIntent(racingIo, "/vault", {
        surface: "agent",
        agent: "kimi",
        family: "model",
        block: { thinking: "high" },
      }, { nowMs: NOW }),
    ).rejects.toMatchObject({ code: "revision-changed" });
  });
});

// ---------------------------------------------------------------------------
// ST-1A: the retired scheduler master gate leaves the Settings data contract
// ---------------------------------------------------------------------------

describe("ST-1A: retired scheduler master gate (closed Settings contract)", () => {
  const NOW = () => 1700000000000;
  it("rejects an enabled key in the scheduler Settings intent as unknown (closed inventory)", () => {
    for (const block of [{ enabled: true }, { enabled: false }, { enabled: null }]) {
      const result = parseSettingsIntent({ surface: "local", family: "scheduler", block });
      expect(result.ok, JSON.stringify(block)).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/[Uu]nknown field/);
    }
    // Other closed scheduler fields keep parsing.
    expect(
      parseSettingsIntent({ surface: "local", family: "scheduler", block: { automation: { inbox_tasks: true } } }).ok,
    ).toBe(true);
  });

  it("the redacted scheduler projection exposes legacyMasterGate states and never an enabled boolean", async () => {
    const { readLocalConfigRedacted } = await import("../src/settings-foundation.js");
    const cases: Array<[string, string]> = [
      ["vault_root: /v\n", "absent"],
      ["vault_root: /v\nscheduler:\n  automation:\n    inbox_tasks: true\n", "absent"],
      ["vault_root: /v\nscheduler:\n  enabled: true\n", "ignored"],
      ["vault_root: /v\nscheduler:\n  enabled: false\n", "gated"],
      ["vault_root: /v\nscheduler:\n  enabled: \"junk\"\n", "gated"],
      ["vault_root: /v\nscheduler:\n  enabled:\n", "gated"],
    ];
    for (const [configText, expected] of cases) {
      const { io } = fakeFs(new Map([["/cfg/config.yml", configText]]));
      const projection = await readLocalConfigRedacted(io, "/cfg/config.yml");
      expect(projection.available).toBe(true);
      expect(projection.scheduler?.legacyMasterGate, configText).toBe(expected);
      // The projection never carries a raw enabled boolean or raw value.
      expect(projection.scheduler).not.toHaveProperty("enabled");
    }
  });

  it("a confirmed Settings save never removes or rewrites a stale retired key (no silent cleanup)", async () => {
    const original = [
      "vault_root: /v",
      "scheduler:",
      "  enabled: true",
      "  automation:",
      "    inbox_tasks: false",
      "",
    ].join("\n");
    const fs = statefulFs(new Map([["/cfg/config.yml", original]]));
    await applyLocalSettingsIntent(fs.io, "/cfg/config.yml", {
      surface: "local",
      family: "scheduler",
      block: { automation: { inbox_tasks: true } },
    }, { nowMs: NOW });
    const written = parseYaml(fs.files.get("/cfg/config.yml")!) as Record<string, any>;
    // The stale retired key survives untouched; configure owns its removal.
    expect(written.scheduler.enabled).toBe(true);
    expect(written.scheduler.automation.inbox_tasks).toBe(true);
  });
});
