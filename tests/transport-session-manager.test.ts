import { describe, expect, it } from "vitest";
import { TransportSessionManager } from "../src/transport-session-manager.js";
import type { RpcSpawnTarget } from "../src/gateway-rpc.js";

class FakeTransportClient {
  started = 0;
  stopped = 0;
  aborted = 0;
  newSessionCalls = 0;
  compactCalls = 0;
  newSessionResult: { cancelled: boolean } = { cancelled: false };
  compactResult: { tokensBefore: number | null; estimatedTokensAfter: number | null } = { tokensBefore: 150000, estimatedTokensAfter: 32000 };
  failNextControl: string | null = null;

  async start(): Promise<void> {
    this.started += 1;
  }

  async stop(): Promise<void> {
    this.stopped += 1;
  }

  async abort(): Promise<void> {
    this.aborted += 1;
  }

  async newSession(): Promise<{ cancelled: boolean }> {
    this.newSessionCalls += 1;
    if (this.failNextControl !== null) throw new Error(this.failNextControl);
    return this.newSessionResult;
  }

  async compact(): Promise<{ tokensBefore: number | null; estimatedTokensAfter: number | null }> {
    this.compactCalls += 1;
    if (this.failNextControl !== null) throw new Error(this.failNextControl);
    return this.compactResult;
  }
}

const target: RpcSpawnTarget = {
  command: "fake",
  args: [],
  cwd: process.cwd(),
  env: process.env,
};

describe("TransportSessionManager", () => {
  it("starts and reuses one RPC client per transport conversation and active runnable agent", async () => {
    const created: FakeTransportClient[] = [];
    const manager = new TransportSessionManager<FakeTransportClient>({
      runnableAgents: ["piren", "thor"],
      defaultAgent: "piren",
      targetBuilder: async (agent) => ({ ...target, args: [agent] }),
      clientFactory: (_target) => {
        const client = new FakeTransportClient();
        created.push(client);
        return client;
      },
    });

    const first = await manager.getSession("telegram", "chat-1");
    const reused = await manager.getSession("telegram", "chat-1");
    const otherConversation = await manager.getSession("telegram", "chat-2", "thor");

    expect(first.agent).toBe("piren");
    expect(reused.client).toBe(first.client);
    expect(otherConversation.agent).toBe("thor");
    expect(created).toHaveLength(2);
    expect(created.map((client) => client.started)).toEqual([1, 1]);

    await expect(manager.getSession("telegram", "chat-3", "evil-agent")).rejects.toThrow("not in the runnable set");

    await manager.closeAll();
    expect(created.map((client) => client.stopped)).toEqual([1, 1]);
  });

  it("returns no-active-session for newSession/compact without invoking targetBuilder or clientFactory", async () => {
    let targetBuilds = 0;
    let clientBuilds = 0;
    const manager = new TransportSessionManager<FakeTransportClient>({
      runnableAgents: ["piren"],
      defaultAgent: "piren",
      targetBuilder: async () => { targetBuilds += 1; return target; },
      clientFactory: () => { clientBuilds += 1; return new FakeTransportClient(); },
    });

    expect(await manager.newSession("telegram", "chat-1")).toEqual({ status: "no-active-session" });
    expect(await manager.compact("telegram", "chat-1")).toEqual({ status: "no-active-session" });
    expect(targetBuilds).toBe(0);
    expect(clientBuilds).toBe(0);
  });

  it("dispatches newSession/compact only to that conversation's client and preserves agent/client identity", async () => {
    const created: FakeTransportClient[] = [];
    const manager = new TransportSessionManager<FakeTransportClient>({
      runnableAgents: ["piren", "thor"],
      defaultAgent: "piren",
      targetBuilder: async (agent) => ({ ...target, args: [agent] }),
      clientFactory: () => {
        const client = new FakeTransportClient();
        created.push(client);
        return client;
      },
    });

    const first = await manager.getSession("telegram", "chat-1");
    const second = await manager.getSession("telegram", "chat-2", "thor");

    expect(await manager.newSession("telegram", "chat-1")).toEqual({ status: "completed" });
    expect(await manager.compact("telegram", "chat-1")).toEqual({ status: "completed", tokensBefore: 150000, estimatedTokensAfter: 32000 });
    expect(created[0]?.newSessionCalls).toBe(1);
    expect(created[0]?.compactCalls).toBe(1);
    expect(created[1]?.newSessionCalls).toBe(0);
    expect(created[1]?.compactCalls).toBe(0);

    // Native operation only: no restart/swap, active agent and client unchanged.
    expect(manager.getActiveAgent("telegram", "chat-1")).toBe("piren");
    expect(manager.getActiveAgent("telegram", "chat-2")).toBe("thor");
    const reused = await manager.getSession("telegram", "chat-1");
    expect(reused.client).toBe(first.client);
    expect(created).toHaveLength(2);
    expect(second.client).toBe(created[1]);
  });

  it("distinguishes a Pi-cancelled new session from completion", async () => {
    const created: FakeTransportClient[] = [];
    const manager = new TransportSessionManager<FakeTransportClient>({
      runnableAgents: ["piren"],
      defaultAgent: "piren",
      targetBuilder: async () => target,
      clientFactory: () => {
        const client = new FakeTransportClient();
        created.push(client);
        return client;
      },
    });

    await manager.getSession("telegram", "chat-1");
    created[0]!.newSessionResult = { cancelled: true };
    expect(await manager.newSession("telegram", "chat-1")).toEqual({ status: "cancelled" });
    // The conversation's client and agent are still the active ones afterwards.
    expect(manager.getActiveAgent("telegram", "chat-1")).toBe("piren");
    expect(created).toHaveLength(1);
  });

  it("propagates client rejection rather than converting it", async () => {
    const created: FakeTransportClient[] = [];
    const manager = new TransportSessionManager<FakeTransportClient>({
      runnableAgents: ["piren"],
      defaultAgent: "piren",
      targetBuilder: async () => target,
      clientFactory: () => {
        const client = new FakeTransportClient();
        created.push(client);
        return client;
      },
    });

    await manager.getSession("telegram", "chat-1");
    created[0]!.failNextControl = "pi rpc exploded";
    await expect(manager.newSession("telegram", "chat-1")).rejects.toThrow("pi rpc exploded");
    await expect(manager.compact("telegram", "chat-1")).rejects.toThrow("pi rpc exploded");
  });
});
