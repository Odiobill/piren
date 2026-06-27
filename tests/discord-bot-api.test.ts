import { describe, expect, it } from "vitest";
import { DiscordBotApiHttpClient } from "../src/discord-transport.js";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function fakeFetchOk(calls: CapturedRequest[], status = 200) {
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
    return new Response("{}", { status });
  };
}

describe("DiscordBotApiHttpClient", () => {
  it("createMessage posts to the channel messages URL with Bot auth and content body", async () => {
    const calls: CapturedRequest[] = [];
    const client = new DiscordBotApiHttpClient("BOT-TOKEN", fakeFetchOk(calls));
    await client.createMessage("123456789", "hello");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://discord.com/api/v10/channels/123456789/messages");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["authorization"]).toBe("Bot BOT-TOKEN");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ content: "hello" });
  });

  it("throws on a non-2xx response carrying the Discord error payload", async () => {
    const fakeFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ message: "Cannot send messages to this user", code: 50007 }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    const client = new DiscordBotApiHttpClient("BOT-TOKEN", fakeFetch);
    await expect(client.createMessage("123", "hello")).rejects.toThrow("Cannot send messages to this user");
  });

  it("includes a generic failure message when the error body is not JSON", async () => {
    const fakeFetch = async (): Promise<Response> => new Response("plain text error", { status: 500 });
    const client = new DiscordBotApiHttpClient("BOT-TOKEN", fakeFetch);
    await expect(client.createMessage("123", "hello")).rejects.toThrow(/Discord createMessage failed/);
  });


  it("sendTyping posts to the channel typing URL", async () => {
    const calls: CapturedRequest[] = [];
    const client = new DiscordBotApiHttpClient("BOT-TOKEN", fakeFetchOk(calls, 200));
    await client.sendTyping("123456789");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://discord.com/api/v10/channels/123456789/typing");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["authorization"]).toBe("Bot BOT-TOKEN");
  });

  it("addReaction puts the URL-encoded emoji reaction and resolves on success", async () => {
    const calls: CapturedRequest[] = [];
    const client = new DiscordBotApiHttpClient("BOT-TOKEN", fakeFetchOk(calls, 200));
    await client.addReaction("123456789", "987654321", "👀");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://discord.com/api/v10/channels/123456789/messages/987654321/reactions/%F0%9F%91%80/@me");
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.headers["authorization"]).toBe("Bot BOT-TOKEN");
  });

  it("addReaction is best-effort: a failed reaction does not throw", async () => {
    const fakeFetch = async (): Promise<Response> => new Response(JSON.stringify({ message: "Missing permissions" }), { status: 403 });
    const client = new DiscordBotApiHttpClient("BOT-TOKEN", fakeFetch);
    await expect(client.addReaction("123", "456", "👀")).resolves.toBeUndefined();
  });
});
