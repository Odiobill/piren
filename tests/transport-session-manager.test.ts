import { describe, expect, it } from "vitest";
import { TransportSessionManager } from "../src/transport-session-manager.js";
import type { RpcSpawnTarget } from "../src/gateway-rpc.js";

class FakeTransportClient {
  started = 0;
  stopped = 0;
  aborted = 0;

  async start(): Promise<void> {
    this.started += 1;
  }

  async stop(): Promise<void> {
    this.stopped += 1;
  }

  async abort(): Promise<void> {
    this.aborted += 1;
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
});
