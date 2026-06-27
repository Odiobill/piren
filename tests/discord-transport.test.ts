import { describe, expect, it } from "vitest";
import { DiscordTransport } from "../src/discord-transport.js";
import type { RpcEvent } from "../src/gateway-rpc.js";

class FakeDiscordClient {
  prompts: string[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async abort(): Promise<void> {}
  async promptAndWait(message: string): Promise<RpcEvent[]> {
    this.prompts.push(message);
    return [
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "pong" } },
      { type: "agent_end" },
    ];
  }
}

function buildTransport(options?: { allowedThreadIds?: string[]; feedback?: { enabled?: boolean } }) {
  const replies: Array<{ channelId: string; text: string }> = [];
  const clients: FakeDiscordClient[] = [];
  const typing: string[] = [];
  const reactions: Array<{ channelId: string; messageId: string; emoji: string }> = [];
  const transport = new DiscordTransport<FakeDiscordClient>({
    transportName: "discord",
    allowedGuildIds: ["111"],
    allowedChannelIds: ["222"],
    allowedThreadIds: options?.allowedThreadIds,
    runnableAgents: ["piren", "thor"],
    defaultAgent: "piren",
    feedback: options?.feedback,
    targetBuilder: async (agent) => ({ command: "fake", args: [agent], cwd: process.cwd(), env: process.env }),
    clientFactory: () => {
      const client = new FakeDiscordClient();
      clients.push(client);
      return client;
    },
    api: {
      async createMessage(channelId, text) {
        replies.push({ channelId, text });
      },
      async sendTyping(channelId) {
        typing.push(channelId);
      },
      async addReaction(channelId, messageId, emoji) {
        reactions.push({ channelId, messageId, emoji });
      },
    },
  });
  return { transport, replies, clients, typing, reactions };
}

describe("DiscordTransport", () => {
  it("ignores messages from non-allowlisted guilds and channels", async () => {
    const { transport, replies } = buildTransport();

    await transport.handleMessage({ guild_id: "999", channel_id: "222", content: "/agents" });
    await transport.handleMessage({ guild_id: "111", channel_id: "888", content: "/agents" });
    expect(replies).toEqual([]);
  });

  it("exposes runnable agents, switches active agent per conversation, and forwards prompts", async () => {
    const { transport, replies, clients } = buildTransport();

    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "/agents" });
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "/agent thor" });
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "ping" });

    expect(replies.map((r) => r.text)).toEqual([
      "Runnable Piren agents: piren, thor\nActive agent: piren",
      "Active Piren agent for this channel: thor",
      "pong",
    ]);
    expect(clients).toHaveLength(1);
    expect(clients[0]?.prompts).toEqual(["ping"]);
  });

  it("keeps separate active agents per distinct channel conversation", async () => {
    const { transport, replies } = buildTransport({ allowedThreadIds: ["333"] });
    // channel 222 in guild 111 is allowlisted
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "/whoami" });
    // a thread off channel 222 is a distinct conversation
    await transport.handleMessage({ guild_id: "111", channel_id: "222", thread_id: "333", content: "/agent thor" });
    await transport.handleMessage({ guild_id: "111", channel_id: "222", thread_id: "333", content: "/whoami" });

    expect(replies.map((r) => r.text)).toEqual([
      "Active Piren agent: piren",
      "Active Piren agent for this channel: thor",
      "Active Piren agent: thor",
    ]);
  });

  it("ignores threaded messages unless the thread id is explicitly allowlisted", async () => {
    const { transport, replies, clients } = buildTransport();

    await transport.handleMessage({
      guild_id: "111",
      channel_id: "222",
      thread_id: "333",
      content: "hello from a thread",
    });

    expect(replies).toEqual([]);
    expect(clients).toHaveLength(0);
  });

  it("accepts threaded messages when the thread id is explicitly allowlisted", async () => {
    const { transport, replies, clients } = buildTransport({ allowedThreadIds: ["333"] });

    await transport.handleMessage({
      guild_id: "111",
      channel_id: "222",
      thread_id: "333",
      content: "hello from a thread",
    });

    expect(replies).toEqual([{ channelId: "333", text: "pong" }]);
    expect(clients).toHaveLength(1);
  });

  it("rejects an agent that is not in the runnable set", async () => {
    const { transport, replies } = buildTransport();
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "/agent ghost" });
    expect(replies.map((r) => r.text)).toEqual([
      "Agent 'ghost' is not in the runnable set. Use /agents to list available agents.",
    ]);
  });

  it("aborts the active session and reports when no session exists", async () => {
    const { transport, replies } = buildTransport();
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "/abort" });
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "hello" });
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "/abort" });
    expect(replies.map((r) => r.text)).toEqual([
      "No active Piren session for this channel.",
      "pong",
      "Abort sent to active Piren session.",
    ]);
  });

  it("splits a long assistant response into multiple Discord messages", async () => {
    const replies: string[] = [];
    const longText = "alpha ".repeat(600); // 3600 chars
    class LongResponseClient {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async abort(): Promise<void> {}
      async promptAndWait(_message: string): Promise<RpcEvent[]> {
        return [
          { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: longText.trim() } },
          { type: "agent_end" },
        ];
      }
    }
    const transport = new DiscordTransport<LongResponseClient>({
      transportName: "discord",
      allowedGuildIds: ["111"],
      allowedChannelIds: ["222"],
      runnableAgents: ["piren"],
      defaultAgent: "piren",
      targetBuilder: async () => ({ command: "fake", args: [], cwd: process.cwd(), env: process.env }),
      clientFactory: () => new LongResponseClient(),
      api: {
      async createMessage(_channelId, text) { replies.push(text); },
      async sendTyping() {},
      async addReaction() {},
    },
    });

    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "long answer please" });

    expect(replies.length).toBeGreaterThan(1);
    for (const reply of replies) {
      expect(reply.length).toBeLessThanOrEqual(2000);
    }
    expect(replies.join("")).toBe(longText.trim());
  });


  it("sends a receipt reaction, typing, and a completion reaction around a prompt when feedback is on", async () => {
    const { transport, replies, typing, reactions } = buildTransport();

    await transport.handleMessage({ guild_id: "111", channel_id: "222", id: "555", content: "ping" });

    expect(reactions).toContainEqual({ channelId: "222", messageId: "555", emoji: "👀" });
    expect(typing).toContain("222");
    expect(reactions).toContainEqual({ channelId: "222", messageId: "555", emoji: "✅" });
    expect(replies.map((r) => r.text)).toEqual(["pong"]);
  });

  it("does not send Discord feedback when feedback is disabled", async () => {
    const { transport, typing, reactions } = buildTransport({ feedback: { enabled: false } });

    await transport.handleMessage({ guild_id: "111", channel_id: "222", id: "555", content: "ping" });

    expect(typing).toEqual([]);
    expect(reactions).toEqual([]);
  });

  it("Discord feedback failures never abort the turn: the response is still sent", async () => {
    const replies: string[] = [];
    const transport = new DiscordTransport<FakeDiscordClient>({
      transportName: "discord",
      allowedGuildIds: ["111"],
      allowedChannelIds: ["222"],
      runnableAgents: ["piren"],
      defaultAgent: "piren",
      targetBuilder: async () => ({ command: "fake", args: [], cwd: process.cwd(), env: process.env }),
      clientFactory: () => new FakeDiscordClient(),
      api: {
        async createMessage(_channelId, text) { replies.push(text); },
        async sendTyping() { throw new Error("typing failed"); },
        async addReaction() { throw new Error("reaction failed"); },
      },
    });

    await transport.handleMessage({ guild_id: "111", channel_id: "222", id: "555", content: "ping" });

    expect(replies).toEqual(["pong"]);
  });
});
