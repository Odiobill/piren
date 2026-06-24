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

describe("PiRpcClient session resume and abort commands", () => {
  it("abort sends an abort command and resolves after the ack", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      // Start a prompt so there is an active turn to abort, then abort it.
      void client.prompt("Hello").catch(() => {});
      // The fake acks abort with success and emits agent_end to model the stop.
      await client.abort();
    } finally {
      await client.stop();
    }
  });

  it("getMessages returns the full transcript of the current session", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      const result = await client.getMessages();
      expect(Array.isArray(result.messages)).toBe(true);
      // The fake returns at least one canned message.
      expect(result.messages.length).toBeGreaterThan(0);
    } finally {
      await client.stop();
    }
  });

  it("switchSession resumes a past session and reports whether it was cancelled", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      const result = await client.switchSession("/fake/path/session.jsonl");
      expect(result.cancelled).toBe(false);
    } finally {
      await client.stop();
    }
  });

  it("switchSession reports cancelled when the path is 'cancel'", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      const result = await client.switchSession("cancel");
      expect(result.cancelled).toBe(true);
    } finally {
      await client.stop();
    }
  });
});
