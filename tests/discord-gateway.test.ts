import { describe, expect, it } from "vitest";
import { runDiscordGateway, type DiscordGatewaySocket, type GatewayMessage } from "../src/discord-transport.js";
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

function buildTransport() {
  const replies: string[] = [];
  const transport = new DiscordTransport<FakeDiscordClient>({
    transportName: "discord",
    allowedGuildIds: ["111"],
    allowedChannelIds: ["222"],
    runnableAgents: ["piren"],
    defaultAgent: "piren",
    targetBuilder: async () => ({ command: "fake", args: [], cwd: process.cwd(), env: process.env }),
    clientFactory: () => new FakeDiscordClient(),
    api: { async createMessage(_channelId, text) { replies.push(text); } },
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
});
