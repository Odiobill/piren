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

function fakePiTargetWithEnv(extra: Record<string, string>): RpcSpawnTarget {
  return {
    command: process.execPath,
    args: [fakePiScript],
    cwd: process.cwd(),
    env: { ...process.env, ...extra },
  };
}

describe("PiRpcClient native session controls (T2a)", () => {
  it("newSession sends new_session and resolves cancelled=false on success", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      const result = await client.newSession();
      expect(result).toEqual({ cancelled: false });
    } finally {
      await client.stop();
    }
  });

  it("newSession exposes Pi's documented cancelled result", async () => {
    const client = new PiRpcClient(fakePiTargetWithEnv({ FAKE_PI_NEW_SESSION_CANCEL: "1" }));
    try {
      await client.start();
      const result = await client.newSession();
      expect(result).toEqual({ cancelled: true });
    } finally {
      await client.stop();
    }
  });

  it("newSession rejects a failed RPC response", async () => {
    const client = new PiRpcClient(fakePiTargetWithEnv({ FAKE_PI_NEW_SESSION_FAIL: "1" }));
    try {
      await client.start();
      await expect(client.newSession()).rejects.toThrow("new_session rejected by fake");
    } finally {
      await client.stop();
    }
  });

  it("compact returns a minimal token contract without summary/transcript data", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      const result = await client.compact();
      expect(result).toEqual({ tokensBefore: 150000, estimatedTokensAfter: 32000 });
      // Raw summary/transcript data is never surfaced to transport callers.
      expect("summary" in result).toBe(false);
    } finally {
      await client.stop();
    }
  });

  it("compact rejects a failed RPC response", async () => {
    const client = new PiRpcClient(fakePiTargetWithEnv({ FAKE_PI_COMPACT_FAIL: "1" }));
    try {
      await client.start();
      await expect(client.compact()).rejects.toThrow("compact rejected by fake");
    } finally {
      await client.stop();
    }
  });
});
