import { describe, expect, it } from "vitest";
import {
  applyConversationActivityFrame,
  clearConversationActivity,
  clearConversationActivityForAgent,
  CONVERSATION_ACTIVITY_DELTA_MAX,
  CONVERSATION_ACTIVITY_PARTIAL_MAX,
  compactActivityRuns,
  conversationActivityLiveAnnouncement,
  conversationActivityRunAbortLabel,
  conversationWorkCards,
  emptyConversationActivity,
  parseConversationActivityFrame,
  reconcileConversationActivity,
  WORK_CARD_TAIL_RENDER_MAX,
  WORK_CARD_TEXT_RETENTION_MAX,
  WORK_CARD_TOOLS_MAX,
  type ConversationActivityFrame,
  type ConversationActivityState,
  type ConversationCompactActivityRun,
} from "../web/src/conversation-activity.js";
import { parseConversationEventRecord, type ConversationEventRecord } from "../web/src/conversations.js";

/**
 * U4 — broker-authoritative live activity web core (accepted
 * `conversation-live-activity-contract.md`). Strict fail-closed frame
 * parsing, per-run transient state (working → typing → settled), bounded
 * partial-reply accumulation with a truthful truncation marker, and durable
 * reconciliation (agent_message / terminal evidence clears transient state).
 * Activity is NEVER reconstructed from history and never becomes durable.
 */

const CID = "20260811T000000000Z-live";

function frame(kind: "working" | "text_delta" | "settled" | "tool", overrides: Partial<ConversationActivityFrame> = {}): ConversationActivityFrame {
  const base: ConversationActivityFrame = { conversationId: CID, runId: "run-0001", agent: "dipu", kind };
  if (kind === "text_delta") base.delta = "Hel";
  if (kind === "settled") base.outcome = "completed";
  if (kind === "tool") {
    base.toolName = "vault_read";
    base.status = "started";
  }
  return { ...base, ...overrides } as ConversationActivityFrame;
}

describe("parseConversationActivityFrame (strict, fail-closed)", () => {
  it("accepts valid working/text_delta/settled frames for the selected conversation", () => {
    expect(parseConversationActivityFrame(frame("working"), CID).ok).toBe(true);
    const delta = parseConversationActivityFrame(frame("text_delta"), CID);
    expect(delta.ok && delta.frame.delta).toBe("Hel");
    const settled = parseConversationActivityFrame(frame("settled"), CID);
    expect(settled.ok && settled.frame.outcome).toBe("completed");
  });

  it("rejects foreign conversations, malformed fields, unknown kinds, and forbidden combinations", () => {
    expect(parseConversationActivityFrame(frame("working"), "other-id").ok).toBe(false);
    for (const bad of [
      {},
      { conversationId: CID, runId: "", agent: "dipu", kind: "working" },
      { conversationId: CID, runId: "run-1", agent: "", kind: "working" },
      { conversationId: CID, runId: "run-1", agent: "dipu", kind: "bogus" },
      { ...frame("working"), delta: "x" }, // working must not carry delta
      { ...frame("working"), outcome: "completed" }, // working must not carry outcome
      { ...frame("text_delta"), delta: "" }, // empty delta
      { ...frame("text_delta"), delta: "x".repeat(CONVERSATION_ACTIVITY_DELTA_MAX + 1) }, // oversized
      { ...frame("text_delta"), outcome: "completed" }, // text_delta must not carry outcome
      { ...frame("settled"), delta: "x" }, // settled must not carry delta
      { ...frame("settled"), outcome: "bogus" }, // unknown outcome
    ]) {
      expect(parseConversationActivityFrame(bad, CID).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("VR-3 tool frames — strict fail-closed parsing", () => {
  const valid = { conversationId: CID, runId: "r9", agent: "zai", kind: "tool", toolName: "vault_read", status: "started" };

  it("accepts a well-formed tool frame with sanitized name and exact status", () => {
    const parsed = parseConversationActivityFrame(valid, CID);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.frame.kind === "tool") {
      expect(parsed.frame.toolName).toBe("vault_read");
      expect(parsed.frame.status).toBe("started");
    }
  });

  it.each([
    ["missing name", { ...valid, toolName: undefined }],
    ["non-string name", { ...valid, toolName: 7 }],
    ["empty name", { ...valid, toolName: "" }],
    ["oversized name (>80)", { ...valid, toolName: "a".repeat(81) }],
    ["hostile characters in name", { ...valid, toolName: "vault_read; rm -rf" }],
    ["newline injection in name", { ...valid, toolName: "read\n<script>" }],
    ["missing status", { ...valid, status: undefined }],
    ["unknown status", { ...valid, status: "succeeded" }],
    ["non-string status", { ...valid, status: 1 }],
    ["carries delta", { ...valid, delta: "leak" }],
    ["carries outcome", { ...valid, outcome: "completed" }],
    ["carries arguments-shaped field", { ...valid, args: { path: "/etc/passwd" } }],
    ["carries result-shaped field", { ...valid, result: "file contents" }],
    ["carries output field", { ...valid, output: "stdout" }],
    ["carries environment field", { ...valid, env: { TOKEN: "x" } }],
    ["carries input field", { ...valid, input: "raw" }],
    ["carries token field", { ...valid, token: "secret" }],
    ["carries unknown scalar own field", { ...valid, note: "x" }],
    ["carries unknown nested details field", { ...valid, details: { path: "leak" } }],
    ["carries unknown own field alongside valid shape", { ...valid, extra: true }],
    ["foreign conversation", { ...valid, conversationId: "other" }],
    ["invalid runId", { ...valid, runId: "" }],
  ])("rejects %s fail-closed", (_label, bad) => {
    expect(parseConversationActivityFrame(bad, CID).ok).toBe(false);
  });
});

describe("VR-3 correction — tool frame closed own-key schema", () => {
  it("accepts ONLY the exact own-key shape {conversationId,runId,agent,kind,toolName,status}", () => {
    const exact = { conversationId: CID, runId: "r9", agent: "zai", kind: "tool", toolName: "vault_read", status: "started" };
    const parsed = parseConversationActivityFrame(exact, CID);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.frame.kind === "tool") {
      expect(Object.keys(parsed.frame).sort()).toEqual(["agent", "conversationId", "kind", "runId", "status", "toolName"]);
    }
  });
});

describe("transient activity state machine (per-run)", () => {
  it("working sets a working run; the first text_delta flips it to typing and accumulates the exact deltas", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1" }));
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({ runId: "r1", agent: "dipu", phase: "working", partial: "" });

    state = applyConversationActivityFrame(state, frame("text_delta", { runId: "r1", delta: "Hel" }));
    state = applyConversationActivityFrame(state, frame("text_delta", { runId: "r1", delta: "lo" }));
    expect(state.runs[0]).toMatchObject({ runId: "r1", phase: "typing", partial: "Hello" });
  });

  it("settled clears exactly that run and leaves other runs alone", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1" }));
    state = applyConversationActivityFrame(state, frame("working", { runId: "r2", agent: "zai" }));
    state = applyConversationActivityFrame(state, frame("settled", { runId: "r1" }));
    expect(state.runs.map((run) => run.runId)).toEqual(["r2"]);
  });

  it("a text_delta without a preceding working frame still shows truthful typing (tolerates lost frames)", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("text_delta", { runId: "r3", delta: "Hi" }));
    expect(state.runs[0]).toMatchObject({ runId: "r3", phase: "typing", partial: "Hi" });
  });

  it("VR-3: retains at most the MOST RECENT streamed characters with a truthful truncation marker", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1" }));
    const chunk = "a".repeat(100);
    const iterations = Math.floor(WORK_CARD_TEXT_RETENTION_MAX / 100) + 4;
    for (let index = 0; index < iterations; index += 1) {
      state = applyConversationActivityFrame(state, frame("text_delta", { runId: "r1", delta: `${chunk}-${index};` }));
    }
    const run = state.runs[0];
    expect(run?.partial.length).toBe(WORK_CARD_TEXT_RETENTION_MAX - (WORK_CARD_TEXT_RETENTION_MAX % 100));
    expect(run?.truncated).toBe(true);
    // Rolling retention keeps the MOST RECENT content, not the head.
    expect(run?.partial.endsWith(`-${iterations - 1};`)).toBe(true);
  });

  it("VR-3: tool frames append to the run's bounded most-recent tool lines in order", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working"));
    for (let index = 0; index < WORK_CARD_TOOLS_MAX + 2; index += 1) {
      state = applyConversationActivityFrame(state, frame("tool", { toolName: `tool_${index}`, status: "started" }));
    }
    const run = state.runs[0];
    expect(run?.tools).toHaveLength(WORK_CARD_TOOLS_MAX);
    // The five MOST RECENT events survive, in order.
    expect(run?.tools.map((t) => t.name)).toEqual(["tool_2", "tool_3", "tool_4", "tool_5", "tool_6"]);
    state = applyConversationActivityFrame(state, frame("tool", { toolName: "tool_6", status: "failed" }));
    expect(state.runs[0]?.tools.at(-1)).toEqual({ name: "tool_6", status: "failed" });
  });

  it("VR-3: a tool frame without a preceding working frame still shows truthful working state (tolerates lost frames)", () => {
    const state = applyConversationActivityFrame(emptyConversationActivity(), frame("tool", { toolName: "bash", status: "completed" }));
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({ agent: "dipu", phase: "working" });
    expect(state.runs[0]?.tools).toEqual([{ name: "bash", status: "completed" }]);
  });

  it("VR-3: settled/durable-reconciliation clears the run together with its transient tail and tools", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working"));
    state = applyConversationActivityFrame(state, frame("text_delta", { delta: "visible tail" }));
    state = applyConversationActivityFrame(state, frame("tool", { toolName: "bash", status: "started" }));
    state = applyConversationActivityFrame(state, frame("settled"));
    expect(state.runs).toHaveLength(0);
    // Durable evidence is authoritative too.
    state = applyConversationActivityFrame(state, frame("working"));
    state = applyConversationActivityFrame(state, frame("text_delta", { delta: "more" }));
    state = reconcileConversationActivity(state, {
      id: "e1", conversationId: CID, kind: "agent_message", authorKind: "agent", author: "dipu",
      created: "2026-08-25T00:00:00.000Z", sequence: 2, mentions: [], body: "done", path: "p",
    });
    expect(state.runs).toHaveLength(0);
  });
});

describe("durable reconciliation (transient is never promoted)", () => {
  it("a durable agent_message for the agent replaces/clears that transient partial", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1" }));
    state = applyConversationActivityFrame(state, frame("text_delta", { runId: "r1", delta: "partial" }));
    const event: ConversationEventRecord = {
      id: "e1", conversationId: CID, kind: "agent_message", authorKind: "agent", author: "dipu",
      created: "2026-08-11T00:00:00.000Z", sequence: 5, mentions: [], body: "final", path: "p",
    };
    state = reconcileConversationActivity(state, event);
    expect(state.runs).toHaveLength(0);
  });

  it("a durable terminal with runAgent clears the remaining activity for that agent", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1" }));
    const event = parseConversationEventRecord({
      id: "e2", conversationId: CID, kind: "run_finished", authorKind: "system", author: "system",
      created: "2026-08-11T00:00:00.000Z", sequence: 6, mentions: [], body: "done", path: "p",
      runStatus: "completed", runAgent: "dipu",
    });
    state = reconcileConversationActivity(state, event);
    expect(state.runs).toHaveLength(0);
  });

  it("unrelated events and legacy terminals without runAgent leave activity untouched", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1" }));
    const unrelated = parseConversationEventRecord({
      id: "e3", conversationId: CID, kind: "steward_message", authorKind: "steward", author: "steward",
      created: "2026-08-11T00:00:00.000Z", sequence: 7, mentions: [], body: "hi", path: "p",
    });
    const legacyTerminal = parseConversationEventRecord({
      id: "e4", conversationId: CID, kind: "run_finished", authorKind: "system", author: "system",
      created: "2026-08-11T00:00:00.000Z", sequence: 8, mentions: [], body: "done", path: "p",
      runStatus: "completed",
    });
    state = reconcileConversationActivity(state, unrelated);
    state = reconcileConversationActivity(state, legacyTerminal);
    expect(state.runs).toHaveLength(1);
  });

  it("clearConversationActivityForAgent removes only the named agent", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1", agent: "dipu" }));
    state = applyConversationActivityFrame(state, frame("working", { runId: "r2", agent: "zai" }));
    state = clearConversationActivityForAgent(state, "dipu");
    expect(state.runs.map((run) => run.agent)).toEqual(["zai"]);
  });
});

describe("runAgent durable metadata parsing (U4)", () => {
  it("parses runAgent on run events and tolerates absent values on old records", () => {
    const withAgent = parseConversationEventRecord({
      id: "e5", conversationId: CID, kind: "run_finished", authorKind: "system", author: "system",
      created: "2026-08-11T00:00:00.000Z", sequence: 9, mentions: [], body: "done", path: "p",
      runStatus: "completed", runAgent: "dipu",
    });
    expect(withAgent.runAgent).toBe("dipu");
    const legacy = parseConversationEventRecord({
      id: "e6", conversationId: CID, kind: "run_started", authorKind: "system", author: "system",
      created: "2026-08-11T00:00:00.000Z", sequence: 10, mentions: [], body: "start", path: "p",
      runStatus: "running",
    });
    expect(legacy.runAgent).toBeUndefined();
  });

  it("rejects a present-but-invalid runAgent fail-closed", () => {
    expect(() =>
      parseConversationEventRecord({
        id: "e7", conversationId: CID, kind: "run_started", authorKind: "system", author: "system",
        created: "2026-08-11T00:00:00.000Z", sequence: 11, mentions: [], body: "start", path: "p",
        runStatus: "running", runAgent: 42,
      }),
    ).toThrow(/runAgent/);
    expect(() =>
      parseConversationEventRecord({
        id: "e8", conversationId: CID, kind: "run_cancelled", authorKind: "system", author: "system",
        created: "2026-08-11T00:00:00.000Z", sequence: 12, mentions: [], body: "cancel", path: "p",
        runStatus: "cancelled", runAgent: "",
      }),
    ).toThrow(/runAgent/);
  });
});

describe("fail-closed invalid/stale/contradictory activity (U4 correction)", () => {
  it("clearConversationActivity removes every transient run while keeping settled tombstones", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1" }));
    state = applyConversationActivityFrame(state, frame("settled", { runId: "r1" }));
    state = applyConversationActivityFrame(state, frame("working", { runId: "r2", agent: "zai" }));
    const cleared = clearConversationActivity(state);
    expect(cleared.runs).toHaveLength(0);
    expect(cleared.settled).toContain("r1");
  });

  it("a delayed working/text_delta for a settled run is stale and never resurrects it", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1" }));
    state = applyConversationActivityFrame(state, frame("text_delta", { runId: "r1", delta: "Hel" }));
    state = applyConversationActivityFrame(state, frame("settled", { runId: "r1" }));
    expect(state.runs).toHaveLength(0);
    // Delayed frames for the settled run are ignored (no typing recreation).
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1" }));
    expect(state.runs).toHaveLength(0);
    state = applyConversationActivityFrame(state, frame("text_delta", { runId: "r1", delta: "late" }));
    expect(state.runs).toHaveLength(0);
    // A fresh, never-settled runId still shows truthful typing.
    state = applyConversationActivityFrame(state, frame("text_delta", { runId: "r9", delta: "fresh" }));
    expect(state.runs[0]).toMatchObject({ runId: "r9", phase: "typing", partial: "fresh" });
  });

  it("a structurally valid frame with a different agent for a known runId is contradictory and clears activity", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1", agent: "dipu" }));
    state = applyConversationActivityFrame(state, frame("text_delta", { runId: "r1", agent: "dipu", delta: "Hel" }));
    // Same runId, different agent: contradictory evidence — fail closed.
    state = applyConversationActivityFrame(state, frame("text_delta", { runId: "r1", agent: "zai", delta: "x" }));
    expect(state.runs).toHaveLength(0);
    // A later consistent working frame for the same runId/agent starts fresh.
    state = applyConversationActivityFrame(state, frame("working", { runId: "r1", agent: "dipu" }));
    expect(state.runs[0]).toMatchObject({ runId: "r1", agent: "dipu", phase: "working" });
  });

  it("settled tombstones are bounded (never unbounded memory)", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    for (let index = 0; index < 100; index += 1) {
      const runId = `run-${String(index).padStart(4, "0")}`;
      state = applyConversationActivityFrame(state, frame("working", { runId }));
      state = applyConversationActivityFrame(state, frame("settled", { runId }));
    }
    expect(state.settled.length).toBeLessThanOrEqual(32);
    // The earliest tombstone was dropped; the newest ones are retained.
    expect(state.settled).toContain("run-0099");
    expect(state.settled).not.toContain("run-0000");
  });
});

describe("U1 status-only card helpers (pure)", () => {
  it("labels the scoped abort action as the exact agent's current work", () => {
    expect(conversationActivityRunAbortLabel("dipu")).toBe("Abort Dipu's current work");
    expect(conversationActivityRunAbortLabel("zai")).toBe("Abort Zai's current work");
  });

  function run(runId: string, agent: string, phase: "working" | "typing"): ConversationCompactActivityRun {
    return { runId, agent, phase };
  }

  it("announces one polite line per card appearance, phase transition, and removal (never per token)", () => {
    // Appearance (working).
    expect(conversationActivityLiveAnnouncement([], [run("r1", "dipu", "working")])).toBe("Dipu is working…");
    // working -> typing transition.
    expect(conversationActivityLiveAnnouncement([run("r1", "dipu", "working")], [run("r1", "dipu", "typing")])).toBe("Dipu is typing…");
    // Removal (neutral, never a completion/failure claim).
    expect(conversationActivityLiveAnnouncement([run("r1", "dipu", "typing")], [])).toBe("Dipu is no longer working");
  });

  it("returns null when the card set is byte-identical (no redundant announcement)", () => {
    const before = [run("r1", "dipu", "working")];
    const after = [run("r1", "dipu", "working")];
    expect(conversationActivityLiveAnnouncement(before, after)).toBeNull();
    expect(conversationActivityLiveAnnouncement([], [])).toBeNull();
  });

  it("joins simultaneous changes into one announcement and leaves unrelated runs unannounced", () => {
    const previous = [run("r1", "dipu", "working"), run("r2", "zai", "typing")];
    const next = [run("r2", "zai", "typing"), run("r3", "kim", "working")];
    // r1 removed, r3 appeared; r2 unchanged (not re-announced).
    expect(conversationActivityLiveAnnouncement(previous, next)).toBe("Kim is working…. Dipu is no longer working");
  });
});

describe("VR-3 conversationWorkCards — safe bounded render projection", () => {
  function buildState(): ConversationActivityState {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working"));
    state = applyConversationActivityFrame(state, frame("text_delta", { delta: "short tail" }));
    state = applyConversationActivityFrame(state, frame("tool", { toolName: "vault_read", status: "started" }));
    state = applyConversationActivityFrame(state, frame("tool", { toolName: "bash", status: "completed" }));
    return state;
  }

  it("projects the exact agent/phase plus a plain-text tail and sanitized tool lines", () => {
    const cards = conversationWorkCards(buildState());
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.runId).toBe("run-0001");
    expect(card.agent).toBe("dipu");
    expect(card.phase).toBe("typing");
    expect(card.textTail).toBe("short tail");
    expect(card.tools).toEqual([
      { name: "vault_read", status: "started" },
      { name: "bash", status: "completed" },
    ]);
  });

  it("renders ONLY the most recent 400 characters with exactly one leading ellipsis when truncated", () => {
    let state: ConversationActivityState = emptyConversationActivity();
    state = applyConversationActivityFrame(state, frame("working"));
    const long = "x".repeat(WORK_CARD_TAIL_RENDER_MAX + 50) + "THE-END";
    state = applyConversationActivityFrame(state, frame("text_delta", { delta: long }));
    const card = conversationWorkCards(state)[0]!;
    expect(card.textTail).toBe(`…${"x".repeat(WORK_CARD_TAIL_RENDER_MAX - "THE-END".length)}THE-END`);
    expect(card.textTail?.length).toBe(WORK_CARD_TAIL_RENDER_MAX + 1); // tail + one ellipsis
    // Under the threshold: no ellipsis.
    let short: ConversationActivityState = emptyConversationActivity();
    short = applyConversationActivityFrame(short, frame("working"));
    short = applyConversationActivityFrame(short, frame("text_delta", { delta: "abc" }));
    expect(conversationWorkCards(short)[0]?.textTail).toBe("abc");
    // No text at all: null tail (never an empty-string fabrication).
    let empty: ConversationActivityState = emptyConversationActivity();
    empty = applyConversationActivityFrame(empty, frame("working"));
    expect(conversationWorkCards(empty)[0]?.textTail).toBeNull();
  });

  it("the projection carries no raw payload fields — only name/status/tool text", () => {
    const card = conversationWorkCards(buildState())[0]!;
    expect(Object.keys(card).sort()).toEqual(["agent", "phase", "runId", "textTail", "tools"]);
    expect(Object.keys(card.tools[0]!).sort()).toEqual(["name", "status"]);
  });
});
