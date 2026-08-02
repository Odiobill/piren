import { describe, expect, it, vi } from "vitest";
import { runDiscordGateway, type DiscordGatewaySocket, type GatewayMessage } from "../src/discord-transport.js";
import { DiscordTransport } from "../src/discord-transport.js";
import type { RpcEvent } from "../src/gateway-rpc.js";

class FakeDiscordClient {
  prompts: string[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async abort(): Promise<void> {}
  async newSession(): Promise<{ cancelled: boolean }> { return { cancelled: false }; }
  async compact(): Promise<{ tokensBefore: number | null; estimatedTokensAfter: number | null }> { return { tokensBefore: null, estimatedTokensAfter: null }; }
  async promptAndWait(message: string): Promise<RpcEvent[]> {
    this.prompts.push(message);
    return [
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "pong" } },
      { type: "agent_end" },
    ];
  }
}

function buildTransport(options?: { allowedDmUserIds?: string[] }) {
  const replies: string[] = [];
  const transport = new DiscordTransport<FakeDiscordClient>({
    transportName: "discord",
    allowedGuildIds: ["111"],
    allowedChannelIds: ["222"],
    allowedDmUserIds: options?.allowedDmUserIds,
    runnableAgents: ["piren"],
    defaultAgent: "piren",
    targetBuilder: async () => ({ command: "fake", args: [], cwd: process.cwd(), env: process.env }),
    clientFactory: () => new FakeDiscordClient(),
    api: {
      async createMessage(_channelId, text) { replies.push(text); },
      async sendTyping() {},
      async addReaction() {},
      async getChannel(channelId) { return { id: channelId, type: 1 }; },
      async respondToInteraction() {},
    },
  });
  return { transport, replies };
}

/** A minimal in-memory fake of the Discord gateway WebSocket. */
class FakeGatewaySocket implements DiscordGatewaySocket {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;
  openDelayMs = 0;

  /** Test helper: emit a gateway payload to the loop. */
  emit(payload: GatewayMessage): void {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(payload) });
  }
  /** Test helper: fire the open event. */
  triggerOpen(): void {
    if (this.onopen) this.onopen({});
  }

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    if (this.onclose) this.onclose({});
  }
  /** Test helper: simulate a server-side close (not initiated by the loop). */
  triggerClose(): void {
    if (this.onclose) this.onclose({});
  }
  /** Test helper: fire the error event. */
  triggerError(err: unknown): void {
    if (this.onerror) this.onerror(err);
  }
}

/** Injectable fake for the reconnect scheduling seam (no real timers). */
class FakeScheduler {
  pending: Array<{ handle: object; fn: () => void; delayMs: number }> = [];
  private nextId = 0;
  setTimeout(fn: () => void, delayMs: number): object {
    const handle = { id: ++this.nextId };
    this.pending.push({ handle, fn, delayMs });
    return handle;
  }
  clearTimeout(handle: unknown): void {
    this.pending = this.pending.filter((p) => p.handle !== handle);
  }
  runNext(): boolean {
    const next = this.pending.shift();
    if (!next) return false;
    next.fn();
    return true;
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function opPayload(op: number, extra: Record<string, unknown> = {}): GatewayMessage {
  return { op, ...extra } as GatewayMessage;
}

describe("runDiscordGateway", () => {
  it("sends Identify after Hello and dispatches MESSAGE_CREATE to the transport", async () => {
    const { transport, replies } = buildTransport();
    const socket = new FakeGatewaySocket();
    let started = false;
    const gateway = runDiscordGateway({
      botToken: "DISCORD-BOT-TOKEN",
      applicationId: "999",
      intents: 1,
      transport,
      socketFactory: () => Promise.resolve(socket),
      heartbeatIntervalMs: 60_000,
      onReady: () => {
        started = true;
      },
    });
    // kick the loop: open, then Hello
    await Promise.resolve();
    socket.triggerOpen();
    socket.emit(opPayload(10, { d: { heartbeat_interval: 60_000 } }));
    await gateway.identified();
    // Discord sends READY after a successful Identify.
    socket.emit(opPayload(0, { t: "READY", s: null, d: { user: { id: "999" } } }));
    await gateway.idle();
    // Now dispatch a message create event
    socket.emit(
      opPayload(0, { t: "MESSAGE_CREATE", s: 5, d: { guild_id: "111", channel_id: "222", content: "ping" } }),
    );
    await gateway.idle();
    await gateway.close();

    expect(started).toBe(true);
    // An Identify (op 2) was sent with the bot token.
    const identify = socket.sent.map((s) => JSON.parse(s)).find((m) => m.op === 2);
    expect(identify).toBeDefined();
    expect(identify.d.token).toBe("DISCORD-BOT-TOKEN");
    expect(replies).toEqual(["pong"]);
  });

  it("sends a heartbeat after the Hello interval and echoes the last sequence number", async () => {
    const { transport } = buildTransport();
    const socket = new FakeGatewaySocket();
    const gateway = runDiscordGateway({
      botToken: "TOK",
      applicationId: "1",
      intents: 1,
      transport,
      socketFactory: () => Promise.resolve(socket),
      heartbeatIntervalMs: 10,
    });
    await Promise.resolve();
    socket.triggerOpen();
    socket.emit(opPayload(10, { d: { heartbeat_interval: 10 } }));
    await gateway.identified();
    // send a MESSAGE_CREATE with sequence 42
    socket.emit(
      opPayload(0, { t: "MESSAGE_CREATE", s: 42, d: { guild_id: "111", channel_id: "222", content: "hi" } }),
    );
    await gateway.idle();
    // Wait long enough for at least one heartbeat tick (10ms interval)
    await new Promise((resolve) => setTimeout(resolve, 60));
    await gateway.close();

    const heartbeats = socket.sent.map((s) => JSON.parse(s)).filter((m) => m.op === 1);
    expect(heartbeats.length).toBeGreaterThan(0);
    // the last heartbeat should echo sequence 42
    expect(heartbeats[heartbeats.length - 1].d).toBe(42);
  });

  it("ignores dispatch events that are not MESSAGE_CREATE", async () => {
    const { transport, replies } = buildTransport();
    const socket = new FakeGatewaySocket();
    const gateway = runDiscordGateway({
      botToken: "TOK",
      applicationId: "1",
      intents: 1,
      transport,
      socketFactory: () => Promise.resolve(socket),
      heartbeatIntervalMs: 60_000,
    });
    await Promise.resolve();
    socket.triggerOpen();
    socket.emit(opPayload(10, { d: { heartbeat_interval: 60_000 } }));
    await gateway.identified();
    socket.emit(opPayload(0, { t: "PRESENCE_UPDATE", s: 1, d: {} }));
    socket.emit(opPayload(11)); // heartbeat ack
    await gateway.idle();
    await gateway.close();
    expect(replies).toEqual([]);
  });

  it("ignores messages authored by bots so replies do not trigger self-loops", async () => {
    const { transport, replies } = buildTransport();
    const socket = new FakeGatewaySocket();
    const gateway = runDiscordGateway({
      botToken: "TOK",
      applicationId: "1",
      intents: 1,
      transport,
      socketFactory: () => Promise.resolve(socket),
      heartbeatIntervalMs: 60_000,
    });
    await Promise.resolve();
    socket.triggerOpen();
    socket.emit(opPayload(10, { d: { heartbeat_interval: 60_000 } }));
    await gateway.identified();
    socket.emit(opPayload(0, { t: "MESSAGE_CREATE", s: 7, d: { guild_id: "111", channel_id: "222", content: "pong", author: { id: "1", bot: true } } }));
    await gateway.idle();
    await gateway.close();
    expect(replies).toEqual([]);
  });

  it("normalizes a direct-message MESSAGE_CREATE author id through to the transport (ADR-0040 D1)", async () => {
    const { transport, replies } = buildTransport({ allowedDmUserIds: ["user-1"] });
    const socket = new FakeGatewaySocket();
    const gateway = runDiscordGateway({
      botToken: "TOK",
      applicationId: "1",
      intents: 1,
      transport,
      socketFactory: () => Promise.resolve(socket),
      heartbeatIntervalMs: 60_000,
    });
    await Promise.resolve();
    socket.triggerOpen();
    socket.emit(opPayload(10, { d: { heartbeat_interval: 60_000 } }));
    await gateway.identified();
    // No guild_id: a one-to-one DM from an allowlisted user.
    socket.emit(opPayload(0, { t: "MESSAGE_CREATE", s: 8, d: { channel_id: "555", content: "ping", author: { id: "user-1" } } }));
    await gateway.idle();
    await gateway.close();
    expect(replies).toEqual(["pong"]);
  });
});

describe("Discord gateway intents (D1 review fix)", () => {
  it("declares DIRECT_MESSAGES alongside the existing guild intents", async () => {
    const { DISCORD_GATEWAY_INTENTS } = await import("../src/discord-transport.js");
    const GUILDS = 1 << 0;
    const GUILD_MESSAGES = 1 << 9;
    const DIRECT_MESSAGES = 1 << 12;
    const MESSAGE_CONTENT = 1 << 15;
    expect(DISCORD_GATEWAY_INTENTS & GUILDS).toBe(GUILDS);
    expect(DISCORD_GATEWAY_INTENTS & GUILD_MESSAGES).toBe(GUILD_MESSAGES);
    expect(DISCORD_GATEWAY_INTENTS & DIRECT_MESSAGES).toBe(DIRECT_MESSAGES);
    expect(DISCORD_GATEWAY_INTENTS & MESSAGE_CONTENT).toBe(MESSAGE_CONTENT);
    expect(DISCORD_GATEWAY_INTENTS).toBe(37377);
  });

  it("sends the full intent mask in the Identify payload", async () => {
    const { DISCORD_GATEWAY_INTENTS } = await import("../src/discord-transport.js");
    const { transport } = buildTransport();
    const socket = new FakeGatewaySocket();
    const gateway = runDiscordGateway({
      botToken: "TOK",
      applicationId: "1",
      intents: DISCORD_GATEWAY_INTENTS,
      transport,
      socketFactory: () => Promise.resolve(socket),
      heartbeatIntervalMs: 60_000,
    });
    await Promise.resolve();
    socket.triggerOpen();
    socket.emit(opPayload(10, { d: { heartbeat_interval: 60_000 } }));
    await gateway.identified();
    await gateway.close();
    const identify = socket.sent.map((raw) => JSON.parse(raw) as { op: number; d?: { intents?: number } }).find((p) => p.op === 2);
    expect(identify?.d?.intents).toBe(37377);
  });
});

describe("runDiscordGateway INTERACTION_CREATE (ADR-0040 D3)", () => {
  it("dispatches an authorized application-command interaction to the transport", async () => {
    const callbacks: Array<{ interactionId: string; content: string }> = [];
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
        async sendTyping() {},
        async addReaction() {},
        async getChannel(channelId) { return { id: channelId, type: 1 }; },
        async respondToInteraction(interactionId, _token, content) { callbacks.push({ interactionId, content }); },
      },
    });
    const socket = new FakeGatewaySocket();
    const gateway = runDiscordGateway({
      botToken: "TOK",
      applicationId: "1",
      intents: 1,
      transport,
      socketFactory: () => Promise.resolve(socket),
      heartbeatIntervalMs: 60_000,
    });
    await Promise.resolve();
    socket.triggerOpen();
    socket.emit(opPayload(10, { d: { heartbeat_interval: 60_000 } }));
    await gateway.identified();
    socket.emit(opPayload(0, {
      t: "INTERACTION_CREATE",
      s: 9,
      d: { id: "int-1", token: "int-token", type: 2, guild_id: "111", channel_id: "222", data: { name: "start" }, member: { user: { id: "user-9" } } },
    }));
    await gateway.idle();
    await gateway.close();
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]?.content).toContain("Piren Discord transport ready");
    expect(replies).toEqual([]);
  });
});

describe("runDiscordGateway reconnection lifecycle", () => {
  function buildReconnectingGateway(overrides?: {
    heartbeatIntervalMs?: number;
    reconnectMaxDelayMs?: number;
    factoryFailuresBeforeSuccess?: number;
  }) {
    const { transport, replies } = buildTransport();
    const scheduler = new FakeScheduler();
    const sockets: FakeGatewaySocket[] = [];
    let factoryCalls = 0;
    const failures = overrides?.factoryFailuresBeforeSuccess ?? 0;
    const socketFactory = () => {
      factoryCalls += 1;
      if (factoryCalls <= failures) return Promise.reject(new Error("connect failed"));
      const s = new FakeGatewaySocket();
      sockets.push(s);
      return Promise.resolve(s);
    };
    const errors: string[] = [];
    const reconnecting: Array<{ attempt: number; delayMs: number }> = [];
    let readyCount = 0;
    const gateway = runDiscordGateway({
      botToken: "TOK",
      applicationId: "1",
      intents: 1,
      transport,
      socketFactory,
      heartbeatIntervalMs: overrides?.heartbeatIntervalMs ?? 60_000,
      reconnectInitialDelayMs: 1_000,
      reconnectMaxDelayMs: overrides?.reconnectMaxDelayMs ?? 30_000,
      scheduler,
      onReady: () => {
        readyCount += 1;
      },
      onError: (error) => {
        errors.push(error.message);
      },
      onReconnecting: (info) => {
        reconnecting.push(info);
      },
    });
    return { gateway, transport, replies, scheduler, sockets, errors, reconnecting, readyCountRef: () => readyCount };
  }

  async function handshake(socket: FakeGatewaySocket): Promise<void> {
    socket.triggerOpen();
    socket.emit(opPayload(10, { d: { heartbeat_interval: 60_000 } }));
    await flushMicrotasks();
  }

  it("reconnects exactly once after an unexpected close; the replacement re-identifies and accepts events", async () => {
    const { gateway, scheduler, sockets, replies, reconnecting, readyCountRef } = buildReconnectingGateway();
    await flushMicrotasks();
    expect(sockets).toHaveLength(1);
    const first = sockets[0]!;
    await handshake(first);
    await gateway.identified();
    first.emit(opPayload(0, { t: "READY", s: 1, d: {} }));
    await gateway.idle();
    expect(readyCountRef()).toBe(1);

    // Unexpected server-side close: reconnect is scheduled, not immediate.
    first.triggerClose();
    expect(sockets).toHaveLength(1);
    expect(scheduler.pending).toHaveLength(1);
    expect(reconnecting).toEqual([{ attempt: 1, delayMs: 1_000 }]);

    scheduler.runNext();
    await flushMicrotasks();
    expect(sockets).toHaveLength(2);
    const second = sockets[1]!;
    await handshake(second);

    // The replacement runs a fresh handshake: a new Identify on the new socket.
    const secondIdentify = second.sent.map((raw) => JSON.parse(raw) as { op: number }).find((m) => m.op === 2);
    expect(secondIdentify).toBeDefined();
    second.emit(opPayload(0, { t: "READY", s: 1, d: {} }));
    expect(readyCountRef()).toBe(2);

    // The replacement accepts ordinary messages and interactions.
    second.emit(opPayload(0, { t: "MESSAGE_CREATE", s: 2, d: { guild_id: "111", channel_id: "222", content: "ping" } }));
    await gateway.idle();
    expect(replies).toEqual(["pong"]);

    await gateway.close();
    expect(scheduler.pending).toHaveLength(0);
  });

  it("treats an error/close pair for one connection as a single disconnect with one scheduled retry", async () => {
    const { gateway, scheduler, sockets, errors } = buildReconnectingGateway();
    await flushMicrotasks();
    const first = sockets[0]!;
    await handshake(first);
    await gateway.identified();

    first.triggerError(new Error("boom"));
    first.triggerClose(); // error and close for the same socket: one reconnect only
    expect(errors).toEqual(["boom"]);
    expect(scheduler.pending).toHaveLength(1);
    expect(sockets).toHaveLength(1);

    scheduler.runNext();
    await flushMicrotasks();
    expect(sockets).toHaveLength(2);
    // No second retry queued from the single disconnect.
    expect(scheduler.pending).toHaveLength(0);
    await gateway.close();
  });

  it("retries a socket-factory failure with capped exponential backoff and resets after READY", async () => {
    const { gateway, scheduler, sockets, reconnecting } = buildReconnectingGateway({
      factoryFailuresBeforeSuccess: 3,
      reconnectMaxDelayMs: 3_000,
    });
    await flushMicrotasks();
    expect(sockets).toHaveLength(0);
    expect(scheduler.pending).toHaveLength(1);
    expect(reconnecting).toEqual([{ attempt: 1, delayMs: 1_000 }]);

    scheduler.runNext(); // second attempt fails
    await flushMicrotasks();
    expect(reconnecting).toEqual([
      { attempt: 1, delayMs: 1_000 },
      { attempt: 2, delayMs: 2_000 },
    ]);

    scheduler.runNext(); // third attempt fails: 4000 capped to 3000
    await flushMicrotasks();
    expect(reconnecting).toEqual([
      { attempt: 1, delayMs: 1_000 },
      { attempt: 2, delayMs: 2_000 },
      { attempt: 3, delayMs: 3_000 },
    ]);

    scheduler.runNext(); // fourth attempt succeeds
    await flushMicrotasks();
    expect(sockets).toHaveLength(1);
    const socket = sockets[0]!;
    await handshake(socket);
    await gateway.identified();
    socket.emit(opPayload(0, { t: "READY", s: 1, d: {} }));
    await gateway.idle();

    // A successful READY resets the backoff: the next failure starts at the initial delay.
    socket.triggerClose();
    expect(reconnecting[reconnecting.length - 1]).toEqual({ attempt: 1, delayMs: 1_000 });
    scheduler.runNext();
    await flushMicrotasks();
    expect(sockets).toHaveLength(2);
    await gateway.close();
  });

  it("clears the old heartbeat and ignores stale socket events from the previous connection", async () => {
    const { gateway, scheduler, sockets, replies, readyCountRef } = buildReconnectingGateway({ heartbeatIntervalMs: 10 });
    await flushMicrotasks();
    const first = sockets[0]!;
    await handshake(first);
    await gateway.identified();
    first.emit(opPayload(0, { t: "READY", s: 1, d: {} }));
    await sleep(35);
    const heartbeatsOnFirst = (): number =>
      first.sent.map((raw) => JSON.parse(raw) as { op: number }).filter((m) => m.op === 1).length;
    expect(heartbeatsOnFirst()).toBeGreaterThan(0);

    first.triggerClose();
    scheduler.runNext();
    await flushMicrotasks();
    const second = sockets[1]!;
    await handshake(second);
    await gateway.identified();

    // The old heartbeat timer was cleared: the stale socket sends no more heartbeats.
    const staleCount = heartbeatsOnFirst();
    await sleep(40);
    expect(heartbeatsOnFirst()).toBe(staleCount);

    // Stale events from the old generation are inert: no READY, no dispatch, no new Identify.
    const readyBefore = readyCountRef();
    first.emit(opPayload(0, { t: "READY", s: 99, d: {} }));
    first.emit(opPayload(0, { t: "MESSAGE_CREATE", s: 100, d: { guild_id: "111", channel_id: "222", content: "stale" } }));
    first.emit(opPayload(10, { d: { heartbeat_interval: 10 } }));
    first.triggerClose(); // a late close from the superseded socket schedules nothing
    await gateway.idle();
    expect(readyCountRef()).toBe(readyBefore);
    expect(replies).toEqual([]);
    const staleIdentifies = first.sent.map((raw) => JSON.parse(raw) as { op: number }).filter((m) => m.op === 2);
    expect(staleIdentifies).toHaveLength(1);
    expect(scheduler.pending).toHaveLength(0);
    await gateway.close();
  });

  it("explicit close cancels a pending retry, prevents reconnects, and closes the transport exactly once", async () => {
    const { gateway, transport, scheduler, sockets } = buildReconnectingGateway();
    const closeSpy = vi.spyOn(transport, "close");
    await flushMicrotasks();
    const first = sockets[0]!;
    await handshake(first);
    await gateway.identified();

    first.triggerClose();
    expect(scheduler.pending).toHaveLength(1);

    await gateway.close();
    expect(scheduler.pending).toHaveLength(0); // retry cancelled
    expect(scheduler.runNext()).toBe(false); // nothing left to run
    await flushMicrotasks();
    expect(sockets).toHaveLength(1); // no reconnect happened
    expect(closeSpy).toHaveBeenCalledTimes(1);

    await gateway.close(); // idempotent
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
