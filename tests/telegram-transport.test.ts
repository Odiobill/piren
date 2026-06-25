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
      api: {
        async sendMessage(chatId, text) {
          replies.push({ chatId, text });
        },
      },
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
      api: { async sendMessage(_chatId, text) { replies.push(text); } },
    });

    await transport.handleUpdate({ message: { chat: { id: 1 }, text: "give me a long answer" } });

    expect(replies).toHaveLength(2);
    for (const reply of replies) {
      expect(reply.length).toBeLessThanOrEqual(4000);
    }
    expect(replies.join("")).toBe(longText.trim());
  });
});
