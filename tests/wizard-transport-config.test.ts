import { describe, expect, it } from "vitest";
import { mergeTransportConfigYaml, type TransportConfigInput } from "../src/wizard.js";

describe("mergeTransportConfigYaml", () => {
  it("appends a telegram block to a config with no existing transport config", () => {
    const input = "vault_root: /srv/vault\nallowed_agents:\n  - piren\n";
    const telegram: TransportConfigInput = {
      telegram: { bot_token: "123:abc", allowed_chat_ids: [111222333] },
    };
    const result = mergeTransportConfigYaml(input, telegram);
    expect(result).toContain("vault_root: /srv/vault");
    expect(result).toContain("telegram:");
    expect(result).toContain("bot_token: 123:abc");
    expect(result).toContain("111222333");
  });

  it("appends a discord block with guild and channel allowlists", () => {
    const input = "vault_root: /srv/vault\n";
    const discord: TransportConfigInput = {
      discord: {
        bot_token: "MTIz",
        allowed_guild_ids: ["999"],
        allowed_channel_ids: ["888"],
      },
    };
    const result = mergeTransportConfigYaml(input, discord);
    expect(result).toContain("discord:");
    expect(result).toContain("MTIz");
    expect(result).toContain("999");
    expect(result).toContain("888");
  });

  it("overwrites an existing telegram bot_token when re-run", () => {
    const input = "telegram:\n  bot_token: old-token\n  allowed_chat_ids:\n    - 1\n";
    const result = mergeTransportConfigYaml(input, {
      telegram: { bot_token: "new-token", allowed_chat_ids: [42] },
    });
    expect(result).not.toContain("old-token");
    expect(result).toContain("new-token");
    expect(result).toContain("42");
  });

  it("preserves unrelated config keys like packages and services", () => {
    const input = [
      "vault_root: /srv/vault",
      "packages:",
      '  - "@piren/web-search"',
      "",
    ].join("\n");
    const result = mergeTransportConfigYaml(input, {
      telegram: { bot_token: "tok", allowed_chat_ids: [1] },
    });
    expect(result).toContain("@piren/web-search");
    expect(result).toContain("vault_root: /srv/vault");
    expect(result).toContain("telegram:");
  });

  it("handles both telegram and discord in one merge", () => {
    const input = "vault_root: /srv/vault\n";
    const result = mergeTransportConfigYaml(input, {
      telegram: { bot_token: "tg", allowed_chat_ids: [1] },
      discord: { bot_token: "dc", allowed_guild_ids: ["g"], allowed_channel_ids: ["c"] },
    });
    expect(result).toContain("telegram:");
    expect(result).toContain("discord:");
    expect(result).toContain("tg");
    expect(result).toContain("dc");
  });
});
