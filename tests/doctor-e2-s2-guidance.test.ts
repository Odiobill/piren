import { describe, expect, it } from "vitest";
import {
  checkAlertMirrorConfig,
  checkContextInjectionConfig,
  checkDiscordConfig,
  checkServiceConfig,
  checkTelegramConfig,
  type DoctorCheck,
} from "../src/doctor.js";

const TRANSPORT_AUTHORITY =
  "Authority: transport credentials and routing live only in local config and are not inferable from the vault.";
const MIRROR_AUTHORITY =
  "Authority: mirror destinations and credentials live only in local config and are not inferable from the vault.";
const SERVICES_AUTHORITY = "Authority: service supervision is machine-local and doctor is read-only.";
const CONTEXT_INJECTION_AUTHORITY =
  "Authority: a valid context_injection.mode is not inferred from a malformed declaration; the documented default applies.";

function expectMessage(check: DoctorCheck | null, expected: string): string {
  expect(check).not.toBeNull();
  expect(check?.status).toBe("warn");
  expect(check?.message).toBe(expected);
  return check?.message ?? "";
}

describe("E2-S2 telegram WARN guidance", () => {
  it("missing token", () => {
    expectMessage(
      checkTelegramConfig({ allowed_chat_ids: [123] }),
      "telegram config is present but telegram.bot_token is missing or empty. " +
        `${TRANSPORT_AUTHORITY} Next: inspect telegram.bot_token in ~/.config/piren/config.yml.`,
    );
  });

  it("empty allowlist", () => {
    expectMessage(
      checkTelegramConfig({ bot_token: "T" }),
      "telegram.bot_token is set but telegram.allowed_chat_ids is empty. No chats are authorized. " +
        `${TRANSPORT_AUTHORITY} Next: inspect telegram.allowed_chat_ids in ~/.config/piren/config.yml.`,
    );
  });

  it("unrunnable default_agent", () => {
    expectMessage(
      checkTelegramConfig({ bot_token: "T", allowed_chat_ids: [1], default_agent: "ghost" }, ["thor"]),
      "telegram.default_agent 'ghost' is not in the runnable agent set (thor). " +
        `${TRANSPORT_AUTHORITY} Next: inspect telegram.default_agent in ~/.config/piren/config.yml.`,
    );
  });
});

describe("E2-S2 discord WARN guidance", () => {
  it("missing token", () => {
    expectMessage(
      checkDiscordConfig({ allowed_guild_ids: ["1"], allowed_channel_ids: ["2"] }),
      "discord config is present but discord.bot_token is missing or empty. " +
        `${TRANSPORT_AUTHORITY} Next: inspect discord.bot_token in ~/.config/piren/config.yml.`,
    );
  });

  it("empty guild allowlist", () => {
    expectMessage(
      checkDiscordConfig({ bot_token: "T", allowed_channel_ids: ["2"] }),
      "discord.bot_token is set but discord.allowed_guild_ids is empty. No guilds are authorized. " +
        `${TRANSPORT_AUTHORITY} Next: inspect discord.allowed_guild_ids in ~/.config/piren/config.yml.`,
    );
  });

  it("empty channel allowlist", () => {
    expectMessage(
      checkDiscordConfig({ bot_token: "T", allowed_guild_ids: ["1"] }),
      "discord.bot_token is set but discord.allowed_channel_ids is empty. No channels are authorized. " +
        `${TRANSPORT_AUTHORITY} Next: inspect discord.allowed_channel_ids in ~/.config/piren/config.yml.`,
    );
  });

  it("unrunnable default_agent", () => {
    expectMessage(
      checkDiscordConfig(
        { bot_token: "T", allowed_guild_ids: ["1"], allowed_channel_ids: ["2"], default_agent: "ghost" },
        ["thor"],
      ),
      "discord.default_agent 'ghost' is not in the runnable agent set (thor). " +
        `${TRANSPORT_AUTHORITY} Next: inspect discord.default_agent in ~/.config/piren/config.yml.`,
    );
  });
});

describe("E2-S2 services WARN guidance", () => {
  it("declared but not installed, without install commands", () => {
    const message = expectMessage(
      checkServiceConfig({ transports: { gateway: { installed: false } } }),
      "Declared service target(s) not installed as a service: gateway. " +
        `${SERVICES_AUTHORITY} Next: inspect services.transports.gateway in ~/.config/piren/config.yml.`,
    );
    expect(message).not.toContain("piren service install");
    expect(message).not.toContain("Run `");
  });

  it("installed but not running, without start commands", () => {
    const message = expectMessage(
      checkServiceConfig({ transports: { discord: { installed: true, running: false } } }),
      "Installed service target(s) reported as not running: discord. " +
        `${SERVICES_AUTHORITY} Next: inspect services.transports.discord in ~/.config/piren/config.yml.`,
    );
    expect(message).not.toContain("piren service start");
    expect(message).not.toContain("Run `");
  });

  it("picks the first declared name deterministically for the inspect key", () => {
    const message = expectMessage(
      checkServiceConfig({ transports: { telegram: { installed: false }, gateway: { installed: false } } }),
      "Declared service target(s) not installed as a service: telegram, gateway. " +
        `${SERVICES_AUTHORITY} Next: inspect services.transports.telegram in ~/.config/piren/config.yml.`,
    );
    expect(message).toContain("services.transports.telegram");
  });
});

describe("E2-S2 alert-mirror WARN guidance", () => {
  it("invalid min_severity, without secrets or destination IDs", () => {
    const message = expectMessage(
      checkAlertMirrorConfig({
        alert_mirror: { enabled: true, min_severity: "critical" as "low", telegram: { chat_id: 424242 } },
        telegram: { bot_token: "tg-secret-token" },
      }),
      "alert_mirror: invalid min_severity; mirroring disabled (use low, normal, high, or urgent). " +
        `${MIRROR_AUTHORITY} Next: inspect alert_mirror.min_severity in ~/.config/piren/config.yml.`,
    );
    expect(message).not.toContain("tg-secret-token");
    expect(message).not.toContain("424242");
  });

  it("enabled with no destinations at all, without a Configure instruction", () => {
    const message = expectMessage(
      checkAlertMirrorConfig({ alert_mirror: { enabled: true } }),
      "alert_mirror is enabled but has no usable mirror destination. " +
        `${MIRROR_AUTHORITY} Next: inspect the alert_mirror block in ~/.config/piren/config.yml.`,
    );
    expect(message).not.toContain("Configure");
  });

  it("telegram destination missing its bot token, without the destination ID", () => {
    const message = expectMessage(
      checkAlertMirrorConfig({ alert_mirror: { enabled: true, telegram: { chat_id: 424242 } } }),
      "alert_mirror is enabled but has no usable mirror destination. " +
        "alert_mirror: telegram destination configured but telegram.bot_token is missing; destination skipped. " +
        `${MIRROR_AUTHORITY} Next: inspect alert_mirror.telegram.chat_id in ~/.config/piren/config.yml.`,
    );
    expect(message).not.toContain("424242");
  });

  it("usable telegram with skipped discord, without secrets or IDs", () => {
    const message = expectMessage(
      checkAlertMirrorConfig({
        alert_mirror: { enabled: true, telegram: { chat_id: 1 }, discord: { channel_id: "dc-dest-1" } },
        telegram: { bot_token: "tg-secret-token" },
      }),
      "alert_mirror: discord destination configured but discord.bot_token is missing; destination skipped. " +
        `${MIRROR_AUTHORITY} Next: inspect alert_mirror.discord.channel_id in ~/.config/piren/config.yml.`,
    );
    expect(message).not.toContain("dc-dest-1");
    expect(message).not.toContain("tg-secret-token");
  });
});

describe("E2-S2 context-injection WARN guidance", () => {
  it("invalid mode value (map block)", () => {
    expectMessage(
      checkContextInjectionConfig({ context_injection: { mode: "sometimes" } }),
      "Unknown context_injection.mode 'sometimes' in agent config (expected per_turn | session_start_only); falling back to per_turn. " +
        `${CONTEXT_INJECTION_AUTHORITY} Next: inspect context_injection.mode in team/<agent>/config.yml.`,
    );
  });

  it("non-map block", () => {
    expectMessage(
      checkContextInjectionConfig({ context_injection: "sometimes" }),
      "Invalid context_injection block in agent config (expected a mapping with mode: per_turn | session_start_only); falling back to per_turn. " +
        `${CONTEXT_INJECTION_AUTHORITY} Next: inspect context_injection in team/<agent>/config.yml.`,
    );
  });
});

describe("E2-S2 OK and null outcomes stay byte-for-byte unchanged", () => {
  it("ok messages", () => {
    expect(checkTelegramConfig({ bot_token: "T", allowed_chat_ids: [1, 2] })?.message).toBe(
      "Telegram configured with 2 allowlisted chat(s).",
    );
    expect(
      checkDiscordConfig({ bot_token: "T", allowed_guild_ids: ["1", "3"], allowed_channel_ids: ["2"] })?.message,
    ).toBe("Discord configured with 2 guild(s) and 1 channel(s) allowlisted.");
    expect(checkServiceConfig({ transports: { gateway: { installed: true } } })?.message).toBe(
      "All declared service targets installed and running: gateway.",
    );
    expect(checkAlertMirrorConfig({ alert_mirror: { enabled: false } })?.message).toBe(
      "alert_mirror is configured but disabled (enabled is not true).",
    );
    expect(
      checkAlertMirrorConfig({
        alert_mirror: { enabled: true, telegram: { chat_id: 1 } },
        telegram: { bot_token: "T" },
      })?.message,
    ).toBe("alert_mirror enabled with 1 configured mirror destination(s).");
    expect(checkContextInjectionConfig({ context_injection: { mode: "per_turn" } })?.message).toBe(
      "context_injection.mode: per_turn.",
    );
  });

  it("absent blocks still return null", () => {
    expect(checkTelegramConfig(undefined)).toBeNull();
    expect(checkDiscordConfig(undefined)).toBeNull();
    expect(checkServiceConfig(undefined)).toBeNull();
    expect(checkAlertMirrorConfig({})).toBeNull();
    expect(checkContextInjectionConfig(null)).toBeNull();
    expect(checkContextInjectionConfig({})).toBeNull();
  });
});

describe("E2-S2 guidance is one-action and mutation-free across all shapes", () => {
  function allWarnMessages(): string[] {
    const checks: Array<DoctorCheck | null> = [
      checkTelegramConfig({ allowed_chat_ids: [1] }),
      checkTelegramConfig({ bot_token: "T" }),
      checkTelegramConfig({ bot_token: "T", allowed_chat_ids: [1], default_agent: "ghost" }, ["thor"]),
      checkDiscordConfig({ allowed_guild_ids: ["1"], allowed_channel_ids: ["2"] }),
      checkDiscordConfig({ bot_token: "T", allowed_channel_ids: ["2"] }),
      checkDiscordConfig({ bot_token: "T", allowed_guild_ids: ["1"] }),
      checkDiscordConfig({ bot_token: "T", allowed_guild_ids: ["1"], allowed_channel_ids: ["2"], default_agent: "ghost" }, ["thor"]),
      checkServiceConfig({ transports: { gateway: { installed: false } } }),
      checkServiceConfig({ transports: { discord: { installed: true, running: false } } }),
      checkAlertMirrorConfig({ alert_mirror: { enabled: true, min_severity: "critical" as "low" } }),
      checkAlertMirrorConfig({ alert_mirror: { enabled: true } }),
      checkAlertMirrorConfig({ alert_mirror: { enabled: true, telegram: { chat_id: 1 } } }),
      checkAlertMirrorConfig({
        alert_mirror: { enabled: true, telegram: { chat_id: 1 }, discord: { channel_id: "2" } },
        telegram: { bot_token: "T" },
      }),
      checkContextInjectionConfig({ context_injection: { mode: "sometimes" } }),
      checkContextInjectionConfig({ context_injection: "sometimes" }),
    ];
    return checks.map((check) => {
      expect(check?.status).toBe("warn");
      return check?.message ?? "";
    });
  }

  it("every WARN message has exactly one Authority clause and exactly one one-action Next", () => {
    for (const message of allWarnMessages()) {
      expect(message.split(" Authority: ")).toHaveLength(2);
      expect(message.split(" Next: ")).toHaveLength(2);
      const next = message.split(" Next: ")[1] ?? "";
      expect(next.startsWith("inspect ")).toBe(true);
      expect(next.endsWith(".")).toBe(true);
      // Exactly one inspection action: no action-joining connectors.
      expect(next).not.toMatch(/ and |,|;| then /);
    }
  });

  it("no WARN message contains mutation verbs or commands", () => {
    for (const message of allWarnMessages()) {
      expect(message).not.toMatch(
        /Run `|Configure |piren service install|piren service start|piren task (complete|cancel|claim)|requeue|delete|manually reset|edit the file|remove the/i,
      );
    }
  });
});
