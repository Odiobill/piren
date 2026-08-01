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

describe("DiscordBotApiHttpClient.getChannel (ADR-0040 D1)", () => {
  it("GETs the channel metadata URL with Bot auth and returns the parsed body", async () => {
    const calls: CapturedRequest[] = [];
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [key, value] of Object.entries(init.headers as Record<string, string>)) headers[key] = value;
      }
      calls.push({ url: String(input), method: init?.method ?? "GET", headers, body: "" });
      return new Response(JSON.stringify({ id: "123456789", type: 1 }), { status: 200 });
    };
    const client = new DiscordBotApiHttpClient("BOT-TOKEN", fakeFetch);

    const metadata = await client.getChannel("123456789");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://discord.com/api/v10/channels/123456789");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers["authorization"]).toBe("Bot BOT-TOKEN");
    expect(metadata).toEqual({ id: "123456789", type: 1 });
  });

  it("throws on a non-2xx response", async () => {
    const fakeFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ message: "Missing Access", code: 50001 }), { status: 403 });
    const client = new DiscordBotApiHttpClient("BOT-TOKEN", fakeFetch);
    await expect(client.getChannel("123")).rejects.toThrow();
  });

  it("rejects on a malformed (non-JSON) response body", async () => {
    const fakeFetch = async (): Promise<Response> => new Response("not json", { status: 200 });
    const client = new DiscordBotApiHttpClient("BOT-TOKEN", fakeFetch);
    await expect(client.getChannel("123")).rejects.toThrow();
  });
});

describe("DiscordBotApiHttpClient application commands (ADR-0040 D3)", () => {
  it("listApplicationCommands GETs the application commands URL with Bot auth", async () => {
    const calls: CapturedRequest[] = [];
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [key, value] of Object.entries(init.headers as Record<string, string>)) headers[key] = value;
      }
      calls.push({ url: String(input), method: init?.method ?? "GET", headers, body: "" });
      return new Response(JSON.stringify([{ id: "cmd-1", name: "start" }]), { status: 200 });
    };
    const client = new DiscordBotApiHttpClient("BOT-TOKEN", fakeFetch);
    const commands = await client.listApplicationCommands("app-1");
    expect(calls[0]?.url).toBe("https://discord.com/api/v10/applications/app-1/commands");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers["authorization"]).toBe("Bot BOT-TOKEN");
    expect(commands).toEqual([{ id: "cmd-1", name: "start" }]);
  });

  it("createApplicationCommand POSTs the spec with Bot auth", async () => {
    const calls: CapturedRequest[] = [];
    const client = new DiscordBotApiHttpClient("BOT-TOKEN", fakeFetchOk(calls, 201));
    const spec = { name: "start", description: "Readiness and help", type: 1 as const };
    await client.createApplicationCommand("app-1", spec);
    expect(calls[0]?.url).toBe("https://discord.com/api/v10/applications/app-1/commands");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["authorization"]).toBe("Bot BOT-TOKEN");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual(spec);
  });

  it("updateApplicationCommand PATCHes the per-command URL with Bot auth", async () => {
    const calls: CapturedRequest[] = [];
    const client = new DiscordBotApiHttpClient("BOT-TOKEN", fakeFetchOk(calls, 200));
    const spec = { name: "agents", description: "List runnable agents", type: 1 as const };
    await client.updateApplicationCommand("app-1", "cmd-7", spec);
    expect(calls[0]?.url).toBe("https://discord.com/api/v10/applications/app-1/commands/cmd-7");
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.headers["authorization"]).toBe("Bot BOT-TOKEN");
  });
});

describe("DiscordBotApiHttpClient.respondToInteraction (ADR-0040 D3)", () => {
  it("POSTs a channel-message callback WITHOUT Bot auth and without logging the token", async () => {
    const calls: CapturedRequest[] = [];
    const client = new DiscordBotApiHttpClient("BOT-TOKEN", fakeFetchOk(calls, 200));
    await client.respondToInteraction("interaction-1", "interaction-token-abc", "pong");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://discord.com/api/v10/interactions/interaction-1/interaction-token-abc/callback");
    expect(calls[0]?.method).toBe("POST");
    // Interaction callbacks authenticate via the token in the URL, never the
    // Bot header.
    expect(calls[0]?.headers["authorization"]).toBeUndefined();
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ type: 4, data: { content: "pong" } });
  });

  it("never includes the interaction token in failure errors", async () => {
    const fakeFetch = async (): Promise<Response> => new Response("plain failure", { status: 403 });
    const client = new DiscordBotApiHttpClient("BOT-TOKEN", fakeFetch);
    try {
      await client.respondToInteraction("interaction-1", "super-secret-interaction-token", "pong");
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("super-secret-interaction-token");
      expect(message).not.toContain("interaction-1");
    }
  });
});
