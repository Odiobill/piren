import { describe, expect, it } from "vitest";
import { checkDiscordConfig } from "../src/doctor.js";

describe("checkDiscordConfig", () => {
  it("returns null when no discord config is present (normal doctor stays clean)", () => {
    expect(checkDiscordConfig(undefined)).toBeNull();
    expect(checkDiscordConfig({})).toBeNull();
  });

  it("warns when discord config is declared but bot_token is missing", () => {
    const check = checkDiscordConfig({ allowed_guild_ids: ["111"], allowed_channel_ids: ["222"] });
    expect(check).not.toBeNull();
    expect(check?.id).toBe("discord");
    expect(check?.status).toBe("warn");
    expect(check?.message).toMatch(/bot_token/);
  });

  it("warns when bot_token is present but guild or channel allowlists are empty", () => {
    const noGuild = checkDiscordConfig({ bot_token: "TOK", allowed_channel_ids: ["222"] });
    expect(noGuild?.status).toBe("warn");
    expect(noGuild?.message).toMatch(/allowed_guild_ids/);

    const noChannel = checkDiscordConfig({ bot_token: "TOK", allowed_guild_ids: ["111"] });
    expect(noChannel?.status).toBe("warn");
    expect(noChannel?.message).toMatch(/allowed_channel_ids/);
  });

  it("is ok when bot_token and both guild and channel allowlists are present", () => {
    const check = checkDiscordConfig({
      bot_token: "TOK",
      allowed_guild_ids: ["111", "333"],
      allowed_channel_ids: ["222"],
    });
    expect(check?.status).toBe("ok");
    expect(check?.message).toMatch(/2 guild.*1 channel/);
  });

  it("warns when default_agent is set but not in the runnable set", () => {
    const check = checkDiscordConfig(
      { bot_token: "TOK", allowed_guild_ids: ["111"], allowed_channel_ids: ["222"], default_agent: "ghost" },
      ["piren", "thor"],
    );
    expect(check?.status).toBe("warn");
    expect(check?.message).toMatch(/default_agent 'ghost'/);
  });

  it("is ok when default_agent is in the runnable set", () => {
    const check = checkDiscordConfig(
      { bot_token: "TOK", allowed_guild_ids: ["111"], allowed_channel_ids: ["222"], default_agent: "piren" },
      ["piren", "thor"],
    );
    expect(check?.status).toBe("ok");
  });
});
