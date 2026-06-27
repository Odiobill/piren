import { describe, expect, it } from "vitest";
import { TelegramTransport } from "../src/telegram-transport.js";
import type { RpcEvent } from "../src/gateway-rpc.js";

class FakeTelegramClient {
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
    // Completion reaction swapped in after the turn.
    expect(reactions.some((r) => r.messageId === 555 && r.emoji === "✅")).toBe(true);
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
