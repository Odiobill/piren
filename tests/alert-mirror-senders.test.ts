import { describe, expect, it } from "vitest";
import { createAlertMirrorSenders } from "../src/alert-mirror-senders.js";
import { createAlertMirrorState, mirrorStewardAlert, resolveAlertMirrorConfig } from "../src/alert-mirror.js";
import { TELEGRAM_MESSAGE_LIMIT } from "../src/telegram-transport.js";
import { DISCORD_MESSAGE_LIMIT } from "../src/discord-transport.js";
import type { LocalPirenConfig } from "../src/bootstrap.js";

interface CapturedPost {
  url: string;
  body: Record<string, unknown>;
}

function fakeFetch(captured: CapturedPost[], options: { failOnCall?: number } = {}) {
  let calls = 0;
  return (async (url: unknown, init?: { body?: unknown }) => {
    calls += 1;
    if (options.failOnCall !== undefined && calls === options.failOnCall) {
      return { ok: false, status: 500, json: async () => ({ ok: false, description: "platform exploded with token xyz" }) } as never;
    }
    captured.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    if (String(url).includes("discord.com")) {
      return { ok: true, status: 200, json: async () => ({}) } as never;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) } as never;
  }) as typeof fetch;
}

describe("createAlertMirrorSenders", () => {
  it("builds no senders when the matching bot tokens are absent", () => {
    const senders = createAlertMirrorSenders({});
    expect(senders.telegram).toBeUndefined();
    expect(senders.discord).toBeUndefined();
  });

  it("builds senders from the existing trimmed bot tokens only", () => {
    const captured: CapturedPost[] = [];
    const senders = createAlertMirrorSenders(
      { telegram: { bot_token: "  tg-token  " }, discord: { bot_token: "dc-token" } },
      fakeFetch(captured),
    );
    expect(senders.telegram).toBeDefined();
    expect(senders.discord).toBeDefined();
  });

  it("does not build a sender for a whitespace-only token", () => {
    const senders = createAlertMirrorSenders({ telegram: { bot_token: "   " } }, fakeFetch([]));
    expect(senders.telegram).toBeUndefined();
  });

  it("sends a short telegram message in a single POST to the configured chat", async () => {
    const captured: CapturedPost[] = [];
    const senders = createAlertMirrorSenders({ telegram: { bot_token: "tg-token" } }, fakeFetch(captured));
    await senders.telegram?.("111", "[high] Title\nsteward-inbox/alerts/a.md");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toContain("https://api.telegram.org/bottg-token/sendMessage");
    expect(captured[0]?.body).toEqual({ chat_id: "111", text: "[high] Title\nsteward-inbox/alerts/a.md" });
  });

  it("chunks a long telegram message at the telegram limit, sequentially and losslessly", async () => {
    const captured: CapturedPost[] = [];
    const senders = createAlertMirrorSenders({ telegram: { bot_token: "tg-token" } }, fakeFetch(captured));
    const logical = "[urgent] Big\nsteward-inbox/alerts/big.md\n\n" + "line of body text\n".repeat(400);
    await senders.telegram?.("111", logical);
    expect(captured.length).toBeGreaterThan(1);
    for (const post of captured) {
      expect(String(post.body.text).length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    }
    expect(captured.map((p) => String(p.body.text)).join("")).toBe(logical);
  });

  it("chunks a long discord message at the discord limit, sequentially and losslessly", async () => {
    const captured: CapturedPost[] = [];
    const senders = createAlertMirrorSenders({ discord: { bot_token: "dc-token" } }, fakeFetch(captured));
    const logical = "[urgent] Big\nsteward-inbox/alerts/big.md\n\n" + "line of body text\n".repeat(400);
    await senders.discord?.("222", logical);
    expect(captured.length).toBeGreaterThan(2);
    for (const post of captured) {
      expect(String(post.body.content).length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
      expect(post.url).toBe("https://discord.com/api/v10/channels/222/messages");
    }
    expect(captured.map((p) => String(p.body.content)).join("")).toBe(logical);
  });

  it("rejects the logical sender when any chunk fails so the core records one aggregate failure", async () => {
    const captured: CapturedPost[] = [];
    const senders = createAlertMirrorSenders({ telegram: { bot_token: "tg-token" } }, fakeFetch(captured, { failOnCall: 2 }));
    const logical = "[urgent] Big\nsteward-inbox/alerts/big.md\n\n" + "line of body text\n".repeat(400);
    await expect(senders.telegram?.("111", logical)).rejects.toThrow();

    const config: LocalPirenConfig = {
      telegram: { bot_token: "tg-token" },
      alert_mirror: { enabled: true, include_body: true, telegram: { chat_id: 111 } },
    };
    const resolved = resolveAlertMirrorConfig(config);
    const failingSenders = createAlertMirrorSenders(config, fakeFetch([], { failOnCall: 2 }));
    const deliveries = await mirrorStewardAlert({
      alertId: "big-1",
      severity: "urgent",
      title: "Big",
      path: "steward-inbox/alerts/big.md",
      body: "line of body text\n".repeat(400),
      notify: true,
      config: resolved,
      senders: failingSenders,
      state: createAlertMirrorState(),
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.outcome).toBe("failed");
    expect(JSON.stringify(deliveries)).not.toContain("platform exploded");
    expect(JSON.stringify(deliveries)).not.toContain("xyz");
  });

  it("reports one aggregate sent delivery per destination for a chunked include_body alert", async () => {
    const captured: CapturedPost[] = [];
    const config: LocalPirenConfig = {
      telegram: { bot_token: "tg-token" },
      discord: { bot_token: "dc-token" },
      alert_mirror: {
        enabled: true,
        include_body: true,
        telegram: { chat_id: 111 },
        discord: { channel_id: "222" },
      },
    };
    const resolved = resolveAlertMirrorConfig(config);
    const senders = createAlertMirrorSenders(config, fakeFetch(captured));
    const body = "line of body text\n".repeat(400);
    const deliveries = await mirrorStewardAlert({
      alertId: "big-2",
      severity: "urgent",
      title: "Big",
      path: "steward-inbox/alerts/big.md",
      body,
      notify: true,
      config: resolved,
      senders,
      state: createAlertMirrorState(),
    });
    expect(deliveries).toEqual([
      { destination: { kind: "telegram", id: "111" }, outcome: "sent" },
      { destination: { kind: "discord", id: "222" }, outcome: "sent" },
    ]);
    const logical = "[urgent] Big\nsteward-inbox/alerts/big.md\n\n" + body;
    const telegramText = captured.filter((p) => p.url.includes("telegram.org")).map((p) => String(p.body.text)).join("");
    const discordText = captured.filter((p) => p.url.includes("discord.com")).map((p) => String(p.body.content)).join("");
    expect(telegramText).toBe(logical);
    expect(discordText).toBe(logical);
  });
});
