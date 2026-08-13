import { describe, expect, it } from "vitest";
import {
  captureConversationRunSummary,
  clearConversationRunSummaries,
  CONVERSATION_RUN_SUMMARY_MAX,
  conversationRunSummaryTerminalLabel,
  emptyConversationRunSummaries,
  type ConversationRunSummary,
} from "../web/src/conversation-summary.js";
import type { ConversationActivityState } from "../web/src/conversation-activity.js";
import type { ConversationEventRecord } from "../web/src/conversations.js";

/**
 * P8 (accepted `conversation-p8-pilot-correction-contract.md` §4) — collapsed
 * bounded in-memory run summaries captured at the durable terminal from
 * already-received U4 partial text + terminal truth. In-memory ONLY for the
 * current selected Conversation; most recent per agent, ≤4; never
 * reconstructed from history/storage/provider/private info. This module does
 * not exist yet: RED.
 */

const CID = "20260813T000000000Z-p8";

function activityState(runs: Array<{ agent: string; partial: string; truncated?: boolean }>): ConversationActivityState {
  return { runs: runs.map((run) => ({ runId: `run-${run.agent}`, agent: run.agent, phase: "typing", partial: run.partial, truncated: run.truncated ?? false })), settled: [] };
}

function terminal(agent: string, overrides: Partial<ConversationEventRecord> = {}): ConversationEventRecord {
  return {
    id: `t-${agent}`,
    conversationId: CID,
    kind: "run_finished",
    authorKind: "system",
    author: "system",
    created: "2026-08-13T00:00:00.000Z",
    sequence: 9,
    mentions: [],
    body: "done",
    path: "p",
    runStatus: "failed",
    failureKind: "provider_error",
    runAgent: agent,
    ...overrides,
  } as ConversationEventRecord;
}

describe("captureConversationRunSummary (P8 §4)", () => {
  it("captures exact agent, already-permitted U4 partial, and truthful terminal state", () => {
    const summaries = captureConversationRunSummary(
      emptyConversationRunSummaries(),
      activityState([{ agent: "dipu", partial: "Hello " }]),
      terminal("dipu", { runStatus: "failed", failureKind: "provider_error" }),
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      agent: "dipu",
      partial: "Hello ",
      truncated: false,
      terminal: { runStatus: "failed", failureKind: "provider_error" },
    });
  });

  it("keeps the most recent run PER AGENT (replaces, never duplicates)", () => {
    let summaries = captureConversationRunSummary(
      emptyConversationRunSummaries(),
      activityState([{ agent: "dipu", partial: "first" }]),
      terminal("dipu", { runStatus: "completed" }),
    );
    summaries = captureConversationRunSummary(
      summaries,
      activityState([{ agent: "dipu", partial: "second" }]),
      terminal("dipu", { runStatus: "failed", failureKind: "ambiguous" }),
    );
    expect(summaries.filter((summary) => summary.agent === "dipu")).toHaveLength(1);
    expect(summaries[0]?.partial).toBe("second");
    expect(summaries[0]?.terminal.failureKind).toBe("ambiguous");
  });

  it("bounds the total to the most recent ≤4 runs", () => {
    let summaries = emptyConversationRunSummaries();
    for (let index = 0; index < 10; index += 1) {
      const agent = `agent-${String(index).padStart(2, "0")}`;
      summaries = captureConversationRunSummary(
        summaries,
        activityState([{ agent, partial: `reply-${index}` }]),
        terminal(agent, { runStatus: "completed" }),
      );
    }
    expect(summaries.length).toBeLessThanOrEqual(CONVERSATION_RUN_SUMMARY_MAX);
    expect(summaries.map((summary) => summary.agent)).toEqual(["agent-06", "agent-07", "agent-08", "agent-09"]);
  });

  it("records an empty partial truthfully (no fabricated text) and bounded truncation truthfully", () => {
    const noText = captureConversationRunSummary(
      emptyConversationRunSummaries(),
      activityState([]),
      terminal("dipu", { runStatus: "failed", failureKind: "provider_error" }),
    );
    expect(noText[0]).toMatchObject({ agent: "dipu", partial: "", terminal: { runStatus: "failed", failureKind: "provider_error" } });

    const truncated = captureConversationRunSummary(
      emptyConversationRunSummaries(),
      activityState([{ agent: "dipu", partial: "x".repeat(100), truncated: true }]),
      terminal("dipu", { runStatus: "completed" }),
    );
    expect(truncated[0]?.truncated).toBe(true);
  });

  it("a terminal without a runAgent never captures anything", () => {
    const legacy = { ...terminal("dipu"), runAgent: undefined } as unknown as ConversationEventRecord;
    const summaries = captureConversationRunSummary(emptyConversationRunSummaries(), activityState([{ agent: "dipu", partial: "x" }]), legacy);
    expect(summaries).toHaveLength(0);
  });

  it("clearConversationRunSummaries empties the in-memory set", () => {
    const summaries = captureConversationRunSummary(
      emptyConversationRunSummaries(),
      activityState([{ agent: "dipu", partial: "x" }]),
      terminal("dipu"),
    );
    expect(clearConversationRunSummaries(summaries)).toEqual([]);
  });
});

describe("conversationRunSummaryTerminalLabel (truthful, non-secret)", () => {
  it("derives a bounded human label from the durable terminal only", () => {
    const summary: ConversationRunSummary = { agent: "dipu", partial: "", truncated: false, terminal: { runStatus: "failed", failureKind: "provider_error" } };
    const label = conversationRunSummaryTerminalLabel(summary);
    expect(typeof label).toBe("string");
    expect(label.length).toBeGreaterThan(0);
    expect(label.toLowerCase()).toContain("failed");
    // Never leaks raw provider/model internals.
    expect(label).not.toMatch(/403|RegionError|opencode|deepseek|workspace/i);
  });

  it("labels a completed run truthfully", () => {
    const summary: ConversationRunSummary = { agent: "dipu", partial: "ok", truncated: false, terminal: { runStatus: "completed" } };
    expect(conversationRunSummaryTerminalLabel(summary).toLowerCase()).toContain("completed");
  });
});
