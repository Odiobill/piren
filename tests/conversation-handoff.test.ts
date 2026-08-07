import { describe, expect, it } from "vitest";
import type { ConversationEventRecord } from "../src/conversations.js";
import {
  CONVERSATION_HANDOFF_MAX_DEPTH,
  CONVERSATION_HANDOFF_MAX_EDGES,
  CONVERSATION_HANDOFF_MAX_REWORK_ROUNDS,
  buildConversationStagePrompt,
  deriveConversationWorkflowState,
  parseConversationHandoffRequest,
  planConversationHandoffEdge,
} from "../src/conversation-handoff.js";

/**
 * C5-1 — pure Conversation handoff protocol core. Versioned `{to, text}`
 * request parsing, durable-workflow budget derivation, deterministic
 * server-side target planning, and the bounded stage prompt. No filesystem,
 * network, or Pi auth; everything is directly unit-testable.
 */

function event(overrides?: Partial<Record<string, unknown>>): ConversationEventRecord {
  return {
    id: "e1",
    conversationId: "c1",
    kind: "steward_message",
    authorKind: "steward",
    author: "steward",
    created: "2026-08-07T00:00:00.000Z",
    sequence: 1,
    mentions: [],
    body: "Go",
    path: "collaboration/conversations/c1/events/00000001.md",
    ...overrides,
  } as ConversationEventRecord;
}

function handoffEvent(seq: number, source: string, target: string, rootId: string, id: string): ConversationEventRecord {
  return event({
    id,
    kind: "agent_message",
    authorKind: "agent",
    author: source,
    sequence: seq,
    body: `handoff to ${target}`,
    correlationId: rootId,
    addressedAgent: target,
  });
}

describe("parseConversationHandoffRequest (pure, bounded)", () => {
  it("accepts a versioned {v, to, text} envelope and a plain {to, text}", () => {
    expect(parseConversationHandoffRequest({ v: 1, to: "dipu", text: "Please review" })).toEqual({
      ok: true,
      request: { to: "dipu", text: "Please review" },
    });
    expect(parseConversationHandoffRequest({ to: "dipu", text: "Please review" })).toEqual({
      ok: true,
      request: { to: "dipu", text: "Please review" },
    });
  });

  it("rejects non-object, version-mismatched, and unknown-shape input", () => {
    expect(parseConversationHandoffRequest(null)).toMatchObject({ ok: false });
    expect(parseConversationHandoffRequest("x")).toMatchObject({ ok: false });
    expect(parseConversationHandoffRequest({ v: 99, to: "dipu", text: "x" })).toMatchObject({ ok: false });
    expect(parseConversationHandoffRequest([])).toMatchObject({ ok: false });
  });

  it("rejects missing, blank, or invalid target names", () => {
    expect(parseConversationHandoffRequest({ to: "", text: "x" })).toMatchObject({ ok: false });
    expect(parseConversationHandoffRequest({ to: "Not Valid", text: "x" })).toMatchObject({ ok: false });
    expect(parseConversationHandoffRequest({ to: 7, text: "x" })).toMatchObject({ ok: false });
  });

  it("rejects blank or oversized request text", () => {
    expect(parseConversationHandoffRequest({ to: "dipu", text: "   " })).toMatchObject({ ok: false });
    expect(parseConversationHandoffRequest({ to: "dipu", text: "x".repeat(4001) })).toMatchObject({ ok: false });
    expect(parseConversationHandoffRequest({ to: "dipu", text: "ok" })).toEqual({ ok: true, request: { to: "dipu", text: "ok" } });
  });
});

describe("deriveConversationWorkflowState (pure, from durable events)", () => {
  const ROOT = "root-1";

  it("identifies handoff edges only as correlated agent_message events with an addressed agent", () => {
    const events = [
      event({ id: ROOT, sequence: 1, mentions: ["zai"] }),
      event({ id: "e2", kind: "agent_message", authorKind: "agent", author: "zai", sequence: 2, body: "reply", correlationId: ROOT }),
      handoffEvent(3, "zai", "dipu", ROOT, "h1"),
      handoffEvent(4, "dipu", "kimi", ROOT, "h2"),
      event({ id: "e5", kind: "run_finished", authorKind: "system", author: "system", sequence: 5, body: "done", correlationId: ROOT }),
    ];
    const state = deriveConversationWorkflowState(events, ROOT);
    expect(state.rootEventId).toBe(ROOT);
    expect(state.rootAgent).toBe("zai");
    expect(state.edges.map((e) => [e.source, e.target])).toEqual([
      ["zai", "dipu"],
      ["dipu", "kimi"],
    ]);
    expect(state.depthByAgent.get("zai")).toBe(0);
    expect(state.depthByAgent.get("dipu")).toBe(1);
    expect(state.depthByAgent.get("kimi")).toBe(2);
    expect(state.pairOccurrences.get("zai->dipu")).toBe(1);
  });

  it("counts repeated source→target pairs as rework occurrences", () => {
    const events = [
      event({ id: ROOT, sequence: 1, mentions: ["sam"] }),
      handoffEvent(2, "sam", "dipu", ROOT, "h1"),
      handoffEvent(3, "dipu", "kimi", ROOT, "h2"),
      handoffEvent(4, "kimi", "sam", ROOT, "h3"),
      handoffEvent(5, "sam", "dipu", ROOT, "h4"),
    ];
    const state = deriveConversationWorkflowState(events, ROOT);
    expect(state.pairOccurrences.get("sam->dipu")).toBe(2);
    expect(state.pairOccurrences.get("kimi->sam")).toBe(1);
    expect(state.depthByAgent.get("sam")).toBe(0);
  });

  it("ignores events of other workflows and returns an empty state for a missing root", () => {
    const events = [handoffEvent(2, "zai", "dipu", "other-root", "h1")];
    const empty = deriveConversationWorkflowState(events, ROOT);
    expect(empty.edges).toEqual([]);
    expect(empty.rootAgent).toBeUndefined();
    expect(empty.depthByAgent.size).toBe(0);
    // A normal agent reply without an addressed agent is never an edge.
    const noEdge = deriveConversationWorkflowState(
      [event({ id: ROOT, sequence: 1, mentions: ["zai"] }), event({ id: "r", kind: "agent_message", authorKind: "agent", author: "zai", sequence: 2, correlationId: ROOT, body: "plain reply" })],
      ROOT,
    );
    expect(noEdge.edges).toEqual([]);
  });
});

describe("planConversationHandoffEdge (pure, deterministic, bounded)", () => {
  const ROOT = "root-1";
  const RUNNABLE = ["zai", "dipu", "kimi", "sam"];
  const workflowFor = (edges: Array<[string, string]>): ReturnType<typeof deriveConversationWorkflowState> => {
    const events: ConversationEventRecord[] = [event({ id: ROOT, sequence: 1, mentions: ["zai"] })];
    edges.forEach(([s, t], i) => events.push(handoffEvent(i + 2, s, t, ROOT, `h${i + 1}`)));
    return deriveConversationWorkflowState(events, ROOT);
  };
  const plan = (workflow: ReturnType<typeof deriveConversationWorkflowState>, source: string, to: string) =>
    planConversationHandoffEdge({
      conversationId: "c1",
      sourceAgent: source,
      request: { to, text: "help" },
      runnableAgents: RUNNABLE,
      activeKeys: [],
      workflow,
    });

  it("accepts a valid in-budget edge and returns the target depth", () => {
    const result = plan(workflowFor([]), "zai", "dipu");
    expect(result).toEqual({ ok: true, depth: 1 });
    expect(plan(workflowFor([["zai", "dipu"]]), "dipu", "kimi")).toEqual({ ok: true, depth: 2 });
  });

  it("rejects self-handoff, non-runnable targets, and active targets with bounded reasons", () => {
    expect(plan(workflowFor([]), "zai", "zai")).toMatchObject({ ok: false, reason: /self/ });
    expect(plan(workflowFor([]), "zai", "ghost")).toMatchObject({ ok: false, reason: /not locally runnable/ });
    const active = planConversationHandoffEdge({
      conversationId: "c1",
      sourceAgent: "zai",
      request: { to: "dipu", text: "help" },
      runnableAgents: RUNNABLE,
      activeKeys: ["c1:dipu"],
      workflow: workflowFor([]),
    });
    expect(active).toMatchObject({ ok: false, reason: /has an active run/ });
  });

  it("rejects a source that is not part of the workflow", () => {
    expect(plan(workflowFor([]), "sam", "dipu")).toMatchObject({ ok: false, reason: /not part of the workflow/ });
  });

  it("enforces the finite budgets: edges, depth, and rework rounds", () => {
    // Edges: 8 consumed -> the 9th is rejected.
    const fullEdges = Array.from({ length: CONVERSATION_HANDOFF_MAX_EDGES }, (_, i) => [`zai`, `a${i}`] as [string, string]);
    const edgesWorkflow = workflowFor(fullEdges);
    expect(edgesWorkflow.edges.length).toBe(CONVERSATION_HANDOFF_MAX_EDGES);
    expect(plan(edgesWorkflow, "zai", "dipu")).toMatchObject({ ok: false, reason: /budget exhausted: edges/ });

    // Depth: a stage at max depth cannot hand off.
    const depthWorkflow = workflowFor([["zai", "dipu"], ["dipu", "kimi"], ["kimi", "sam"]]);
    expect(plan(depthWorkflow, "sam", "zai")).toMatchObject({ ok: false, reason: /budget exhausted: depth/ });
    expect(plan(depthWorkflow, "kimi", "sam")).toEqual({ ok: true, depth: 3 });

    // Rework: a pair may occur up to 1 + maxReworkRounds times.
    const reworkEdges: Array<[string, string]> = [
      ["zai", "dipu"], ["dipu", "kimi"], ["kimi", "zai"],
      ["zai", "dipu"], ["dipu", "kimi"], ["kimi", "zai"],
      ["zai", "dipu"], ["dipu", "kimi"],
    ];
    const reworkWorkflow = workflowFor(reworkEdges);
    expect(reworkWorkflow.pairOccurrences.get("zai->dipu")).toBe(CONVERSATION_HANDOFF_MAX_REWORK_ROUNDS + 1);
    expect(plan(reworkWorkflow, "zai", "dipu")).toMatchObject({ ok: false, reason: /budget exhausted: rework/ });
    // Exactly 1 + maxRework - 1 occurrences is still allowed.
    const nearlyWorkflow = workflowFor([["zai", "dipu"], ["dipu", "kimi"], ["kimi", "zai"]]);
    expect(plan(nearlyWorkflow, "zai", "dipu")).toEqual({ ok: true, depth: 1 });
  });
});

describe("buildConversationStagePrompt (pure, bounded)", () => {
  it("renders the handoff request with prior context and workflow identity, never raw ids beyond the bounded ones", () => {
    const prompt = buildConversationStagePrompt({
      conversationId: "c1",
      agent: "dipu",
      sourceAgent: "zai",
      text: "Please review the diff",
      rootEventId: "root-1",
      handoffEventId: "h1",
      depth: 1,
      priorLines: ["[t] zai: context line"],
      truncated: false,
      omittedCount: 0,
    });
    expect(prompt).toContain("conversation 'c1'");
    expect(prompt).toContain("agent 'dipu'");
    expect(prompt).toContain("Agent 'zai' has handed off");
    expect(prompt).toContain("Please review the diff");
    expect(prompt).toContain("context line");
    expect(prompt).toContain("workflow root 'root-1'");
    expect(prompt).toContain("handoff 'h1'");
  });
});
