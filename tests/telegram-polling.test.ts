import { describe, expect, it } from "vitest";
import { runTelegramPolling, TelegramTransport } from "../src/telegram-transport.js";
import type { RpcEvent } from "../src/gateway-rpc.js";
import type { TelegramUpdate } from "../src/telegram-transport.js";

class FakeTelegramClient {
  prompts: string[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async abort(): Promise<void> {}
  async promptAndWait(message: string): Promise<RpcEvent[]> {
    this.prompts.push(message);
    return [
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: message } },
      { type: "agent_end" },
    ];
  }
}

function buildTransport(): { transport: TelegramTransport<FakeTelegramClient>; replies: string[] } {
  const replies: string[] = [];
  const transport = new TelegramTransport<FakeTelegramClient>({
    transportName: "telegram",
    allowedChatIds: [1],
    runnableAgents: ["piren"],
    defaultAgent: "piren",
    targetBuilder: async () => ({ command: "fake", args: [], cwd: process.cwd(), env: process.env }),
    clientFactory: () => new FakeTelegramClient(),
    api: { async sendMessage(_chatId, text) { replies.push(text); } },
  });
  return { transport, replies };
}

describe("runTelegramPolling", () => {
  it("advances the getUpdates offset to update_id + 1 and forwards updates to the transport", async () => {
    const { transport, replies } = buildTransport();
    const controller = new AbortController();
    const offsets: Array<number | undefined> = [];
    let batches = 0;
    const api = {
      async sendMessage(chatId: number | string, text: string): Promise<void> {
        await transport["api"].sendMessage(chatId, text);
      },
      async getUpdates(offset: number | undefined, _timeoutSeconds: number): Promise<TelegramUpdate[]> {
        offsets.push(offset);
        batches += 1;
        if (batches === 1) {
          return [
            { update_id: 10, message: { chat: { id: 1 }, text: "first" } },
            { update_id: 11, message: { chat: { id: 1 }, text: "second" } },
          ];
        }
        controller.abort();
        return [];
      },
    };

    await runTelegramPolling({ api, transport, signal: controller.signal });

    expect(offsets).toEqual([undefined, 12]);
    expect(replies).toEqual(["first", "second"]);
  });

  it("calls onError on a recoverable getUpdates failure and keeps polling", async () => {
    const { transport, replies } = buildTransport();
    const controller = new AbortController();
    const errors: string[] = [];
    let calls = 0;
    const api = {
      async sendMessage(chatId: number | string, text: string): Promise<void> {
        await transport["api"].sendMessage(chatId, text);
      },
      async getUpdates(_offset: number | undefined, _timeoutSeconds: number): Promise<TelegramUpdate[]> {
        calls += 1;
        if (calls === 1) throw new Error("transient telegram 502");
        controller.abort();
        return [];
      },
    };

    await runTelegramPolling({
      api,
      transport,
      signal: controller.signal,
      onError: (error) => errors.push(error.message),
    });

    expect(errors).toEqual(["transient telegram 502"]);
    expect(replies).toEqual([]);
  });

  it("rethrows when no onError handler is provided", async () => {
    const { transport } = buildTransport();
    const controller = new AbortController();
    const api = {
      async sendMessage(): Promise<void> {},
      async getUpdates(): Promise<TelegramUpdate[]> {
        throw new Error("fatal");
      },
    };

    await expect(
      runTelegramPolling({ api, transport, signal: controller.signal }),
    ).rejects.toThrow("fatal");
  });
});
