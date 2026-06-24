import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiRpcClient, type RpcSpawnTarget } from "../src/gateway-rpc.js";

const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");

function fakePiTarget(): RpcSpawnTarget {
  return {
    command: process.execPath,
    args: [fakePiScript],
    cwd: process.cwd(),
    env: process.env,
  };
}

describe("PiRpcClient state and model commands", () => {
  it("getState returns the current session state", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      const state = await client.getState();

      expect(state.sessionId).toBe("fake-session");
      expect(state.isStreaming).toBe(false);
    } finally {
      await client.stop();
    }
  });

  it("getAvailableModels returns the model list with provider and id", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      const result = await client.getAvailableModels();

      expect(result.models.length).toBeGreaterThan(0);
      const first = result.models[0];
      expect(first).toBeDefined();
      expect(typeof first?.provider).toBe("string");
      expect(typeof first?.id).toBe("string");
    } finally {
      await client.stop();
    }
  });

  it("setModel switches the active model and returns the new model", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      const model = await client.setModel("anthropic", "claude-sonnet-4-20250514");

      expect(model.provider).toBe("anthropic");
      expect(model.id).toBe("claude-sonnet-4-20250514");
    } finally {
      await client.stop();
    }
  });

  it("setThinkingLevel changes the thinking level", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      // Should not throw; the fake acks with success.
      await client.setThinkingLevel("medium");
    } finally {
      await client.stop();
    }
  });

  it("setModel rejects when the provider/model is unknown", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      await expect(client.setModel("bogus", "nope")).rejects.toThrow();
    } finally {
      await client.stop();
    }
  });
});
