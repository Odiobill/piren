import { describe, expect, it } from "vitest";
import { checkTelegramConfig } from "../src/doctor.js";

describe("checkTelegramConfig", () => {
  it("returns null when no telegram config is present (normal doctor stays clean)", () => {
    expect(checkTelegramConfig(undefined)).toBeNull();
    expect(checkTelegramConfig({})).toBeNull();
  });

  it("warns when telegram config is declared but bot_token is missing", () => {
    const check = checkTelegramConfig({ allowed_chat_ids: [123] });
    expect(check).not.toBeNull();
    expect(check?.id).toBe("telegram");
    expect(check?.status).toBe("warn");
    expect(check?.message).toMatch(/bot_token/);
  });

  it("warns when bot_token is present but allowed_chat_ids is empty", () => {
    const check = checkTelegramConfig({ bot_token: "123:ABC" });
    expect(check).not.toBeNull();
    expect(check?.status).toBe("warn");
    expect(check?.message).toMatch(/allowed_chat_ids/);
  });

  it("is ok when bot_token and allowed_chat_ids are both present", () => {
    const check = checkTelegramConfig({ bot_token: "123:ABC", allowed_chat_ids: [123, 456] });
    expect(check).not.toBeNull();
    expect(check?.status).toBe("ok");
    expect(check?.message).toMatch(/2 allowlisted chat/);
  });

  it("warns when default_agent is set but not in the runnable set", () => {
    const check = checkTelegramConfig(
      { bot_token: "123:ABC", allowed_chat_ids: [123], default_agent: "ghost" },
      ["piren", "thor"],
    );
    expect(check).not.toBeNull();
    expect(check?.status).toBe("warn");
    expect(check?.message).toMatch(/default_agent 'ghost'/);
  });

  it("is ok when default_agent is in the runnable set", () => {
    const check = checkTelegramConfig(
      { bot_token: "123:ABC", allowed_chat_ids: [123], default_agent: "piren" },
      ["piren", "thor"],
    );
    expect(check?.status).toBe("ok");
  });
});
