import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiRpcClient, extractAssistantText, type RpcSpawnTarget } from "../src/gateway-rpc.js";

const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");

function fakePiTarget(): RpcSpawnTarget {
  return {
    command: process.execPath,
    args: [fakePiScript],
    cwd: process.cwd(),
    env: process.env,
  };
}

describe("PiRpcClient prompt flow against a fake Pi process", () => {
  it("drains streaming events until agent_end after sending a prompt", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      const events = await client.promptAndWait("Hello");

      const types = events.map((event) => event.type);
      expect(types).toContain("agent_start");
      expect(types).toContain("agent_end");
      expect(types[types.length - 1]).toBe("agent_end");
    } finally {
      await client.stop();
    }
  });

  it("assembles assistant text from nested text_delta events, not a flat token event", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      const events = await client.promptAndWait("Hello");

      // No top-level token event exists; deltas are nested.
      expect(events.some((event) => event.type === "token")).toBe(false);
      expect(extractAssistantText(events)).toBe("Hello");
    } finally {
      await client.stop();
    }
  });

  it("rejects when the agent process exits before responding", async () => {
    const target: RpcSpawnTarget = {
      command: process.execPath,
      args: ["-e", "process.stderr.write('boom'); process.exit(1);"],
      cwd: process.cwd(),
      env: process.env,
    };
    const client = new PiRpcClient(target);
    await expect(client.promptAndWait("nope")).rejects.toThrow();
  });
});
