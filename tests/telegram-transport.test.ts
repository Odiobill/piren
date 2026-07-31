import { describe, expect, it } from "vitest";
import { resolveTelegramConversationKey, TelegramTransport } from "../src/telegram-transport.js";
import type { RpcEvent } from "../src/gateway-rpc.js";

class FakeTelegramClient {
  prompts: string[] = [];
  aborts = 0;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async abort(): Promise<void> { this.aborts++; }
  async promptAndWait(message: string): Promise<RpcEvent[]> {
    this.prompts.push(message);
    return [
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "pong" } },
      { type: "agent_end" },
    ];
  }
}

/** A no-op API stub satisfying TelegramBotApi for tests that ignore feedback. */
function noopApi(sendMessage?: (c: number | string, t: string) => void | Promise<void>) {
  return {
    async sendMessage(chatId: number | string, text: string) {
      await sendMessage?.(chatId, text);
    },
    async sendChatAction() {},
    async setMessageReaction() {},
  };
}

describe("resolveTelegramConversationKey", () => {
  it("retains the current non-topic conversation ID byte-for-byte", () => {
    expect(resolveTelegramConversationKey(111)).toBe("111");
    expect(resolveTelegramConversationKey("111")).toBe("111");
    expect(resolveTelegramConversationKey(-1001234567890)).toBe("-1001234567890");
    // An explicit undefined thread id is the non-topic shape.
    expect(resolveTelegramConversationKey(111, undefined)).toBe("111");
  });

  it("produces a deterministic collision-safe distinct ID for a topic", () => {
    const topic = resolveTelegramConversationKey(111, 42);
    // Deterministic, pinned format.
    expect(topic).toBe("111:topic:42");
    expect(resolveTelegramConversationKey(111, 42)).toBe(topic);
    // Distinct from the plain chat-level key.
    expect(topic).not.toBe(String(111));
    // Distinct between topics in the same chat.
    expect(topic).not.toBe(resolveTelegramConversationKey(111, 43));
    // Distinct for the same topic id in a different chat.
    expect(topic).not.toBe(resolveTelegramConversationKey(222, 42));
  });
});

describe("TelegramTransport", () => {
  it("authorizes chat ids, exposes runnable agents, switches active agent, and forwards prompts", async () => {
    const replies: Array<{ chatId: number | string; text: string }> = [];
    const clients: FakeTelegramClient[] = [];
    const transport = new TelegramTransport<FakeTelegramClient>({
      transportName: "telegram",
      allowedChatIds: [111],
      runnableAgents: ["piren", "thor"],
      defaultAgent: "piren",
      targetBuilder: async (agent) => ({ command: "fake", args: [agent], cwd: process.cwd(), env: process.env }),
      clientFactory: () => {
        const client = new FakeTelegramClient();
        clients.push(client);
        return client;
      },
      api: noopApi(async (chatId, text) => { replies.push({ chatId, text }); }),
    });

    await transport.handleUpdate({ message: { chat: { id: 999 }, text: "/agents" } });
    expect(replies).toEqual([]);

    await transport.handleUpdate({ message: { chat: { id: 111 }, text: "/agents" } });
    await transport.handleUpdate({ message: { chat: { id: 111 }, text: "/agent thor" } });
    await transport.handleUpdate({ message: { chat: { id: 111 }, text: "ping" } });

    expect(replies.map((reply) => reply.text)).toEqual([
      "Runnable Piren agents: piren, thor\nActive agent: piren",
      "Active Piren agent for this chat: thor",
      "pong",
    ]);
    expect(clients).toHaveLength(1);
    expect(clients[0]?.prompts).toEqual(["ping"]);
  });

  it("splits a long assistant response into multiple Telegram messages", async () => {
    const replies: string[] = [];
    const longText = "alpha ".repeat(1000); // ~6000 chars
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
    const transport = new TelegramTransport<LongResponseClient>({
      transportName: "telegram",
      allowedChatIds: [1],
      runnableAgents: ["piren"],
      defaultAgent: "piren",
      targetBuilder: async () => ({ command: "fake", args: [], cwd: process.cwd(), env: process.env }),
      clientFactory: () => new LongResponseClient(),
      api: noopApi(async (_c, text) => { replies.push(text); }),
    });

    await transport.handleUpdate({ message: { chat: { id: 1 }, text: "give me a long answer" } });

    expect(replies).toHaveLength(2);
    for (const reply of replies) {
      expect(reply.length).toBeLessThanOrEqual(4000);
    }
    expect(replies.join("")).toBe(longText.trim());
  });

  it("sends a receipt reaction, typing, and a completion reaction around a prompt when feedback is on", async () => {
    const reactions: Array<{ chatId: number | string; messageId: number; emoji: string }> = [];
    const chatActions: Array<{ chatId: number | string; action: string }> = [];
    const clients: FakeTelegramClient[] = [];
    const transport = new TelegramTransport<FakeTelegramClient>({
      transportName: "telegram",
      allowedChatIds: [111],
      runnableAgents: ["piren"],
      defaultAgent: "piren",
      targetBuilder: async () => ({ command: "fake", args: [], cwd: process.cwd(), env: process.env }),
      clientFactory: () => {
        const client = new FakeTelegramClient();
        clients.push(client);
        return client;
      },
      api: {
        async sendMessage() {},
        async sendChatAction(chatId, action) { chatActions.push({ chatId, action }); },
        async setMessageReaction(chatId, messageId, emoji) { reactions.push({ chatId, messageId, emoji }); },
      },
    });

    await transport.handleUpdate({ message: { message_id: 555, chat: { id: 111 }, text: "ping" } });

    // Receipt reaction set immediately on the incoming message.
    expect(reactions.some((r) => r.messageId === 555 && r.emoji === "👀")).toBe(true);
    // Typing indicator sent during the turn.
    expect(chatActions.some((a) => a.action === "typing")).toBe(true);
    // Completion reaction swapped in after the turn. Telegram's default
    // completion reaction is 👍 (✅ is not a Telegram-valid reaction emoji).
    expect(reactions.some((r) => r.messageId === 555 && r.emoji === "👍")).toBe(true);
    // The prompt still reached the agent.
    expect(clients[0]?.prompts).toEqual(["ping"]);
  });

  it("does not send reactions or typing when feedback is disabled", async () => {
    const reactions: Array<{ messageId: number; emoji: string }> = [];
    const chatActions: string[] = [];
    const transport = new TelegramTransport<FakeTelegramClient>({
      transportName: "telegram",
      allowedChatIds: [111],
      runnableAgents: ["piren"],
      defaultAgent: "piren",
      feedback: { enabled: false },
      targetBuilder: async () => ({ command: "fake", args: [], cwd: process.cwd(), env: process.env }),
      clientFactory: () => new FakeTelegramClient(),
      api: {
        async sendMessage() {},
        async sendChatAction(_c, action) { chatActions.push(action); },
        async setMessageReaction(_c, messageId, emoji) { reactions.push({ messageId, emoji }); },
      },
    });

    await transport.handleUpdate({ message: { message_id: 999, chat: { id: 111 }, text: "ping" } });

    expect(reactions).toHaveLength(0);
    expect(chatActions).toHaveLength(0);
  });

  it("feedback failures never abort the turn: the response is still sent", async () => {
    const replies: string[] = [];
    const transport = new TelegramTransport<FakeTelegramClient>({
      transportName: "telegram",
      allowedChatIds: [111],
      runnableAgents: ["piren"],
      defaultAgent: "piren",
      targetBuilder: async () => ({ command: "fake", args: [], cwd: process.cwd(), env: process.env }),
      clientFactory: () => new FakeTelegramClient(),
      api: {
        async sendMessage(_c, text) { replies.push(text); },
        async sendChatAction() { throw new Error("typing failed"); },
        async setMessageReaction() { throw new Error("reaction failed"); },
      },
    });

    await transport.handleUpdate({ message: { message_id: 5, chat: { id: 111 }, text: "ping" } });

    // The turn completed and the assistant response was sent despite feedback failures.
    expect(replies).toEqual(["pong"]);
  });
});

describe("TelegramTransport forum topics (T1b)", () => {
  interface RecordedMessage { chatId: number | string; text: string; threadId?: number }
  interface RecordedChatAction { chatId: number | string; action: string; threadId?: number }

  function recordingApi(record: {
    messages?: RecordedMessage[];
    chatActions?: RecordedChatAction[];
    reactions?: Array<{ chatId: number | string; messageId: number; emoji: string }>;
  }) {
    return {
      async sendMessage(chatId: number | string, text: string, messageThreadId?: number) {
        record.messages?.push(messageThreadId === undefined ? { chatId, text } : { chatId, text, threadId: messageThreadId });
      },
      async sendChatAction(chatId: number | string, action: string, messageThreadId?: number) {
        record.chatActions?.push(messageThreadId === undefined ? { chatId, action } : { chatId, action, threadId: messageThreadId });
      },
      async setMessageReaction(chatId: number | string, messageId: number, emoji: string) {
        record.reactions?.push({ chatId, messageId, emoji });
      },
    };
  }

  function makeTransport(clients: FakeTelegramClient[], api: ReturnType<typeof recordingApi>) {
    return new TelegramTransport<FakeTelegramClient>({
      transportName: "telegram",
      allowedChatIds: [111],
      runnableAgents: ["piren", "thor"],
      defaultAgent: "piren",
      targetBuilder: async (agent) => ({ command: "fake", args: [agent], cwd: process.cwd(), env: process.env }),
      clientFactory: () => {
        const client = new FakeTelegramClient();
        clients.push(client);
        return client;
      },
      api,
    });
  }

  it("gives two topics in one allowlisted forum chat separate sessions and reuses each topic's client", async () => {
    const clients: FakeTelegramClient[] = [];
    const messages: RecordedMessage[] = [];
    const transport = makeTransport(clients, recordingApi({ messages }));

    await transport.handleUpdate({ message: { chat: { id: 111 }, message_thread_id: 42, text: "one" } });
    await transport.handleUpdate({ message: { chat: { id: 111 }, message_thread_id: 43, text: "two" } });
    await transport.handleUpdate({ message: { chat: { id: 111 }, message_thread_id: 42, text: "three" } });

    // Two topics -> two RPC clients; a repeated prompt in topic 42 reuses only topic 42's client.
    expect(clients).toHaveLength(2);
    expect(clients[0]?.prompts).toEqual(["one", "three"]);
    expect(clients[1]?.prompts).toEqual(["two"]);

    // Every reply lands in its originating topic.
    expect(messages).toEqual([
      { chatId: 111, text: "pong", threadId: 42 },
      { chatId: 111, text: "pong", threadId: 43 },
      { chatId: 111, text: "pong", threadId: 42 },
    ]);
  });

  it("scopes /agent, /whoami, and /abort to the topic", async () => {
    const clients: FakeTelegramClient[] = [];
    const messages: RecordedMessage[] = [];
    const transport = makeTransport(clients, recordingApi({ messages }));

    // Create a session in both topics first.
    await transport.handleUpdate({ message: { chat: { id: 111 }, message_thread_id: 42, text: "ping" } });
    await transport.handleUpdate({ message: { chat: { id: 111 }, message_thread_id: 43, text: "ping" } });
    expect(clients).toHaveLength(2);

    // Switch agent in topic 42 only.
    await transport.handleUpdate({ message: { chat: { id: 111 }, message_thread_id: 42, text: "/agent thor" } });
    await transport.handleUpdate({ message: { chat: { id: 111 }, message_thread_id: 42, text: "/whoami" } });
    await transport.handleUpdate({ message: { chat: { id: 111 }, message_thread_id: 43, text: "/whoami" } });

    expect(messages).toEqual([
      { chatId: 111, text: "pong", threadId: 42 },
      { chatId: 111, text: "pong", threadId: 43 },
      { chatId: 111, text: "Active Piren agent for this chat: thor", threadId: 42 },
      { chatId: 111, text: "Active Piren agent: thor", threadId: 42 },
      { chatId: 111, text: "Active Piren agent: piren", threadId: 43 },
    ]);

    // The topic-42 /agent switch swapped in a new client; abort in topic 42
    // aborts only that topic's current client, never topic 43's.
    expect(clients).toHaveLength(3);
    await transport.handleUpdate({ message: { chat: { id: 111 }, message_thread_id: 42, text: "/abort" } });
    expect(clients[0]?.aborts).toBe(0); // topic 42's pre-switch piren client
    expect(clients[2]?.aborts).toBe(1); // topic 42's current thor client
    expect(clients[1]?.aborts).toBe(0); // topic 43's client
    expect(messages[messages.length - 1]).toEqual({ chatId: 111, text: "Abort sent to active Piren session.", threadId: 42 });
  });

  it("carries the topic id on /start, /agents, unknown-command replies, and typing feedback", async () => {
    const clients: FakeTelegramClient[] = [];
    const messages: RecordedMessage[] = [];
    const chatActions: RecordedChatAction[] = [];
    const reactions: Array<{ chatId: number | string; messageId: number; emoji: string }> = [];
    const transport = makeTransport(clients, recordingApi({ messages, chatActions, reactions }));

    await transport.handleUpdate({ message: { chat: { id: 111 }, message_thread_id: 42, text: "/start" } });
    await transport.handleUpdate({ message: { chat: { id: 111 }, message_thread_id: 42, text: "/agents" } });
    await transport.handleUpdate({ message: { chat: { id: 111 }, message_thread_id: 42, text: "/bogus" } });

    expect(messages.map((m) => m.threadId)).toEqual([42, 42, 42]);
    expect(messages[0]?.text).toContain("Piren Telegram transport ready");
    expect(messages[1]?.text).toContain("Runnable Piren agents");
    expect(messages[2]?.text).toContain("Unknown Piren command");

    // Typing feedback during a topic prompt carries the topic id.
    await transport.handleUpdate({ message: { message_id: 555, chat: { id: 111 }, message_thread_id: 42, text: "ping" } });
    expect(chatActions).toEqual([{ chatId: 111, action: "typing", threadId: 42 }]);
    // Reactions stay attached to the received message exactly as before (no topic routing).
    expect(reactions.some((r) => r.messageId === 555 && r.emoji === "👀")).toBe(true);
    expect(reactions.some((r) => r.messageId === 555 && r.emoji === "👍")).toBe(true);
  });

  it("keeps a non-topic chat byte-for-byte on the chat-level key and stays silent for an unallowlisted forum chat", async () => {
    const clients: FakeTelegramClient[] = [];
    const messages: RecordedMessage[] = [];
    const chatActions: RecordedChatAction[] = [];
    const transport = makeTransport(clients, recordingApi({ messages, chatActions }));

    // Unallowlisted forum chat: silent, no session.
    await transport.handleUpdate({ message: { chat: { id: 999 }, message_thread_id: 42, text: "ping" } });
    expect(messages).toEqual([]);
    expect(clients).toHaveLength(0);

    // Non-topic chat: unchanged behavior, no thread context on any outbound call.
    await transport.handleUpdate({ message: { message_id: 7, chat: { id: 111 }, text: "/agents" } });
    await transport.handleUpdate({ message: { message_id: 8, chat: { id: 111 }, text: "ping" } });
    await transport.handleUpdate({ message: { message_id: 9, chat: { id: 111 }, text: "again" } });

    expect(clients).toHaveLength(1);
    expect(clients[0]?.prompts).toEqual(["ping", "again"]);
    expect(messages.every((m) => m.threadId === undefined)).toBe(true);
    expect(chatActions.every((a) => a.threadId === undefined)).toBe(true);
    expect(messages.map((m) => m.text)).toEqual([
      "Runnable Piren agents: piren, thor\nActive agent: piren",
      "pong",
      "pong",
    ]);
  });
});
