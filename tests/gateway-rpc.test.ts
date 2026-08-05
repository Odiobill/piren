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
  it("drains streaming events until agent_settled after sending a prompt (agent_end alone is not terminal)", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      const events = await client.promptAndWait("Hello");

      const types = events.map((event) => event.type);
      expect(types).toContain("agent_start");
      expect(types).toContain("agent_end");
      // TB0/G1: only agent_settled proves the run is fully terminal.
      expect(types[types.length - 1]).toBe("agent_settled");
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

  it("prompt sends a prompt and resolves after the ack while events keep streaming", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      const agentEnded = new Promise<void>((resolve) => {
        client.onEvent((event) => {
          if (event.type === "agent_end") resolve();
        });
      });
      // prompt resolves after the ack response, before agent_end arrives.
      await client.prompt("Hello");
      await agentEnded;
    } finally {
      await client.stop();
    }
  });

  it("does NOT complete on an agent_end with willRetry:true; resolves once at agent_settled (retry script)", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      const events = await client.promptAndWait("willretry please");

      const types = events.map((event) => event.type);
      // Two low-level agent_end events: the first announces an automatic retry.
      const ends = events.filter((event) => event.type === "agent_end");
      expect(ends).toHaveLength(2);
      expect(ends[0]?.willRetry).toBe(true);
      expect(ends[1]?.willRetry).toBe(false);
      // No early completion: the resolved array contains both agent_end events
      // and ends only at agent_settled.
      expect(types[types.length - 1]).toBe("agent_settled");
      // Evidence is not discarded: text from both low-level runs is assembled.
      expect(extractAssistantText(events)).toBe("Hello");
    } finally {
      await client.stop();
    }
  });

  it("maintenance compaction traffic does not complete the run; completion only at agent_settled (overflow script)", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      const events = await client.promptAndWait("overflowcompact please");

      const types = events.map((event) => event.type);
      // Compaction lifecycle events are visible but never terminal.
      expect(types).toContain("compaction_start");
      expect(types).toContain("compaction_end");
      expect(types[types.length - 1]).toBe("agent_settled");
      expect(extractAssistantText(events)).toBe("PrePost");
    } finally {
      await client.stop();
    }
  });

  it("failed/aborted compaction and summarization-retry traffic never reaches agent_settled: promptAndWait stays conservative (bounded timeout)", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      // The compactbreak script emits compaction failure + summarization retry
      // traffic and then an agent_end, but NO agent_settled. The wait must not
      // complete on that traffic; the bounded timeout is the conservative path.
      await expect(client.promptAndWait("compactbreak please", 800)).rejects.toThrow(
        "Timed out waiting for agent_settled",
      );
    } finally {
      await client.stop();
    }
  });

  it("onExit fires when the agent process exits", async () => {
    const client = new PiRpcClient(fakePiTarget());
    await client.start();
    let exited = false;
    client.onExit(() => {
      exited = true;
    });
    await client.stop();
    expect(exited).toBe(true);
  });

  it("onExit also fires on the post-spawn process error path (ADR-0038 revision 3)", async () => {
    const client = new PiRpcClient(fakePiTarget());
    await client.start();
    let terminated = false;
    client.onExit(() => {
      terminated = true;
    });
    // Simulate a post-spawn child 'error' event (for example a failed kill).
    // TS-private is compile-time only; the test drives the real ChildProcess.
    const child = (client as unknown as { process: { emit(event: string, error: Error): unknown } | null }).process;
    expect(child).not.toBeNull();
    child?.emit("error", new Error("simulated post-spawn error"));
    expect(terminated).toBe(true);
    await client.stop();
  });

  it("onExit fires at most once when a post-spawn error is followed by exit (one-shot termination)", async () => {
    const client = new PiRpcClient(fakePiTarget());
    await client.start();
    let count = 0;
    client.onExit(() => {
      count += 1;
    });
    const child = (client as unknown as { process: { emit(event: string, error: Error): unknown } | null }).process;
    expect(child).not.toBeNull();
    child?.emit("error", new Error("simulated post-spawn error"));
    expect(count).toBe(1);
    // stop() SIGTERMs the child, which fires the exit path: the listener
    // must NOT run a second time (no duplicate SSE errors downstream).
    await client.stop();
    expect(count).toBe(1);
  });
});
