import { describe, expect, it } from "vitest";
import { DiscordTransport } from "../src/discord-transport.js";
import type { RpcEvent } from "../src/gateway-rpc.js";

class FakeDiscordClient {
  prompts: string[] = [];
  newSessionCalls = 0;
  compactCalls = 0;
  newSessionResult: { cancelled: boolean } = { cancelled: false };
  failNextControl: string | null = null;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async abort(): Promise<void> {}
  async newSession(): Promise<{ cancelled: boolean }> {
    this.newSessionCalls++;
    if (this.failNextControl !== null) throw new Error(this.failNextControl);
    return this.newSessionResult;
  }
  async compact(): Promise<{ tokensBefore: number | null; estimatedTokensAfter: number | null }> {
    this.compactCalls++;
    if (this.failNextControl !== null) throw new Error(this.failNextControl);
    return { tokensBefore: 150000, estimatedTokensAfter: 32000 };
  }
  async promptAndWait(message: string): Promise<RpcEvent[]> {
    this.prompts.push(message);
    return [
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "pong" } },
      { type: "agent_end" },
    ];
  }
}

function buildTransport(options?: {
  allowedThreadIds?: string[];
  feedback?: { enabled?: boolean };
  allowedDmUserIds?: string[];
  channelLookup?: { type?: number | string } | "throw";
}) {
  const replies: Array<{ channelId: string; text: string }> = [];
  const clients: FakeDiscordClient[] = [];
  const typing: string[] = [];
  const reactions: Array<{ channelId: string; messageId: string; emoji: string }> = [];
  const getChannelCalls: string[] = [];
  const transport = new DiscordTransport<FakeDiscordClient>({
    transportName: "discord",
    allowedGuildIds: ["111"],
    allowedChannelIds: ["222"],
    allowedThreadIds: options?.allowedThreadIds,
    allowedDmUserIds: options?.allowedDmUserIds,
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
      async getChannel(channelId) {
        getChannelCalls.push(channelId);
        const lookup = options?.channelLookup ?? { type: 1 };
        if (lookup === "throw") throw new Error("Discord getChannel failed (HTTP 403)");
        // Deliberately cast: tests use this to inject malformed metadata.
        return (lookup.type === undefined ? { id: channelId } : { id: channelId, type: lookup.type }) as { id: string; type?: number };
      },
    },
  });
  return { transport, replies, clients, typing, reactions, getChannelCalls };
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

  it("routes a real gateway thread MESSAGE_CREATE shape (thread id in channel_id, no thread_id) when explicitly allowlisted", async () => {
    const { transport, replies, clients } = buildTransport({ allowedThreadIds: ["333"] });

    // Real Discord Gateway shape: a message sent inside a thread carries the
    // thread's own id in channel_id and has no thread_id property at all.
    await transport.handleMessage({ guild_id: "111", channel_id: "333", content: "hello from a thread" });

    expect(replies).toEqual([{ channelId: "333", text: "pong" }]);
    expect(clients).toHaveLength(1);
  });

  it("keeps a stable per-thread conversation key for the real thread payload shape", async () => {
    const { transport, replies, clients } = buildTransport({ allowedThreadIds: ["333"] });

    await transport.handleMessage({ guild_id: "111", channel_id: "333", content: "/agent thor" });
    await transport.handleMessage({ guild_id: "111", channel_id: "333", content: "/whoami" });
    await transport.handleMessage({ guild_id: "111", channel_id: "333", content: "ping" });

    expect(replies.map((r) => r.text)).toEqual([
      "Active Piren agent for this channel: thor",
      "Active Piren agent: thor",
      "pong",
    ]);
    expect(clients).toHaveLength(1);
  });

  it("rejects the real thread payload shape when the thread id is not explicitly allowlisted", async () => {
    const { transport, replies, clients } = buildTransport();

    await transport.handleMessage({ guild_id: "111", channel_id: "333", content: "hello from a thread" });

    expect(replies).toEqual([]);
    expect(clients).toHaveLength(0);
  });

  it("does not let allowed_thread_ids widen ordinary channel access", async () => {
    const { transport, replies, clients } = buildTransport({ allowedThreadIds: ["333"] });

    await transport.handleMessage({ guild_id: "111", channel_id: "888", content: "/agents" });

    expect(replies).toEqual([]);
    expect(clients).toHaveLength(0);
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
  async newSession(): Promise<{ cancelled: boolean }> { return { cancelled: false }; }
  async compact(): Promise<{ tokensBefore: number | null; estimatedTokensAfter: number | null }> { return { tokensBefore: null, estimatedTokensAfter: null }; }
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
      async getChannel(channelId) { return { id: channelId, type: 1 }; },
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
        async getChannel(channelId) { return { id: channelId, type: 1 }; },
      },
    });

    await transport.handleMessage({ guild_id: "111", channel_id: "222", id: "555", content: "ping" });

    expect(replies).toEqual(["pong"]);
  });
});

describe("DiscordTransport session controls /new and /compact (T2b)", () => {
  it("reports no active session for /new and /compact without creating a client", async () => {
    const { transport, replies, clients } = buildTransport();

    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "/new" });
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "/compact" });

    expect(replies.map((r) => r.text)).toEqual([
      "No active Piren session for this channel.",
      "No active Piren session for this channel.",
    ]);
    expect(clients).toHaveLength(0);
  });

  it("starts a new session on /new and preserves the active agent and client", async () => {
    const { transport, replies, clients } = buildTransport();

    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "ping" });
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "/agent thor" });
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "/new" });
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "/whoami" });

    expect(replies.map((r) => r.text)).toEqual([
      "pong",
      "Active Piren agent for this channel: thor",
      "Started a new Piren session for this channel.",
      "Active Piren agent: thor",
    ]);
    // Native operation on the live client: no extra client was created.
    expect(clients).toHaveLength(2);
    expect(clients[1]?.newSessionCalls).toBe(1);
    expect(clients[0]?.newSessionCalls).toBe(0);
  });

  it("reports a Pi-cancelled new session distinctly", async () => {
    const { transport, replies, clients } = buildTransport();

    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "ping" });
    clients[0]!.newSessionResult = { cancelled: true };
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "/new" });

    expect(replies[replies.length - 1]?.text).toBe("New Piren session cancelled; the current session is unchanged.");
  });

  it("compacts the active session on /compact without token or transcript details", async () => {
    const { transport, replies, clients } = buildTransport();

    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "ping" });
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "/compact" });

    expect(clients[0]?.compactCalls).toBe(1);
    const ack = replies[replies.length - 1]?.text ?? "";
    expect(ack).toBe("Compaction complete for this channel's Piren session.");
    expect(ack).not.toContain("150000");
    expect(ack).not.toContain("32000");
  });

  it("returns a generic failure acknowledgement without raw error text", async () => {
    const { transport, replies, clients } = buildTransport();

    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "ping" });
    clients[0]!.failNextControl = "pi rpc exploded: /home/user/secret/token";
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "/new" });
    clients[0]!.failNextControl = "pi rpc exploded: /home/user/secret/token";
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "/compact" });

    expect(replies[replies.length - 2]?.text).toBe("Failed to start a new Piren session for this channel.");
    expect(replies[replies.length - 1]?.text).toBe("Failed to compact this channel's Piren session.");
    for (const reply of replies) {
      expect(reply.text).not.toContain("exploded");
      expect(reply.text).not.toContain("secret");
    }
  });

  it("dispatches /new only to the current thread conversation (real gateway thread shape)", async () => {
    const { transport, replies, clients } = buildTransport({ allowedThreadIds: ["333"] });

    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "ping" });
    // Real Discord Gateway shape: thread message with thread id in channel_id.
    await transport.handleMessage({ guild_id: "111", channel_id: "333", content: "ping" });
    await transport.handleMessage({ guild_id: "111", channel_id: "333", content: "/new" });

    expect(clients).toHaveLength(2);
    expect(clients[0]?.newSessionCalls).toBe(0);
    expect(clients[1]?.newSessionCalls).toBe(1);
    expect(replies[replies.length - 1]).toEqual({ channelId: "333", text: "Started a new Piren session for this channel." });
  });

  it("handles a mention-prefixed /new like a plain command", async () => {
    const { transport, replies } = buildTransport();

    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "<@123456> /new" });

    expect(replies.map((r) => r.text)).toEqual(["No active Piren session for this channel."]);
  });

  it("stays silent for /new in an unallowlisted channel", async () => {
    const { transport, replies, clients } = buildTransport();

    await transport.handleMessage({ guild_id: "111", channel_id: "888", content: "/new" });

    expect(replies).toEqual([]);
    expect(clients).toHaveLength(0);
  });

  it("lists /new and /compact in the /start and unknown-command help text", async () => {
    const { transport, replies } = buildTransport();

    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "/start" });
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "/bogus" });

    for (const reply of replies) {
      expect(reply.text).toContain("/new");
      expect(reply.text).toContain("/compact");
    }
  });
});

describe("DiscordTransport exact-only session control parsing (T2b review pin)", () => {
  it("treats argument-bearing /new and /compact forms as unknown commands and never invokes the controls", async () => {
    const { transport, replies, clients } = buildTransport();

    // No session exists: the argument forms must not create one. The
    // mention-prefixed argument form takes the same unknown-command path.
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "/new extra" });
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "<@123456> /compact focus on code" });

    expect(replies.map((r) => r.text)).toEqual([
      "Unknown Piren command. Use /agents, /agent <name>, /whoami, /abort, /new, or /compact.",
      "Unknown Piren command. Use /agents, /agent <name>, /whoami, /abort, /new, or /compact.",
    ]);
    expect(clients).toHaveLength(0);

    // With an active session, the argument forms still must not reach the controls.
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "ping" });
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "/new extra" });
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "/compact focus on code" });
    expect(clients[0]?.newSessionCalls).toBe(0);
    expect(clients[0]?.compactCalls).toBe(0);
  });
});

describe("DiscordTransport direct messages (ADR-0040 D1)", () => {
  it("accepts an allowlisted one-to-one DM and replies on the DM channel", async () => {
    const { transport, replies, clients, getChannelCalls } = buildTransport({ allowedDmUserIds: ["user-1"] });

    await transport.handleMessage({ channel_id: "555", author: { id: "user-1" }, content: "ping" });

    expect(getChannelCalls).toEqual(["555"]);
    expect(replies).toEqual([{ channelId: "555", text: "pong" }]);
    expect(clients).toHaveLength(1);
    expect(clients[0]?.prompts).toEqual(["ping"]);
  });

  it("handles DM commands like /start on the DM channel", async () => {
    const { transport, replies, clients } = buildTransport({ allowedDmUserIds: ["user-1"] });

    await transport.handleMessage({ channel_id: "555", author: { id: "user-1" }, content: "/start" });

    expect(replies).toHaveLength(1);
    expect(replies[0]?.channelId).toBe("555");
    expect(replies[0]?.text).toContain("Piren Discord transport ready");
    expect(clients).toHaveLength(0);
  });

  it("uses a collision-safe dm: conversation key isolated from the guild conversation with the same channel id", async () => {
    const { transport, replies } = buildTransport({ allowedDmUserIds: ["user-1"] });

    // Same numeric channel id (222) as the allowlisted guild channel: the DM
    // conversation key (dm:222) must not collide with the guild key (111:222).
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "/whoami" });
    await transport.handleMessage({ channel_id: "222", author: { id: "user-1" }, content: "/agent thor" });
    await transport.handleMessage({ channel_id: "222", author: { id: "user-1" }, content: "/whoami" });
    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "/whoami" });

    expect(replies.map((r) => r.text)).toEqual([
      "Active Piren agent: piren",
      "Active Piren agent for this channel: thor",
      "Active Piren agent: thor",
      "Active Piren agent: piren",
    ]);
  });

  it("stays silent for an unlisted DM sender without a channel lookup", async () => {
    const { transport, replies, clients, getChannelCalls } = buildTransport({ allowedDmUserIds: ["user-1"] });

    await transport.handleMessage({ channel_id: "555", author: { id: "user-9" }, content: "ping" });

    expect(replies).toEqual([]);
    expect(clients).toHaveLength(0);
    expect(getChannelCalls).toEqual([]);
  });

  it("stays silent when the DM sender id is missing or empty, without a channel lookup", async () => {
    const { transport, replies, clients, getChannelCalls } = buildTransport({ allowedDmUserIds: ["user-1"] });

    await transport.handleMessage({ channel_id: "555", content: "ping" });
    await transport.handleMessage({ channel_id: "555", author: {}, content: "ping" });
    await transport.handleMessage({ channel_id: "555", author: { id: "  " }, content: "ping" });

    expect(replies).toEqual([]);
    expect(clients).toHaveLength(0);
    expect(getChannelCalls).toEqual([]);
  });

  it("stays silent for DMs when no allowed_dm_user_ids is configured, without a channel lookup", async () => {
    const { transport, replies, clients, getChannelCalls } = buildTransport();

    await transport.handleMessage({ channel_id: "555", author: { id: "user-1" }, content: "ping" });

    expect(replies).toEqual([]);
    expect(clients).toHaveLength(0);
    expect(getChannelCalls).toEqual([]);
  });

  it("rejects a group DM (channel type 3) after the lookup", async () => {
    const { transport, replies, clients, getChannelCalls } = buildTransport({
      allowedDmUserIds: ["user-1"],
      channelLookup: { type: 3 },
    });

    await transport.handleMessage({ channel_id: "555", author: { id: "user-1" }, content: "ping" });

    expect(getChannelCalls).toEqual(["555"]);
    expect(replies).toEqual([]);
    expect(clients).toHaveLength(0);
  });

  it("rejects unknown or non-DM channel types", async () => {
    const { transport, replies, clients } = buildTransport({
      allowedDmUserIds: ["user-1"],
      channelLookup: { type: 0 },
    });

    await transport.handleMessage({ channel_id: "555", author: { id: "user-1" }, content: "ping" });

    expect(replies).toEqual([]);
    expect(clients).toHaveLength(0);
  });

  it("rejects silently when the channel metadata lookup fails", async () => {
    const { transport, replies, clients, getChannelCalls } = buildTransport({
      allowedDmUserIds: ["user-1"],
      channelLookup: "throw",
    });

    await transport.handleMessage({ channel_id: "555", author: { id: "user-1" }, content: "ping" });

    expect(getChannelCalls).toEqual(["555"]);
    expect(replies).toEqual([]);
    expect(clients).toHaveLength(0);
  });

  it("rejects malformed channel metadata (missing or non-numeric type)", async () => {
    const missing = buildTransport({ allowedDmUserIds: ["user-1"], channelLookup: {} });
    await missing.transport.handleMessage({ channel_id: "555", author: { id: "user-1" }, content: "ping" });
    expect(missing.replies).toEqual([]);
    expect(missing.clients).toHaveLength(0);

    const stringTyped = buildTransport({ allowedDmUserIds: ["user-1"], channelLookup: { type: "1" } });
    await stringTyped.transport.handleMessage({ channel_id: "555", author: { id: "user-1" }, content: "ping" });
    expect(stringTyped.replies).toEqual([]);
    expect(stringTyped.clients).toHaveLength(0);
  });

  it("ignores bot-authored messages even from an allowlisted DM user", async () => {
    const { transport, replies, clients, getChannelCalls } = buildTransport({ allowedDmUserIds: ["user-1"] });

    await transport.handleMessage({ channel_id: "555", author: { id: "user-1", bot: true }, content: "ping" });

    expect(replies).toEqual([]);
    expect(clients).toHaveLength(0);
    expect(getChannelCalls).toEqual([]);
  });

  it("never triggers the DM channel metadata lookup for guild traffic", async () => {
    const { transport, replies, getChannelCalls } = buildTransport({ allowedDmUserIds: ["user-1"] });

    await transport.handleMessage({ guild_id: "111", channel_id: "222", content: "ping" });

    expect(replies).toEqual([{ channelId: "222", text: "pong" }]);
    expect(getChannelCalls).toEqual([]);
  });

  it("an allowlisted DM user id never widens guild, channel, or thread access", async () => {
    const { transport, replies, clients, getChannelCalls } = buildTransport({ allowedDmUserIds: ["user-1"] });

    // Non-allowlisted guild, non-allowlisted channel, and non-allowlisted
    // thread shapes from the allowlisted DM user must stay silent — and must
    // never trigger the DM metadata lookup because they carry a guild_id.
    await transport.handleMessage({ guild_id: "999", channel_id: "222", author: { id: "user-1" }, content: "ping" });
    await transport.handleMessage({ guild_id: "111", channel_id: "888", author: { id: "user-1" }, content: "ping" });
    await transport.handleMessage({ guild_id: "111", channel_id: "222", thread_id: "999", author: { id: "user-1" }, content: "ping" });

    expect(replies).toEqual([]);
    expect(clients).toHaveLength(0);
    expect(getChannelCalls).toEqual([]);
  });
});
