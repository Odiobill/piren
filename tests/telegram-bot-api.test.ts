import { describe, expect, it } from "vitest";
import { TelegramBotApiHttpClient } from "../src/telegram-transport.js";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function fakeFetchOk(result: unknown, calls: CapturedRequest[]) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const source = init.headers as Record<string, string>;
      for (const [key, value] of Object.entries(source)) headers[key] = value;
    }
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  };
}

describe("TelegramBotApiHttpClient", () => {
  it("sendMessage posts to the bot URL with chat_id and text and resolves on ok=true", async () => {
    const calls: CapturedRequest[] = [];
    const client = new TelegramBotApiHttpClient("123456:ABC", fakeFetchOk(true, calls));
    await client.sendMessage(987654, "hello");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.telegram.org/bot123456:ABC/sendMessage");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ chat_id: 987654, text: "hello" });
  });

  it("sendMessage throws with the Telegram description when ok=false", async () => {
    const fakeFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 200 });
    const client = new TelegramBotApiHttpClient("123456:ABC", fakeFetch);
    await expect(client.sendMessage(987654, "hello")).rejects.toThrow("chat not found");
  });

  it("getUpdates omits offset on first call and includes timeout and offset afterwards", async () => {
    const calls: CapturedRequest[] = [];
    const client = new TelegramBotApiHttpClient(
      "123456:ABC",
      fakeFetchOk([{ update_id: 42, message: { chat: { id: 1 }, text: "hi" } }], calls),
    );
    const first = await client.getUpdates(undefined, 25);
    expect(first).toEqual([{ update_id: 42, message: { chat: { id: 1 }, text: "hi" } }]);
    const firstBody = JSON.parse(calls[0]?.body ?? "{}");
    expect(firstBody).toEqual({ timeout: 25 });
    expect("offset" in firstBody).toBe(false);

    await client.getUpdates(43, 25);
    const secondBody = JSON.parse(calls[1]?.body ?? "{}");
    expect(secondBody).toEqual({ timeout: 25, offset: 43 });
  });

  it("getUpdates returns an empty array when ok=true but result is not an array", async () => {
    const client = new TelegramBotApiHttpClient(
      "123456:ABC",
      fakeFetchOk({ unexpected: "shape" }, []),
    );
    const updates = await client.getUpdates(undefined, 25);
    expect(updates).toEqual([]);
  });

  it("getUpdates throws with the Telegram description when ok=false", async () => {
    const fakeFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ ok: false, description: "unauthorized" }), { status: 200 });
    const client = new TelegramBotApiHttpClient("123456:ABC", fakeFetch);
    await expect(client.getUpdates(undefined, 25)).rejects.toThrow("unauthorized");
  });

  it("sendChatAction posts chat_id and action=typing", async () => {
    const calls: CapturedRequest[] = [];
    const client = new TelegramBotApiHttpClient("123456:ABC", fakeFetchOk(true, calls));
    await client.sendChatAction(987654, "typing");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.telegram.org/bot123456:ABC/sendChatAction");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ chat_id: 987654, action: "typing" });
  });

  it("setMessageReaction posts the emoji as reaction", async () => {
    const calls: CapturedRequest[] = [];
    const client = new TelegramBotApiHttpClient("123456:ABC", fakeFetchOk(true, calls));
    await client.setMessageReaction(987654, 555, "👀");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.telegram.org/bot123456:ABC/setMessageReaction");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ chat_id: 987654, message_id: 555, reaction: [{ type: "emoji", emoji: "👀" }] });
  });

  it("setMessageReaction is best-effort: a failed reaction does not throw", async () => {
    const fakeFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ ok: false, description: "reaction not allowed" }), { status: 200 });
    const client = new TelegramBotApiHttpClient("123456:ABC", fakeFetch);
    // Should resolve, not reject, because reactions are best-effort.
    await expect(client.setMessageReaction(987654, 555, "👀")).resolves.toBeUndefined();
  });
});
