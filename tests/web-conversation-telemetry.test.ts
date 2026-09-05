import { describe, expect, it } from "vitest";
import {
  applyConversationTelemetryFrame,
  applyConversationTelemetryRead,
  emptyConversationTelemetryState,
  formatConversationTelemetryEntry,
  parseConversationTelemetryFrame,
  parseConversationTelemetryReadResponse,
  type ConversationTelemetryFrame,
} from "../web/src/conversation-telemetry.js";

/**
 * T6 — browser-only telemetry parser/state core (conversation-telemetry.ts)
 * and the narrow T4 API adapter. Strict bounded schemas only: no session
 * ids/paths, token/cost totals, transcript, or raw RPC objects; the three
 * live context states stay distinct; foreign/malformed frames are rejected.
 */

const CID = "c1";

function liveFrame(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    conversationId: CID,
    agent: "dipu",
    runId: "run-0001",
    contextState: "ok",
    context: { tokens: 60000, contextWindow: 200000, percent: 30 },
    ...overrides,
  };
}

describe("parseConversationTelemetryFrame (strict, fail-closed)", () => {
  it("accepts a valid ok frame with optional safe fields", () => {
    const result = parseConversationTelemetryFrame(
      liveFrame({ model: { provider: "anthropic", id: "claude-sonnet-4" }, thinkingLevel: "high", autoCompactionEnabled: true }),
      CID,
    );
    expect(result).toEqual({
      ok: true,
      frame: {
        conversationId: CID,
        agent: "dipu",
        runId: "run-0001",
        contextState: "ok",
        context: { tokens: 60000, contextWindow: 200000, percent: 30 },
        model: { provider: "anthropic", id: "claude-sonnet-4" },
        thinkingLevel: "high",
        autoCompactionEnabled: true,
      },
    });
  });

  it("keeps post_compaction_pending and no_window distinct", () => {
    const pending = parseConversationTelemetryFrame(
      liveFrame({ contextState: "post_compaction_pending", context: { tokens: null, contextWindow: 200000, percent: null } }),
      CID,
    );
    expect(pending).toMatchObject({ ok: true, frame: { contextState: "post_compaction_pending", context: { tokens: null, contextWindow: 200000, percent: null } } });
    const noWindow = parseConversationTelemetryFrame(liveFrame({ contextState: "no_window", context: undefined }), CID);
    expect(noWindow).toMatchObject({ ok: true, frame: { contextState: "no_window" } });
    if (noWindow.ok) expect("context" in noWindow.frame).toBe(false);
  });

  it("rejects a frame for a foreign conversation", () => {
    expect(parseConversationTelemetryFrame(liveFrame(), "other-conversation")).toMatchObject({ ok: false });
  });

  it("rejects forbidden raw fields (session ids/paths, totals, cost, transcript, errors)", () => {
    for (const key of ["sessionId", "sessionFile", "cost", "tokens", "transcript", "error", "messages", "stats", "state"]) {
      expect(parseConversationTelemetryFrame(liveFrame({ [key]: "x" }), CID)).toMatchObject({ ok: false });
    }
  });

  it("rejects malformed shapes: bad enum, non-finite window, wrong token types, empty agent/runId", () => {
    expect(parseConversationTelemetryFrame(liveFrame({ contextState: "sometimes" }), CID)).toMatchObject({ ok: false });
    expect(parseConversationTelemetryFrame(liveFrame({ context: { tokens: 1, contextWindow: Number.NaN, percent: 1 } }), CID)).toMatchObject({ ok: false });
    expect(parseConversationTelemetryFrame(liveFrame({ context: { tokens: "60k", contextWindow: 200000, percent: 30 } }), CID)).toMatchObject({ ok: false });
    expect(parseConversationTelemetryFrame(liveFrame({ agent: "" }), CID)).toMatchObject({ ok: false });
    expect(parseConversationTelemetryFrame(liveFrame({ runId: "" }), CID)).toMatchObject({ ok: false });
    expect(parseConversationTelemetryFrame(null, CID)).toMatchObject({ ok: false });
    // ok requires numeric tokens/percent; post_compaction requires nulls; no_window forbids context.
    expect(parseConversationTelemetryFrame(liveFrame({ contextState: "ok", context: { tokens: null, contextWindow: 200000, percent: null } }), CID)).toMatchObject({ ok: false });
    expect(parseConversationTelemetryFrame(liveFrame({ contextState: "no_window", context: { tokens: 1, contextWindow: 2, percent: 3 } }), CID)).toMatchObject({ ok: false });
  });
});

describe("parseConversationTelemetryReadResponse (strict, throws on invalid)", () => {
  it("accepts live results in all three context states", () => {
    expect(
      parseConversationTelemetryReadResponse({ sessionState: "live", contextState: "ok", context: { tokens: 60000, contextWindow: 200000, percent: 30 }, thinkingLevel: "off" }),
    ).toEqual({ sessionState: "live", contextState: "ok", context: { tokens: 60000, contextWindow: 200000, percent: 30 }, thinkingLevel: "off" });
    expect(
      parseConversationTelemetryReadResponse({ sessionState: "live", contextState: "post_compaction_pending", context: { tokens: null, contextWindow: 200000, percent: null } }),
    ).toMatchObject({ sessionState: "live", contextState: "post_compaction_pending" });
    expect(parseConversationTelemetryReadResponse({ sessionState: "live", contextState: "no_window" })).toEqual({
      sessionState: "live",
      contextState: "no_window",
    });
  });

  it("accepts exactly {sessionState:'no_live_session'} and rejects telemetry fields on it", () => {
    expect(parseConversationTelemetryReadResponse({ sessionState: "no_live_session" })).toEqual({ sessionState: "no_live_session" });
    expect(() => parseConversationTelemetryReadResponse({ sessionState: "no_live_session", contextState: "ok" })).toThrow();
  });

  it("rejects forbidden fields, malformed facts, and unknown sessionState", () => {
    expect(() => parseConversationTelemetryReadResponse({ sessionState: "live", contextState: "ok", context: { tokens: 1, contextWindow: 2, percent: 3 }, cost: 0.4 })).toThrow();
    expect(() => parseConversationTelemetryReadResponse({ sessionState: "live", contextState: "ok", context: { tokens: "x", contextWindow: 2, percent: 3 } })).toThrow();
    expect(() => parseConversationTelemetryReadResponse({ sessionState: "maybe" })).toThrow();
    expect(() => parseConversationTelemetryReadResponse(null)).toThrow();
  });
});

describe("telemetry state core (per-agent, session-only)", () => {
  const frameFor = (agent: string, runId: string, percent: number): ConversationTelemetryFrame => ({
    conversationId: CID,
    agent,
    runId,
    contextState: "ok",
    context: { tokens: 60000, contextWindow: 200000, percent },
  });

  it("applies frames per agent without overwriting another agent's state", () => {
    let state = emptyConversationTelemetryState();
    state = applyConversationTelemetryFrame(state, frameFor("dipu", "run-1", 30));
    state = applyConversationTelemetryFrame(state, frameFor("zai", "run-2", 55));
    expect(state.get("dipu")).toMatchObject({ kind: "live", runId: "run-1", facts: { context: { percent: 30 } } });
    expect(state.get("zai")).toMatchObject({ kind: "live", runId: "run-2", facts: { context: { percent: 55 } } });
    // A newer frame for one agent replaces only its own entry.
    state = applyConversationTelemetryFrame(state, frameFor("dipu", "run-3", 61));
    expect(state.get("dipu")).toMatchObject({ kind: "live", runId: "run-3", facts: { context: { percent: 61 } } });
    expect(state.get("zai")).toMatchObject({ facts: { context: { percent: 55 } } });
    // Frames never derive a conversation-wide total.
    expect(state.size).toBe(2);
  });

  it("refresh live replaces the entry (runId cleared); refresh no_live records an explicit no-live entry; a later SSE frame restores live", () => {
    let state = applyConversationTelemetryFrame(emptyConversationTelemetryState(), frameFor("dipu", "run-1", 30));
    state = applyConversationTelemetryRead(state, "dipu", { sessionState: "live", contextState: "no_window" });
    expect(state.get("dipu")).toEqual({ kind: "live", agent: "dipu", runId: null, facts: { contextState: "no_window" } });
    state = applyConversationTelemetryRead(state, "dipu", { sessionState: "no_live_session" });
    expect(state.get("dipu")).toEqual({ kind: "no-live", agent: "dipu" });
    state = applyConversationTelemetryFrame(state, frameFor("dipu", "run-9", 12));
    expect(state.get("dipu")).toMatchObject({ kind: "live", runId: "run-9" });
  });
});

describe("formatConversationTelemetryEntry (text-first, truthful)", () => {
  it("ok: numeric tokens/window/percent with optional safe suffixes", () => {
    const line = formatConversationTelemetryEntry({
      kind: "live",
      agent: "dipu",
      runId: "run-1",
      facts: {
        contextState: "ok",
        context: { tokens: 60000, contextWindow: 200000, percent: 30 },
        model: { provider: "anthropic", id: "claude-sonnet-4" },
        thinkingLevel: "high",
        autoCompactionEnabled: true,
      },
    });
    expect(line.text).toBe("Dipu · 60.0k / 200.0k context · 30% · auto-compaction on · anthropic/claude-sonnet-4 · thinking high");
    expect(line.ariaLabel).toContain("Dipu");
    expect(line.ariaLabel).toContain("30 percent");
  });

  it("post_compaction_pending / no_window / no-live render explicit text with no fabricated numbers", () => {
    const pending = formatConversationTelemetryEntry({
      kind: "live",
      agent: "dipu",
      runId: null,
      facts: { contextState: "post_compaction_pending", context: { tokens: null, contextWindow: 200000, percent: null } },
    });
    expect(pending.text).toBe("Dipu · context usage temporarily unavailable after compaction");
    expect(pending.text).not.toContain("%");
    const noWindow = formatConversationTelemetryEntry({ kind: "live", agent: "zai", runId: null, facts: { contextState: "no_window" } });
    expect(noWindow.text).toBe("Zai · no context window information");
    const noLive = formatConversationTelemetryEntry({ kind: "no-live", agent: "zai" });
    expect(noLive.text).toBe("Zai · no live session");
  });
});

describe("strict recursive allowlist (T6 correction)", () => {
  it("rejects unknown non-forbidden keys at the frame root, inside context, and inside model", () => {
    expect(parseConversationTelemetryFrame(liveFrame({ note: "extra" }), CID)).toMatchObject({ ok: false });
    expect(
      parseConversationTelemetryFrame(liveFrame({ context: { tokens: 1, contextWindow: 2, percent: 3, extra: 1 } }), CID),
    ).toMatchObject({ ok: false });
    expect(
      parseConversationTelemetryFrame(liveFrame({ model: { provider: "x", apiKey: "secret" } }), CID),
    ).toMatchObject({ ok: false });
  });

  it("rejects unknown keys at every level of the read response", () => {
    const base = { sessionState: "live", contextState: "ok", context: { tokens: 1, contextWindow: 2, percent: 3 } };
    expect(() => parseConversationTelemetryReadResponse({ ...base, note: "extra" })).toThrow();
    expect(() => parseConversationTelemetryReadResponse({ ...base, context: { tokens: 1, contextWindow: 2, percent: 3, extra: 1 } })).toThrow();
    expect(() => parseConversationTelemetryReadResponse({ ...base, model: { provider: "x", apiKey: "secret" } })).toThrow();
  });

  it("still accepts exactly the allowed key sets at every level", () => {
    const full = parseConversationTelemetryFrame(
      liveFrame({ model: { provider: "anthropic", id: "claude-sonnet-4" }, thinkingLevel: "high", autoCompactionEnabled: false }),
      CID,
    );
    expect(full.ok).toBe(true);
    expect(
      parseConversationTelemetryReadResponse({
        sessionState: "live",
        contextState: "ok",
        context: { tokens: 1, contextWindow: 2, percent: 3 },
        model: { id: "claude-sonnet-4" },
        thinkingLevel: "off",
        autoCompactionEnabled: true,
      }),
    ).toMatchObject({ sessionState: "live", model: { id: "claude-sonnet-4" } });
  });
});
