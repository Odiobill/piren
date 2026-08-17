import { describe, expect, it } from "vitest";
import { mapSessionTelemetryFacts } from "../src/conversation-telemetry.js";
import type { RpcSessionState, RpcSessionStats } from "../src/gateway-rpc.js";

function statsWith(usage?: { tokens: number | null; contextWindow: number; percent: number | null }): RpcSessionStats {
  const stats: RpcSessionStats = {
    sessionFile: "/private/session.jsonl",
    sessionId: "secret-session-id",
    userMessages: 5,
    assistantMessages: 5,
    toolCalls: 12,
    toolResults: 12,
    totalMessages: 22,
    tokens: { input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000 },
    cost: 0.45,
  };
  if (usage !== undefined) stats.contextUsage = usage;
  return stats;
}

describe("mapSessionTelemetryFacts (T3 pure mapper)", () => {
  it("maps numeric context usage to the ok state with the exact bounded context triple", () => {
    const facts = mapSessionTelemetryFacts(
      statsWith({ tokens: 60000, contextWindow: 200000, percent: 30 }),
      { thinkingLevel: "high", autoCompactionEnabled: true, model: { provider: "anthropic", id: "claude-sonnet-4", contextWindow: 200000, reasoning: true } },
    );
    expect(facts.contextState).toBe("ok");
    expect(facts.context).toEqual({ tokens: 60000, contextWindow: 200000, percent: 30 });
    expect(facts.model).toEqual({ provider: "anthropic", id: "claude-sonnet-4" });
    expect(facts.thinkingLevel).toBe("high");
    expect(facts.autoCompactionEnabled).toBe(true);
  });

  it("maps post-compaction null tokens/percent to post_compaction_pending, preserving the numeric window", () => {
    const facts = mapSessionTelemetryFacts(statsWith({ tokens: null, contextWindow: 200000, percent: null }), {});
    expect(facts.contextState).toBe("post_compaction_pending");
    expect(facts.context).toEqual({ tokens: null, contextWindow: 200000, percent: null });
  });

  it("maps an omitted contextUsage to no_window with NO context property (the two unavailable states are never collapsed)", () => {
    const facts = mapSessionTelemetryFacts(statsWith(), {});
    expect(facts.contextState).toBe("no_window");
    expect("context" in facts).toBe(false);
  });

  it("never leaks session identifiers, token/cost totals, or raw RPC objects into the bounded facts", () => {
    const facts = mapSessionTelemetryFacts(statsWith({ tokens: 60000, contextWindow: 200000, percent: 30 }), {
      sessionFile: "/private/session.jsonl",
      sessionId: "secret-session-id",
    });
    expect(Object.keys(facts).sort()).toEqual(["context", "contextState"]);
    const serialized = JSON.stringify(facts);
    expect(serialized).not.toContain("secret-session-id");
    expect(serialized).not.toContain("/private/session.jsonl");
    expect(serialized).not.toContain("105000");
    expect(serialized).not.toContain("0.45");
  });

  it("omits model/thinking/auto-compaction when not safely available (empty strings, wrong types, absent)", () => {
    const facts = mapSessionTelemetryFacts(statsWith(), {
      thinkingLevel: "",
      autoCompactionEnabled: undefined,
      model: { provider: "", id: "claude-sonnet-4" },
    } as unknown as RpcSessionState);
    expect("model" in facts && "provider" in (facts.model as object)).toBe(false);
    expect(facts.model).toEqual({ id: "claude-sonnet-4" });
    expect("thinkingLevel" in facts).toBe(false);
    expect("autoCompactionEnabled" in facts).toBe(false);

    const noModel = mapSessionTelemetryFacts(statsWith(), {});
    expect("model" in noModel).toBe(false);
  });
});
