import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkAlertMirrorConfig, doctorPiren, type PiRuntimeCheck } from "../src/doctor.js";
import { initVault } from "../src/init.js";
import type { LocalPirenConfig } from "../src/bootstrap.js";

describe("checkAlertMirrorConfig", () => {
  it("returns null when no alert_mirror block is declared", () => {
    expect(checkAlertMirrorConfig({})).toBeNull();
    expect(checkAlertMirrorConfig({ telegram: { bot_token: "t" } })).toBeNull();
  });

  it("reports ok-disabled when the block is present but enabled is absent or false", () => {
    for (const config of [
      { alert_mirror: {} },
      { alert_mirror: { enabled: false } },
      { alert_mirror: { enabled: false, telegram: { chat_id: 1 } } },
    ] satisfies LocalPirenConfig[]) {
      const check = checkAlertMirrorConfig(config);
      expect(check).not.toBeNull();
      expect(check?.id).toBe("alert-mirror");
      expect(check?.status).toBe("ok");
      expect(check?.message).toContain("disabled");
    }
  });

  it("warns on invalid min_severity without leaking tokens or destination ids", () => {
    const check = checkAlertMirrorConfig({
      alert_mirror: { enabled: true, min_severity: "critical" as "low", telegram: { chat_id: 424242 } },
      telegram: { bot_token: "super-secret-token" },
    });
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("min_severity");
    expect(check?.message).not.toContain("super-secret-token");
    expect(check?.message).not.toContain("424242");
  });

  it("warns with an actionable non-secret message when enabled with no destinations", () => {
    const check = checkAlertMirrorConfig({ alert_mirror: { enabled: true } });
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("no usable mirror destination");
    // ADR-0039 E2-S2: one inspection Next step, no Configure instruction.
    expect(check?.message).toContain("inspect the alert_mirror block");
    expect(check?.message).not.toContain("Configure");
  });

  it("warns when the telegram destination lacks telegram.bot_token, without leaking the id", () => {
    const check = checkAlertMirrorConfig({
      alert_mirror: { enabled: true, telegram: { chat_id: 424242 } },
    });
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("telegram.bot_token");
    expect(check?.message).not.toContain("424242");
  });

  it("warns when the discord destination lacks discord.bot_token, without leaking the id", () => {
    const check = checkAlertMirrorConfig({
      alert_mirror: { enabled: true, discord: { channel_id: "discord-dest-id" } },
      discord: { bot_token: "   " },
    });
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("discord.bot_token");
    expect(check?.message).not.toContain("discord-dest-id");
  });

  it("warns (not ok) when one destination is usable but another was skipped", () => {
    const check = checkAlertMirrorConfig({
      alert_mirror: { enabled: true, telegram: { chat_id: 1 }, discord: { channel_id: "dc-id" } },
      telegram: { bot_token: "tg-token" },
    });
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("discord.bot_token");
    expect(check?.message).not.toContain("dc-id");
    expect(check?.message).not.toContain("tg-token");
  });

  it("reports ok with a count-only message for one usable destination", () => {
    const check = checkAlertMirrorConfig({
      alert_mirror: { enabled: true, telegram: { chat_id: 424242 } },
      telegram: { bot_token: "tg-token" },
    });
    expect(check).toEqual({
      id: "alert-mirror",
      status: "ok",
      message: "alert_mirror enabled with 1 configured mirror destination(s).",
    });
  });

  it("reports ok with a count-only message for two usable destinations", () => {
    const check = checkAlertMirrorConfig({
      alert_mirror: { enabled: true, telegram: { chat_id: 424242 }, discord: { channel_id: "dc-id" } },
      telegram: { bot_token: "tg-token" },
      discord: { bot_token: "dc-token" },
    });
    expect(check?.status).toBe("ok");
    expect(check?.message).toBe("alert_mirror enabled with 2 configured mirror destination(s).");
    expect(check?.message).not.toContain("telegram");
    expect(check?.message).not.toContain("discord");
    expect(check?.message).not.toContain("424242");
    expect(check?.message).not.toContain("dc-id");
    expect(check?.message).not.toContain("token");
  });
});

describe("doctorPiren alert-mirror wiring", () => {
  const localPiRuntime = async (): Promise<PiRuntimeCheck> => ({ source: "path", version: "0.80.2" });
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-doctor-alert-mirror-"));
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("includes the alert-mirror check exactly once when alert_mirror is configured", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    await writeFile(
      configPath,
      "vault_root: " + root + "\n" +
        "allowed_agents:\n  - thor\n" +
        "telegram:\n  bot_token: tg-token\n" +
        "alert_mirror:\n  enabled: true\n  telegram:\n    chat_id: 424242\n",
    );
    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });
    const matches = report.checks.filter((c) => c.id === "alert-mirror");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.status).toBe("ok");
  });

  it("omits the alert-mirror check entirely when no alert_mirror block exists", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    await writeFile(configPath, "vault_root: " + root + "\nallowed_agents:\n  - thor\n");
    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });
    expect(report.checks.filter((c) => c.id === "alert-mirror")).toHaveLength(0);
  });

  it("includes the alert-mirror check in the multi-agent vault flow too", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    await initVault({ vaultRoot: root, agentName: "heimdall", force: true });
    const configPath = join(root, "config.yml");
    await writeFile(
      configPath,
      "vault_root: " + root + "\n" +
        "allowed_agents:\n  - thor\n  - heimdall\n" +
        "alert_mirror:\n  enabled: false\n",
    );
    const report = await doctorPiren({ env: {}, configPath, piRuntimeChecker: localPiRuntime });
    const matches = report.checks.filter((c) => c.id === "alert-mirror");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.status).toBe("ok");
    expect(matches[0]?.message).toContain("disabled");
  });
});
