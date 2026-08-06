import { describe, expect, it } from "vitest";
import { TelegramTransport, type TelegramUpdate } from "../src/telegram-transport.js";
import { DiscordTransport, type DiscordMessage } from "../src/discord-transport.js";
import { TELEGRAM_MESSAGE_LIMIT, chunkTelegramMessage } from "../src/telegram-transport.js";
import { DISCORD_MESSAGE_LIMIT, chunkDiscordMessage } from "../src/discord-transport.js";
import type { GatewayFallbackPolicy } from "../src/model-fallback-gateway.js";
import type { RpcEvent } from "../src/gateway-rpc.js";

// TB7 — Telegram/Discord transport same-live-client model fallback with
// bounded platform advisory notices (design §8 TB7, §4.2/§4.3, §5, §6.4, §7).
// Fake transport clients/APIs and injected policy loaders; no live Pi auth.

const POLICY: GatewayFallbackPolicy = {
  primaryModelId: "kimi-coding/k3",
  fallback: { ok: true, present: true, config: { autoSwitch: true, models: ["openai/gpt-4.1"] } },
};

function policyWith(models: string[], autoSwitch = true): GatewayFallbackPolicy {
  return { primaryModelId: "kimi-coding/k3", fallback: { ok: true, present: true, config: { autoSwitch, models } } };
}

const NO_PRIMARY: GatewayFallbackPolicy = {
  primaryModelId: null,
  fallback: { ok: true, present: true, config: { autoSwitch: true, models: ["openai/gpt-4.1"] } },
};

function errorRecord(): Record<string, unknown> {
  return { role: "assistant", content: [], stopReason: "error", errorMessage: "provider error (401)" };
}

function providerErrorEvents(retryExhausted: boolean): RpcEvent[] {
  const record = errorRecord();
  const events: RpcEvent[] = [{ type: "agent_start" }];
  if (retryExhausted) {
    events.push(
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "529 overloaded" },
      { type: "auto_retry_end", attempt: 3, maxAttempts: 3, success: false, finalError: "529 overloaded" },
    );
  }
  events.push(
    { type: "message_start", message: record },
    { type: "message_end", message: record },
    { type: "turn_end", message: { ...record, toolResults: [] } },
    { type: "agent_end", messages: [record], willRetry: false },
    { type: "agent_settled" },
  );
  return events;
}

function contaminatedEvents(): RpcEvent[] {
  const record = errorRecord();
  return [
    { type: "agent_start" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial" } },
    { type: "message_start", message: record },
    { type: "message_end", message: record },
    { type: "turn_end", message: { ...record, toolResults: [] } },
    { type: "agent_end", messages: [record], willRetry: false },
    { type: "agent_settled" },
  ];
}

function normalEvents(delta: string): RpcEvent[] {
  return [
    { type: "agent_start" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } },
    { type: "agent_end", messages: [], willRetry: false },
    { type: "agent_settled" },
  ];
}

/** Scripted fake client satisfying both transport prompt-client surfaces. */
class FakePromptClient {
  prompts: string[] = [];
  scripts: RpcEvent[][] = [];
  setModelCalls: Array<{ provider: string; modelId: string }> = [];
  rejectSetModelIds: string[] = [];
  hasSetModel = true;
  started = 0;
  stopped = 0;
  aborts = 0;

  async start(): Promise<void> {
    this.started += 1;
  }
  async stop(): Promise<void> {
    this.stopped += 1;
  }
  async abort(): Promise<void> {
    this.aborts += 1;
  }
  async newSession(): Promise<{ cancelled: boolean }> {
    return { cancelled: false };
  }
  async compact(): Promise<{ tokensBefore: number | null; estimatedTokensAfter: number | null }> {
    return { tokensBefore: 1, estimatedTokensAfter: 1 };
  }
  async promptAndWait(message: string): Promise<RpcEvent[]> {
    this.prompts.push(message);
    return this.scripts.shift() ?? [];
  }
  async setModel(provider: string, modelId: string): Promise<unknown> {
    this.setModelCalls.push({ provider, modelId });
    if (!this.hasSetModel) throw new Error("RPC client does not support set_model");
    if (this.rejectSetModelIds.includes(`${provider}/${modelId}`)) throw new Error("model not found");
    return { provider, modelId };
  }
}

interface TelegramHarness {
  transport: TelegramTransport<FakePromptClient>;
  clients: FakePromptClient[];
  messages: Array<{ chatId: number | string; text: string; threadId?: number }>;
  chatActions: Array<{ chatId: number | string; action: string; threadId?: number }>;
  reactions: Array<{ chatId: number | string; messageId: number; emoji: string }>;
  loaderCalls: string[];
}

function makeTelegram(options?: { policy?: GatewayFallbackPolicy; topic?: boolean }): TelegramHarness {
  const client = new FakePromptClient();
  const clients: FakePromptClient[] = [client];
  const messages: TelegramHarness["messages"] = [];
  const chatActions: TelegramHarness["chatActions"] = [];
  const reactions: TelegramHarness["reactions"] = [];
  const loaderCalls: string[] = [];
  const transport = new TelegramTransport<FakePromptClient>({
    allowedChatIds: [111],
    runnableAgents: ["kimi"],
    defaultAgent: "kimi",
    targetBuilder: async (agent) => ({ command: "fake", args: [agent], cwd: process.cwd(), env: process.env }),
    clientFactory: () => client,
    api: {
      async sendMessage(chatId, text, messageThreadId) {
        messages.push(messageThreadId === undefined ? { chatId, text } : { chatId, text, threadId: messageThreadId });
      },
      async sendChatAction(chatId, action, messageThreadId) {
        chatActions.push(messageThreadId === undefined ? { chatId, action } : { chatId, action, threadId: messageThreadId });
      },
      async setMessageReaction(chatId, messageId, emoji) {
        reactions.push({ chatId, messageId, emoji });
      },
    },
    fallbackPolicyLoader: async (agent) => {
      loaderCalls.push(agent);
      return options?.policy ?? POLICY;
    },
  });
  return { transport, clients, messages, chatActions, reactions, loaderCalls };
}

function tgUpdate(text: string, options?: { threadId?: number; messageId?: number }): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: options?.messageId ?? 42,
      chat: { id: 111 },
      text,
      ...(options?.threadId !== undefined ? { message_thread_id: options.threadId } : {}),
    },
  };
}

interface DiscordHarness {
  transport: DiscordTransport<FakePromptClient>;
  clients: FakePromptClient[];
  replies: Array<{ channelId: string; text: string }>;
  loaderCalls: string[];
}

function makeDiscord(options?: { policy?: GatewayFallbackPolicy }): DiscordHarness {
  const client = new FakePromptClient();
  const clients: FakePromptClient[] = [client];
  const replies: DiscordHarness["replies"] = [];
  const loaderCalls: string[] = [];
  const transport = new DiscordTransport<FakePromptClient>({
    allowedGuildIds: ["111"],
    allowedChannelIds: ["222"],
    runnableAgents: ["kimi"],
    defaultAgent: "kimi",
    targetBuilder: async (agent) => ({ command: "fake", args: [agent], cwd: process.cwd(), env: process.env }),
    clientFactory: () => client,
    api: {
      async createMessage(channelId, text) {
        replies.push({ channelId, text });
      },
      async sendTyping() {},
      async addReaction() {},
      async getChannel(channelId) {
        return { id: channelId, type: 1 };
      },
      async respondToInteraction() {},
    },
    fallbackPolicyLoader: async (agent) => {
      loaderCalls.push(agent);
      return options?.policy ?? POLICY;
    },
  });
  return { transport, clients, replies, loaderCalls };
}

function dcMessage(text: string): DiscordMessage {
  return {
    id: "m1",
    channel_id: "222",
    guild_id: "111",
    author: { id: "u1" },
    content: text,
  };
}

describe("TelegramTransport TB7 model fallback", () => {
  it("eligible provider_error_other: one same-client switch + handoff re-prompt, advisory before the reply", async () => {
    const { transport, clients, messages, loaderCalls } = makeTelegram();
    const client = clients[0]!;
    client.scripts = [providerErrorEvents(false), normalEvents("Fbk openai/gpt-4.1")];

    await transport.handleUpdate(tgUpdate("Please review the vault."));

    expect(loaderCalls).toEqual(["kimi"]);
    expect(client.setModelCalls).toEqual([{ provider: "openai", modelId: "gpt-4.1" }]);
    expect(client.prompts).toHaveLength(2);
    expect(client.prompts[1]).toContain("[model fallback:");
    expect(client.prompts[1]).toContain("Please review the vault.");
    expect(messages.map((m) => m.text)).toEqual([
      "[model fallback: kimi-coding/k3 failed (provider_error_other) → openai/gpt-4.1]",
      "Fbk openai/gpt-4.1",
    ]);
    // No secrets or raw error text in platform messages.
    for (const message of messages) {
      expect(message.text).not.toContain("401");
      expect(message.text).not.toContain("provider error (401)");
      expect(message.text).not.toMatch(/api[_-]?key|secret|token/i);
    }
  });

  it("transient-exhausted streams its honest category", async () => {
    const { transport, clients, messages } = makeTelegram();
    clients[0]!.scripts = [providerErrorEvents(true), normalEvents("Fbk openai/gpt-4.1")];
    await transport.handleUpdate(tgUpdate("review"));
    expect(messages[0]!.text).toBe(
      "[model fallback: kimi-coding/k3 failed (provider_error_transient_exhausted) → openai/gpt-4.1]",
    );
  });

  it("multi-fallback: rejected set_model is a visible unavailable skip with no original replay", async () => {
    const { transport, clients, messages } = makeTelegram({ policy: policyWith(["bogus/x", "openai/gpt-4.1"]) });
    const client = clients[0]!;
    client.scripts = [providerErrorEvents(false), normalEvents("Fbk openai/gpt-4.1")];
    client.rejectSetModelIds = ["bogus/x"];

    await transport.handleUpdate(tgUpdate("review"));

    expect(client.setModelCalls).toEqual([
      { provider: "bogus", modelId: "x" },
      { provider: "openai", modelId: "gpt-4.1" },
    ]);
    // Exactly two runs: the original plus ONE handoff re-prompt.
    expect(client.prompts).toHaveLength(2);
    expect(messages.map((m) => m.text)).toEqual([
      "[model fallback: kimi-coding/k3 failed (provider_error_other) → bogus/x]",
      "[model fallback: bogus/x unavailable; skipping]",
      "[model fallback: kimi-coding/k3 failed (provider_error_other) → openai/gpt-4.1]",
      "Fbk openai/gpt-4.1",
    ]);
  });

  it("terminal exhaustion sends the bounded terminal notice and no empty-reply message", async () => {
    const { transport, clients, messages } = makeTelegram({ policy: policyWith(["bogus/x"]) });
    const client = clients[0]!;
    client.scripts = [providerErrorEvents(false)];
    client.rejectSetModelIds = ["bogus/x"];

    await transport.handleUpdate(tgUpdate("review"));

    expect(client.prompts).toEqual([expect.stringContaining("review")]);
    expect(client.setModelCalls).toEqual([{ provider: "bogus", modelId: "x" }]);
    expect(messages.map((m) => m.text)).toEqual([
      "[model fallback: kimi-coding/k3 failed (provider_error_other) → bogus/x]",
      "[model fallback: bogus/x unavailable; skipping]",
      "[model fallback: exhausted after 1 attempt(s) on kimi-coding/k3 (provider_error_other)]",
    ]);
    expect(messages.some((m) => m.text === "(no assistant text returned)")).toBe(false);
  });

  it("contaminated run never falls back; existing reply semantics with no advisory", async () => {
    const { transport, clients, messages } = makeTelegram();
    clients[0]!.scripts = [contaminatedEvents()];
    await transport.handleUpdate(tgUpdate("review"));
    expect(clients[0]!.setModelCalls).toEqual([]);
    expect(clients[0]!.prompts).toHaveLength(1);
    expect(messages.map((m) => m.text)).toEqual(["Partial"]);
  });

  it("prompt rejection / timeout propagates with no fallback and no advisory", async () => {
    const { transport, clients, messages } = makeTelegram();
    const client = clients[0]!;
    client.scripts = [];
    client.promptAndWait = async (message: string) => {
      client.prompts.push(message);
      throw new Error("Timed out waiting for agent_settled.");
    };
    await expect(transport.handleUpdate(tgUpdate("review"))).rejects.toThrow("Timed out");
    expect(client.setModelCalls).toEqual([]);
    expect(messages).toEqual([]);
  });

  it("absent/malformed/disabled/no-primary policy stays inert", async () => {
    for (const policy of [NO_PRIMARY, policyWith(["openai/gpt-4.1"], false)]) {
      const { transport, clients, messages } = makeTelegram({ policy });
      clients[0]!.scripts = [normalEvents("Hello")];
      await transport.handleUpdate(tgUpdate("hi"));
      expect(clients[0]!.setModelCalls).toEqual([]);
      expect(clients[0]!.prompts).toHaveLength(1);
      expect(messages.map((m) => m.text)).toEqual(["Hello"]);
    }
  });

  it("topic messages keep the advisory and reply in the originating topic", async () => {
    const { transport, clients, messages } = makeTelegram();
    clients[0]!.scripts = [providerErrorEvents(false), normalEvents("Fbk openai/gpt-4.1")];
    await transport.handleUpdate(tgUpdate("review", { threadId: 77 }));
    for (const message of messages) {
      expect(message.threadId).toBe(77);
    }
  });

  it("fallback reply chunks respect the Telegram message limit", async () => {
    const { transport, clients, messages } = makeTelegram();
    const longReply = "word ".repeat(2000); // ~10000 chars > limit
    clients[0]!.scripts = [providerErrorEvents(false), normalEvents(longReply)];
    await transport.handleUpdate(tgUpdate("review"));
    const replyChunks = messages.slice(1).map((m) => m.text);
    // The transport trims the assistant text; the chunks rejoin to the trimmed payload.
    expect(replyChunks.join("")).toBe(longReply.trim());
    for (const chunk of replyChunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    }
    expect(chunkTelegramMessage(longReply).join("")).toBe(longReply);
  });

  it("receipt/typing/completion feedback still fires and never suppresses the advisory+reply", async () => {
    const { transport, clients, messages, chatActions, reactions } = makeTelegram();
    clients[0]!.scripts = [providerErrorEvents(false), normalEvents("Fbk openai/gpt-4.1")];
    await transport.handleUpdate(tgUpdate("review"));
    // Default feedback: receipt reaction + typing + completion reaction.
    expect(reactions.length).toBeGreaterThanOrEqual(1);
    expect(chatActions.some((action) => action.action === "typing")).toBe(true);
    expect(messages.map((m) => m.text).filter((text) => text.startsWith("[model fallback:"))).toHaveLength(1);
    expect(messages.some((m) => m.text === "Fbk openai/gpt-4.1")).toBe(true);
  });

  it("successful fallback keeps session affinity for a subsequent ordinary message", async () => {
    const { transport, clients } = makeTelegram();
    const client = clients[0]!;
    client.scripts = [providerErrorEvents(false), normalEvents("Fbk openai/gpt-4.1")];
    await transport.handleUpdate(tgUpdate("first"));
    // Second ordinary message on the SAME conversation reuses the same client
    // (no respawn, no new session): it must still run with the fallback model.
    client.scripts = [normalEvents("second reply")];
    await transport.handleUpdate(tgUpdate("second"));
    expect(clients).toHaveLength(1);
    expect(client.prompts).toHaveLength(3);
    expect(client.prompts[2]).toBe("second");
    expect(client.setModelCalls).toHaveLength(1);
  });
});

describe("DiscordTransport TB7 model fallback", () => {
  it("eligible provider_error_other: one same-client switch + handoff re-prompt, advisory before the reply", async () => {
    const { transport, clients, replies, loaderCalls } = makeDiscord();
    const client = clients[0]!;
    client.scripts = [providerErrorEvents(false), normalEvents("Fbk openai/gpt-4.1")];

    await transport.handleMessage(dcMessage("Please review the vault."));

    expect(loaderCalls).toEqual(["kimi"]);
    expect(client.setModelCalls).toEqual([{ provider: "openai", modelId: "gpt-4.1" }]);
    expect(client.prompts).toHaveLength(2);
    expect(client.prompts[1]).toContain("[model fallback:");
    expect(client.prompts[1]).toContain("Please review the vault.");
    expect(replies.map((r) => r.text)).toEqual([
      "[model fallback: kimi-coding/k3 failed (provider_error_other) → openai/gpt-4.1]",
      "Fbk openai/gpt-4.1",
    ]);
    for (const reply of replies) {
      expect(reply.text).not.toContain("401");
      expect(reply.text).not.toMatch(/api[_-]?key|secret|token/i);
    }
  });

  it("terminal exhaustion sends the bounded terminal notice with no loop", async () => {
    const { transport, clients, replies } = makeDiscord({ policy: policyWith(["bogus/x", "bogus/y"]) });
    const client = clients[0]!;
    client.scripts = [providerErrorEvents(false)];
    client.rejectSetModelIds = ["bogus/x", "bogus/y"];

    await transport.handleMessage(dcMessage("review"));

    expect(client.prompts).toHaveLength(1);
    expect(client.setModelCalls).toEqual([
      { provider: "bogus", modelId: "x" },
      { provider: "bogus", modelId: "y" },
    ]);
    expect(replies.map((r) => r.text)).toEqual([
      "[model fallback: kimi-coding/k3 failed (provider_error_other) → bogus/x]",
      "[model fallback: bogus/x unavailable; skipping]",
      "[model fallback: kimi-coding/k3 failed (provider_error_other) → bogus/y]",
      "[model fallback: bogus/y unavailable; skipping]",
      "[model fallback: exhausted after 2 attempt(s) on kimi-coding/k3 (provider_error_other)]",
    ]);
  });

  it("fallback reply chunks respect the Discord message limit", async () => {
    const { transport, clients, replies } = makeDiscord();
    const longReply = "word ".repeat(800); // ~4000 chars > limit
    clients[0]!.scripts = [providerErrorEvents(false), normalEvents(longReply)];
    await transport.handleMessage(dcMessage("review"));
    const replyChunks = replies.slice(1).map((r) => r.text);
    expect(replyChunks.join("")).toBe(longReply.trim());
    for (const chunk of replyChunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    }
    expect(chunkDiscordMessage(longReply).join("")).toBe(longReply);
  });

  it("non-allowlisted channel stays rejected (no fallback work, no reply)", async () => {
    const { transport, clients, replies } = makeDiscord();
    await transport.handleMessage({ id: "m9", channel_id: "999", guild_id: "111", author: { id: "u1" }, content: "review" });
    expect(clients[0]!.prompts).toHaveLength(0);
    expect(clients[0]!.setModelCalls).toEqual([]);
    expect(replies).toHaveLength(0);
  });

  it("contaminated run never falls back; existing reply semantics with no advisory", async () => {
    const { transport, clients, replies } = makeDiscord();
    clients[0]!.scripts = [contaminatedEvents()];
    await transport.handleMessage(dcMessage("review"));
    expect(clients[0]!.setModelCalls).toEqual([]);
    expect(replies.map((r) => r.text)).toEqual(["Partial"]);
  });

  it("successful fallback keeps session affinity for a subsequent ordinary message", async () => {
    const { transport, clients, replies } = makeDiscord();
    const client = clients[0]!;
    client.scripts = [providerErrorEvents(false), normalEvents("Fbk openai/gpt-4.1")];
    await transport.handleMessage(dcMessage("first"));
    client.scripts = [normalEvents("second reply")];
    await transport.handleMessage(dcMessage("second"));
    expect(clients).toHaveLength(1);
    expect(client.prompts).toHaveLength(3);
    expect(client.setModelCalls).toHaveLength(1);
    expect(replies.some((r) => r.text === "second reply")).toBe(true);
  });
});
