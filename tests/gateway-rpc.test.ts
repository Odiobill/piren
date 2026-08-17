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

function fakePiTargetWithEnv(extra: Record<string, string>): RpcSpawnTarget {
  return {
    command: process.execPath,
    args: [fakePiScript],
    cwd: process.cwd(),
    env: { ...process.env, ...extra },
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
      // prompt resolves after the ack response, before agent_settled arrives.
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

describe("PiRpcClient.getSessionStats (T1 typed get_session_stats wrapper)", () => {
  // Inline fake that asserts the exact command shape: the client must send
  // only {type:"get_session_stats", id}. It also carries an unknown extra
  // field to prove the typed result never leaks raw unknown data.
  const shapeAssertingScript = [
    "let buffer = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    "  buffer += chunk;",
    "  let index;",
    "  while ((index = buffer.indexOf('\\n')) !== -1) {",
    "    const line = buffer.slice(0, index).trim();",
    "    buffer = buffer.slice(index + 1);",
    "    if (!line) continue;",
    "    const cmd = JSON.parse(line);",
    "    const keys = Object.keys(cmd).sort();",
    "    const shapeOk = cmd.type === 'get_session_stats' && keys.length === 2 && keys[0] === 'id' && keys[1] === 'type' && typeof cmd.id === 'string';",
    "    const data = { sessionFile: '/tmp/s.jsonl', sessionId: 's1', userMessages: 1, assistantMessages: 2, toolCalls: 3, toolResults: 3, totalMessages: 6, tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 5, total: 65 }, cost: 0.01, contextUsage: { tokens: 40, contextWindow: 200000, percent: 0.02 }, unexpectedExtra: { nested: true } };",
    "    const response = shapeOk",
    "      ? { type: 'response', command: cmd.type, success: true, id: cmd.id, data }",
    "      : { type: 'response', command: String(cmd.type), success: false, id: cmd.id, error: 'unexpected command shape: ' + keys.join(',') };",
    "    process.stdout.write(JSON.stringify(response) + '\\n');",
    "  }",
    "});",
  ].join("\n");

  it("sends exactly {type:'get_session_stats', id} and returns typed stats without leaking unknown fields", async () => {
    const target: RpcSpawnTarget = {
      command: process.execPath,
      args: ["-e", shapeAssertingScript],
      cwd: process.cwd(),
      env: process.env,
    };
    const client = new PiRpcClient(target);
    try {
      await client.start();
      const stats = await client.getSessionStats();
      expect(stats.sessionFile).toBe("/tmp/s.jsonl");
      expect(stats.sessionId).toBe("s1");
      expect(stats.userMessages).toBe(1);
      expect(stats.assistantMessages).toBe(2);
      expect(stats.toolCalls).toBe(3);
      expect(stats.toolResults).toBe(3);
      expect(stats.totalMessages).toBe(6);
      expect(stats.tokens).toEqual({ input: 10, output: 20, cacheRead: 30, cacheWrite: 5, total: 65 });
      expect(stats.cost).toBe(0.01);
      expect(stats.contextUsage).toEqual({ tokens: 40, contextWindow: 200000, percent: 0.02 });
      // Unknown extra fields never leak into the public typed result.
      expect("unexpectedExtra" in stats).toBe(false);
    } finally {
      await client.stop();
    }
  });

  it("returns fully typed numeric stats from the default fake response", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      const stats = await client.getSessionStats();
      expect(stats.sessionFile).toBe("/tmp/fake-session.jsonl");
      expect(stats.sessionId).toBe("fake-session-1");
      expect(stats.tokens).toEqual({ input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000 });
      expect(stats.cost).toBe(0.45);
      expect(stats.contextUsage).toEqual({ tokens: 60000, contextWindow: 200000, percent: 30 });
    } finally {
      await client.stop();
    }
  });

  it("omits the contextUsage property entirely when Pi reports no model/context window (no-window state)", async () => {
    const client = new PiRpcClient(fakePiTargetWithEnv({ FAKE_PI_SESSION_STATS_NO_WINDOW: "1" }));
    try {
      await client.start();
      const stats = await client.getSessionStats();
      expect(stats.sessionId).toBe("fake-session-1");
      // The two documented unavailable states are never collapsed: an omitted
      // contextUsage means the property itself is absent, never null.
      expect("contextUsage" in stats).toBe(false);
      expect(stats.contextUsage).toBeUndefined();
    } finally {
      await client.stop();
    }
  });

  it("preserves post-compaction null tokens/percent distinct from an omitted contextUsage", async () => {
    const client = new PiRpcClient(fakePiTargetWithEnv({ FAKE_PI_SESSION_STATS_POST_COMPACTION: "1" }));
    try {
      await client.start();
      const stats = await client.getSessionStats();
      // Present object, null usage numbers: NOT the same as an omitted
      // contextUsage (docs/rpc.md: null until a fresh post-compaction
      // assistant response provides valid usage data).
      expect("contextUsage" in stats).toBe(true);
      expect(stats.contextUsage).toEqual({ tokens: null, contextWindow: 200000, percent: null });
    } finally {
      await client.stop();
    }
  });

  it("rejects malformed (non-object) response data instead of fabricating stats", async () => {
    const client = new PiRpcClient(fakePiTargetWithEnv({ FAKE_PI_SESSION_STATS_MALFORMED: "1" }));
    try {
      await client.start();
      await expect(client.getSessionStats()).rejects.toThrow("get_session_stats returned malformed data");
    } finally {
      await client.stop();
    }
  });

  it("rejects a structurally invalid contextUsage instead of collapsing it into an unavailable state", async () => {
    const client = new PiRpcClient(fakePiTargetWithEnv({ FAKE_PI_SESSION_STATS_BAD_CONTEXT: "1" }));
    try {
      await client.start();
      await expect(client.getSessionStats()).rejects.toThrow("get_session_stats returned malformed contextUsage");
    } finally {
      await client.stop();
    }
  });

  it("rejects missing/invalid required scalar fields as malformed instead of fabricating zeros", async () => {
    const client = new PiRpcClient(fakePiTargetWithEnv({ FAKE_PI_SESSION_STATS_INVALID_SCALARS: "1" }));
    try {
      await client.start();
      await expect(client.getSessionStats()).rejects.toThrow("get_session_stats returned malformed data");
    } finally {
      await client.stop();
    }
  });

  it("rejects a present contextUsage: null as malformed, distinct from an omitted property", async () => {
    const client = new PiRpcClient(fakePiTargetWithEnv({ FAKE_PI_SESSION_STATS_NULL_CONTEXT: "1" }));
    try {
      await client.start();
      await expect(client.getSessionStats()).rejects.toThrow("get_session_stats returned malformed contextUsage");
    } finally {
      await client.stop();
    }
  });

  it("rejects when Pi rejects the get_session_stats command", async () => {
    const client = new PiRpcClient(fakePiTargetWithEnv({ FAKE_PI_SESSION_STATS_FAIL: "1" }));
    try {
      await client.start();
      await expect(client.getSessionStats()).rejects.toThrow("get_session_stats rejected by fake");
    } finally {
      await client.stop();
    }
  });
});
