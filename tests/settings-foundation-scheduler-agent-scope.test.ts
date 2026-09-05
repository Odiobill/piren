import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  applyLocalSettingsIntent,
  parseSettingsIntent,
  readLocalConfigRedacted,
  type SettingsFoundationIo,
} from "../src/settings-foundation.js";

/**
 * 0.2.5 S7 — typed Scheduler class agent-scope Settings controls (foundation
 * slice). The closed scheduler Settings inventory gains `agentScope`: per
 * automation class, either an exact canonical runnable-name array (replace
 * the recognized `allow`, clear the recognized `exclude`) or explicit null
 * (clear the recognized `allow`/`exclude`). The foundation stays
 * syntax/shape strict: duplicate and non-runnable names are gateway
 * rejections, never parse concerns. The projection carries the raw declared
 * `agent_scope` container for the server-side `resolveSchedulerAgentScope`
 * resolver; it never reaches the browser.
 */

function statefulFs(initial: Record<string, string> = {}): { io: SettingsFoundationIo; files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(initial));
  const io: SettingsFoundationIo = {
    async readFile(path) {
      const content = files.get(path);
      if (content === undefined) {
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return content;
    },
    async writeFile(path, content) {
      files.set(path, content);
    },
    async fsync() {},
    async rename(from, to) {
      const content = files.get(from);
      if (content === undefined) throw new Error("rename source missing");
      files.delete(from);
      files.set(to, content);
    },
    async unlink(path) {
      files.delete(path);
    },
  };
  return { io, files };
}

const NOW = () => 1700000000000;

describe("parseSettingsIntent: scheduler agentScope (closed inventory)", () => {
  it("accepts per-class canonical arrays, empty arrays, and explicit nulls", () => {
    const result = parseSettingsIntent({
      surface: "local",
      family: "scheduler",
      block: { agentScope: { inbox_tasks: ["kimi", "dipu"], agent_cron: [], script_cron: null } },
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.intent.family === "scheduler") {
      expect(result.intent.block.agentScope).toEqual({
        inbox_tasks: ["kimi", "dipu"],
        agent_cron: [],
        script_cron: null,
      });
    }
  });

  it("an agentScope-only patch changes something (no other scheduler field required)", () => {
    const result = parseSettingsIntent({
      surface: "local",
      family: "scheduler",
      block: { agentScope: { inbox_tasks: ["kimi"] } },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects unknown class keys inside agentScope", () => {
    const result = parseSettingsIntent({
      surface: "local",
      family: "scheduler",
      block: { agentScope: { inbox_tasks: ["kimi"], ghost_class: ["x"] } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown/i);
  });

  it("rejects nested allow/exclude objects (the intent carries the resolved subset, not YAML shapes)", () => {
    const result = parseSettingsIntent({
      surface: "local",
      family: "scheduler",
      block: { agentScope: { inbox_tasks: { allow: ["kimi"] } } },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects malformed class values (scalars, arrays with non-string or blank entries)", () => {
    for (const value of ["kimi", 42, [42], [""], [null], [undefined]]) {
      const result = parseSettingsIntent({
        surface: "local",
        family: "scheduler",
        block: { agentScope: { inbox_tasks: value as unknown as string[] } },
      });
      expect(result.ok, JSON.stringify(value)).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/invalid/i);
    }
  });
});

describe("applyLocalSettingsIntent: scheduler agentScope writes", () => {
  const BASE = [
    "vault_root: /vault",
    "scheduler:",
    "  automation:",
    "    inbox_tasks: true",
    "  poll_interval_seconds: 15",
    "  agent_scope:",
    "    inbox_tasks:",
    "      allow:",
    "        - kimi",
    "      exclude:",
    "        - dipu",
    "    script_cron:",
    "      allow: []",
    "  custom_future_field: keep",
    "",
  ].join("\n");

  it("an array replaces the recognized allow and clears the recognized exclude", async () => {
    const fs = statefulFs({ "/cfg/config.yml": BASE });
    const result = await applyLocalSettingsIntent(fs.io, "/cfg/config.yml", {
      surface: "local",
      family: "scheduler",
      block: { agentScope: { inbox_tasks: ["dipu", "kimi"] } },
    }, { nowMs: NOW });
    expect(result).toEqual({ wrote: true, surface: "local", family: "scheduler" });
    const written = parseYaml(fs.files.get("/cfg/config.yml")!) as Record<string, any>;
    expect(written.scheduler.agent_scope.inbox_tasks).toEqual({ allow: ["dipu", "kimi"] });
    // Untouched classes and unrelated scheduler keys survive.
    expect(written.scheduler.agent_scope.script_cron).toEqual({ allow: [] });
    expect(written.scheduler.poll_interval_seconds).toBe(15);
    expect(written.scheduler.automation).toEqual({ inbox_tasks: true });
    expect(written.scheduler.custom_future_field).toBe("keep");
  });

  it("explicit null clears the recognized allow/exclude and prunes emptied records", async () => {
    const fs = statefulFs({ "/cfg/config.yml": BASE });
    await applyLocalSettingsIntent(fs.io, "/cfg/config.yml", {
      surface: "local",
      family: "scheduler",
      block: { agentScope: { inbox_tasks: null, script_cron: null } },
    }, { nowMs: NOW });
    const written = parseYaml(fs.files.get("/cfg/config.yml")!) as Record<string, any>;
    // The emptied agent_scope container is pruned entirely.
    expect(written.scheduler).not.toHaveProperty("agent_scope");
    expect(written.scheduler.poll_interval_seconds).toBe(15);
    expect(written.scheduler.automation).toEqual({ inbox_tasks: true });
  });

  it("unknown keys inside a touched class scope and sibling config survive", async () => {
    const seeded = [
      "scheduler:",
      "  agent_scope:",
      "    inbox_tasks:",
      "      allow:",
      "        - kimi",
      "      custom_future_key: preserve",
      "telegram:",
      "  allowed_chat_ids:",
      "    - 42",
      "",
    ].join("\n");
    const fs = statefulFs({ "/cfg/config.yml": seeded });
    await applyLocalSettingsIntent(fs.io, "/cfg/config.yml", {
      surface: "local",
      family: "scheduler",
      block: { agentScope: { inbox_tasks: ["kimi"] } },
    }, { nowMs: NOW });
    const written = parseYaml(fs.files.get("/cfg/config.yml")!) as Record<string, any>;
    expect(written.scheduler.agent_scope.inbox_tasks).toEqual({ allow: ["kimi"], custom_future_key: "preserve" });
    expect(written.telegram).toEqual({ allowed_chat_ids: [42] });
  });

  it("null keeps unknown keys inside the class record (structurally safe preservation)", async () => {
    const seeded = [
      "scheduler:",
      "  agent_scope:",
      "    inbox_tasks:",
      "      allow:",
      "        - kimi",
      "      custom_future_key: preserve",
      "",
    ].join("\n");
    const fs = statefulFs({ "/cfg/config.yml": seeded });
    await applyLocalSettingsIntent(fs.io, "/cfg/config.yml", {
      surface: "local",
      family: "scheduler",
      block: { agentScope: { inbox_tasks: null } },
    }, { nowMs: NOW });
    const written = parseYaml(fs.files.get("/cfg/config.yml")!) as Record<string, any>;
    expect(written.scheduler.agent_scope.inbox_tasks).toEqual({ custom_future_key: "preserve" });
  });

  it("untouched classes are byte-preserved in the written document", async () => {
    const fs = statefulFs({ "/cfg/config.yml": BASE });
    await applyLocalSettingsIntent(fs.io, "/cfg/config.yml", {
      surface: "local",
      family: "scheduler",
      block: { agentScope: { script_cron: ["kimi"] } },
    }, { nowMs: NOW });
    const written = parseYaml(fs.files.get("/cfg/config.yml")!) as Record<string, any>;
    expect(written.scheduler.agent_scope.inbox_tasks).toEqual({ allow: ["kimi"], exclude: ["dipu"] });
    expect(written.scheduler.agent_scope.script_cron).toEqual({ allow: ["kimi"] });
  });

  it("a changed agentScope never touches sibling config families", async () => {
    const fs = statefulFs({ "/cfg/config.yml": BASE });
    await applyLocalSettingsIntent(fs.io, "/cfg/config.yml", {
      surface: "local",
      family: "scheduler",
      block: { agentScope: { agent_cron: [] } },
    }, { nowMs: NOW });
    const written = parseYaml(fs.files.get("/cfg/config.yml")!) as Record<string, any>;
    expect(written.vault_root).toBe("/vault");
    expect(written.scheduler.agent_scope.agent_cron).toEqual({ allow: [] });
    expect(written.scheduler.agent_scope.inbox_tasks).toEqual({ allow: ["kimi"], exclude: ["dipu"] });
  });
});

describe("readLocalConfigRedacted: agent scope projection", () => {
  it("carries the raw declared agent_scope container for the server-side resolver", async () => {
    const seeded = [
      "scheduler:",
      "  agent_scope:",
      "    inbox_tasks:",
      "      allow:",
      "        - kimi",
      "      exclude:",
      "        - dipu",
      "",
    ].join("\n");
    const fs = statefulFs({ "/cfg/config.yml": seeded });
    const projection = await readLocalConfigRedacted(fs.io, "/cfg/config.yml");
    expect(projection.available).toBe(true);
    expect(projection.scheduler?.agentScopeRaw).toEqual({
      inbox_tasks: { allow: ["kimi"], exclude: ["dipu"] },
    });
  });

  it("agentScopeRaw is undefined when no agent_scope is declared", async () => {
    const fs = statefulFs({ "/cfg/config.yml": "scheduler:\n  poll_interval_seconds: 15\n" });
    const projection = await readLocalConfigRedacted(fs.io, "/cfg/config.yml");
    expect(projection.available).toBe(true);
    expect(projection.scheduler?.agentScopeRaw).toBeUndefined();
  });

  it("a scalar agent_scope does not fail the whole projection (the resolver fail-closes downstream)", async () => {
    const fs = statefulFs({ "/cfg/config.yml": "scheduler:\n  agent_scope: oops\n" });
    const projection = await readLocalConfigRedacted(fs.io, "/cfg/config.yml");
    expect(projection.available).toBe(true);
    expect(projection.scheduler?.agentScopeRaw).toBe("oops");
  });
});
