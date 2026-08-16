// @vitest-environment node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  conversationStartOriginPresentation,
  groupConversationTranscript,
  type ConversationTranscriptRow,
} from "../web/src/conversation-transcript.js";
import {
  appendConversationLiveItem,
  replaceConversationHistoric,
  type ConversationTimelineItem,
} from "../web/src/conversation-timeline.js";
import { parseConversationEventRecord, type ConversationEventRecord } from "../web/src/conversations.js";

/**
 * D3 — agent-first Conversation event projection (accepted
 * `workbench-dashboard-refinement-plan.md` Conversation presentation
 * decisions 1–3): the durable `conversation_start_requested` origin stays
 * visible as the meaningful agent-first start marker, while ONLY the
 * redundant successful system run envelopes for that special path — the
 * `run_started` correlated to the exact durable origin id, and the
 * correlated `run_finished` only when its durable terminal status is exactly
 * `completed` — are omitted. The durable agent greeting remains the normal
 * successful acknowledgement: no status/reaction chip, inferred
 * acknowledgement, or fabricated outcome replaces the omitted envelopes.
 * Every failure, malformed/unattributed/uncorrelated run, ordinary
 * steward-message run, C5 handoff run, and unrelated event kind keeps its
 * current display path. Suppression uses ONLY exact durable event fields
 * (kind, correlationId, runAgent, runStatus) and the actual origin id —
 * never text, ordering, agent name, or guessed correlation. Historic and
 * live paths share the one pure grouping.
 */

const CID = "20260816T000000000Z-d3";

function event(overrides: Partial<ConversationEventRecord>): ConversationEventRecord {
  return parseConversationEventRecord({
    id: "e1",
    conversationId: CID,
    kind: "steward_message",
    authorKind: "steward",
    author: "steward",
    created: "2026-08-16T00:00:00.000Z",
    sequence: 1,
    mentions: [],
    body: "x",
    path: "collaboration/conversations/c1/events/00000001.md",
    ...overrides,
  });
}

/** System-authored run evidence (the broker's durable shape). */
function run(kind: ConversationEventRecord["kind"], overrides: Partial<ConversationEventRecord>): ConversationEventRecord {
  return event({
    kind,
    authorKind: "system",
    author: "system",
    ...overrides,
  });
}

/** The durable agent-first origin (gateway-persisted before dispatch). */
function origin(id = "o1", sequence = 1): ConversationEventRecord {
  return event({
    id,
    kind: "conversation_start_requested",
    authorKind: "system",
    author: "system",
    body: "The steward requested starting this conversation with agent 'dipu'.",
    sequence,
  });
}

function item(eventRecord: ConversationEventRecord): Extract<ConversationTimelineItem, { type: "event" }> {
  return { type: "event" as const, id: eventRecord.id, event: eventRecord };
}

function rowIds(rows: ConversationTranscriptRow[]): string[] {
  return rows.map((row) => (row.type === "error" ? row.id : row.event.id));
}

function rowFor(rows: ConversationTranscriptRow[], id: string): ConversationTranscriptRow {
  const row = rows.find((candidate) => candidate.type !== "error" && candidate.event.id === id);
  if (row === undefined) throw new Error(`row missing: ${id}`);
  return row;
}

function allReactionLabels(rows: ConversationTranscriptRow[]): string[] {
  const labels: string[] = [];
  for (const row of rows) {
    if (row.type === "message") {
      for (const status of row.statuses) labels.push(status.reaction.label);
    } else if (row.type === "evidence" && row.reaction !== null) {
      labels.push(row.reaction.label);
    }
  }
  return labels;
}

/** The successful agent-first durable sequence (origin → run → greeting → completed terminal). */
function agentFirstItems(): Array<Extract<ConversationTimelineItem, { type: "event" }>> {
  return [
    item(origin()),
    item(run("run_started", { id: "r1", correlationId: "o1", runAgent: "dipu", runStatus: "running", sequence: 2 })),
    item(event({ id: "am1", kind: "agent_message", authorKind: "agent", author: "dipu", body: "Hello! How can I help?", correlationId: "o1", sequence: 3 })),
    item(run("run_finished", { id: "r2", correlationId: "o1", runAgent: "dipu", runStatus: "completed", sequence: 4 })),
  ];
}

describe("D3 agent-first start envelope projection", () => {
  it("keeps the exact durable start origin visible and omits only its correlated successful envelopes", () => {
    const rows = groupConversationTranscript(agentFirstItems());
    // Only the origin and the durable greeting remain, in durable order.
    expect(rowIds(rows)).toEqual(["o1", "am1"]);
    const originRow = rowFor(rows, "o1");
    expect(originRow.type).toBe("evidence");
    if (originRow.type === "evidence") {
      expect(originRow.event.kind).toBe("conversation_start_requested");
      // The origin is not a run: no status chip mapping.
      expect(originRow.reaction).toBeNull();
    }
    const greeting = rowFor(rows, "am1");
    expect(greeting.type).toBe("message");
  });

  it("fabricates no received/completed chip or inferred acknowledgement in place of the omitted envelopes", () => {
    const rows = groupConversationTranscript(agentFirstItems());
    // The greeting itself is the acknowledgement; nothing replaces the
    // omitted run_started/run_finished with a status cluster or chip.
    expect(allReactionLabels(rows)).toEqual([]);
    const greeting = rowFor(rows, "am1");
    if (greeting.type !== "message") throw new Error("expected message row");
    expect(greeting.statuses).toEqual([]);
    expect(greeting.event.body).toBe("Hello! How can I help?");
  });

  it("keeps a failed terminal correlated to the origin visible", () => {
    const rows = groupConversationTranscript([
      item(origin()),
      item(run("run_started", { id: "r1", correlationId: "o1", runAgent: "dipu", sequence: 2 })),
      item(run("run_finished", { id: "r2", correlationId: "o1", runAgent: "dipu", runStatus: "failed", failureKind: "launch_failure", sequence: 3 })),
    ]);
    // run_started is still the redundant envelope; the FAILED terminal is
    // the meaningful evidence and stays visible.
    expect(rowIds(rows)).toEqual(["o1", "r2"]);
    expect(rowFor(rows, "r2").type).toBe("evidence");
  });

  it("keeps timed-out, cancelled, and unknown-status terminals correlated to the origin visible", () => {
    for (const [kind, extra] of [
      ["run_finished", { runStatus: "timed_out" }],
      ["run_finished", { runStatus: "provider_error" }],
      ["run_finished", {}],
      ["run_cancelled", { runStatus: "cancelled" }],
    ] as const) {
      const rows = groupConversationTranscript([
        item(origin()),
        item(run(kind, { id: "t1", correlationId: "o1", runAgent: "dipu", sequence: 2, ...extra })),
      ]);
      expect(rowIds(rows), `${kind} ${JSON.stringify(extra)}`).toEqual(["o1", "t1"]);
    }
  });

  it("keeps non-system origins and non-system run envelopes visible (fail safe)", () => {
    const nonSystemOrigin = event({
      id: "o-agent",
      kind: "conversation_start_requested",
      authorKind: "agent",
      author: "dipu",
      body: "not the system-origin shape",
      sequence: 1,
    });
    const rows = groupConversationTranscript([
      item(nonSystemOrigin),
      item(run("run_started", { id: "r1", correlationId: "o-agent", runAgent: "dipu", sequence: 2 })),
      item(run("run_finished", { id: "r2", correlationId: "o-agent", runAgent: "dipu", runStatus: "completed", sequence: 3 })),
      item(origin("o-system", 4)),
      item(event({
        id: "r3",
        kind: "run_started",
        authorKind: "agent",
        author: "dipu",
        correlationId: "o-system",
        runAgent: "dipu",
        sequence: 5,
      })),
      item(event({
        id: "r4",
        kind: "run_finished",
        authorKind: "agent",
        author: "dipu",
        correlationId: "o-system",
        runAgent: "dipu",
        runStatus: "completed",
        sequence: 6,
      })),
    ]);
    expect(rowIds(rows)).toEqual(["o-agent", "r1", "r2", "o-system", "r3", "r4"]);
  });

  it("keeps malformed/unattributed run evidence correlated to the origin visible (fail safe)", () => {
    // A completed terminal WITHOUT durable runAgent attribution is malformed
    // evidence, not a suppressible success envelope.
    const rows = groupConversationTranscript([
      item(origin()),
      item(run("run_started", { id: "r1", correlationId: "o1", sequence: 2 })),
      item(run("run_finished", { id: "r2", correlationId: "o1", runStatus: "completed", sequence: 3 })),
    ]);
    expect(rowIds(rows)).toEqual(["o1", "r1", "r2"]);
    expect(rowFor(rows, "r1").type).toBe("evidence");
    expect(rowFor(rows, "r2").type).toBe("evidence");
  });

  it("keeps run evidence visible when its correlation id matches no durable origin (missing origin)", () => {
    const rows = groupConversationTranscript([
      item(run("run_started", { id: "r1", correlationId: "missing", runAgent: "dipu", sequence: 1 })),
      item(run("run_finished", { id: "r2", correlationId: "missing", runAgent: "dipu", runStatus: "completed", sequence: 2 })),
    ]);
    expect(rowIds(rows)).toEqual(["r1", "r2"]);
  });

  it("keeps uncorrelated run evidence visible even alongside an agent-first origin", () => {
    const rows = groupConversationTranscript([
      ...agentFirstItems(),
      item(run("run_finished", { id: "x1", runAgent: "dipu", runStatus: "completed", sequence: 5 })),
    ]);
    expect(rowIds(rows)).toEqual(["o1", "am1", "x1"]);
    expect(rowFor(rows, "x1").type).toBe("evidence");
  });

  it("never suppresses ordinary steward-message runs, even when an origin exists in the same transcript", () => {
    const rows = groupConversationTranscript([
      ...agentFirstItems(),
      item(event({ id: "sm1", kind: "steward_message", author: "steward", body: "thanks @dipu", sequence: 5 })),
      item(run("run_started", { id: "s1", correlationId: "sm1", runAgent: "dipu", sequence: 6 })),
      item(run("run_finished", { id: "s2", correlationId: "sm1", runAgent: "dipu", runStatus: "completed", sequence: 7 })),
    ]);
    const stewardRow = rowFor(rows, "sm1");
    if (stewardRow.type !== "message") throw new Error("expected message row");
    // The ordinary successful run keeps its exact current cluster behavior.
    expect(stewardRow.statuses.map((s) => s.reaction.label)).toEqual(["dipu received", "dipu completed"]);
    expect(rowIds(rows)).toEqual(["o1", "am1", "sm1"]);
  });

  it("never suppresses C5 handoff runs correlated to a durable handoff message", () => {
    const rows = groupConversationTranscript([
      ...agentFirstItems(),
      item(event({ id: "h1", kind: "agent_message", authorKind: "agent", author: "dipu", addressedAgent: "zai", body: "handoff", sequence: 5 })),
      item(run("run_started", { id: "c1", correlationId: "h1", runAgent: "zai", sequence: 6 })),
      item(run("run_finished", { id: "c2", correlationId: "h1", runAgent: "zai", runStatus: "completed", sequence: 7 })),
    ]);
    const handoffRow = rowFor(rows, "h1");
    if (handoffRow.type !== "message") throw new Error("expected message row");
    expect(handoffRow.statuses.map((s) => s.reaction.label)).toEqual(["zai received", "zai completed"]);
  });

  it("suppresses each origin's envelopes independently (a second origin's failure stays visible)", () => {
    const rows = groupConversationTranscript([
      ...agentFirstItems(),
      item(origin("o2", 5)),
      item(run("run_started", { id: "b1", correlationId: "o2", runAgent: "kimi", sequence: 6 })),
      item(run("run_finished", { id: "b2", correlationId: "o2", runAgent: "kimi", runStatus: "failed", failureKind: "ambiguous", sequence: 7 })),
    ]);
    expect(rowIds(rows)).toEqual(["o1", "am1", "o2", "b2"]);
  });

  it("shares one projection between the historic reread and live append paths", () => {
    const events = agentFirstItems().map((entry) => entry.event);
    const historicRows = groupConversationTranscript(replaceConversationHistoric(events));
    let liveItems: ConversationTimelineItem[] = [];
    for (const entry of agentFirstItems()) {
      liveItems = appendConversationLiveItem(liveItems, entry);
    }
    const liveRows = groupConversationTranscript(liveItems);
    expect(liveRows).toEqual(historicRows);
    expect(rowIds(historicRows)).toEqual(["o1", "am1"]);
  });

  it("both the read-only inspection and active/live surfaces render through the single shared grouping", async () => {
    // Static structural pin: ConversationTimeline renders one item list for
    // inspection (live=false) and active (live=true) surfaces, and that list
    // passes through exactly one groupConversationTranscript call site — so
    // the D3 projection cannot diverge between historic and live display.
    const source = await readFile(join(process.cwd(), "web", "src", "ConversationTimeline.tsx"), "utf8");
    expect(source).toContain("groupConversationTranscript,");
    expect(source.match(/groupConversationTranscript\(/g)?.length).toBe(1); // exactly one call site
    expect(source).toContain("groupConversationTranscript(items)");
    expect(source).toContain("<ConversationTimelineItems items={phase.items} />");
    expect(source).toContain('stream: "inspection"');
  });
});

/**
 * D5 — concise presentation for the EXACT system-authored durable
 * `conversation_start_requested` origin only: `Conversation started with
 * agent <agent>`, with the redundant explanatory body covered by the label.
 * The durable event, its body, ordering, correlation, and the D3
 * suppression predicate are unchanged; non-system lookalikes,
 * malformed-body origins, and every other event keep their current
 * rendering (fail safe, visible).
 */
describe("D5 conversation-start origin presentation", () => {
  it("labels only the exact system-authored origin with concise agent-start language", () => {
    const presentation = conversationStartOriginPresentation(origin());
    expect(presentation).toEqual({ label: "Conversation started with agent dipu" });
  });

  it("extracts the exact durable agent name from the system origin body", () => {
    const presentation = conversationStartOriginPresentation(
      event({
        kind: "conversation_start_requested",
        authorKind: "system",
        author: "system",
        body: "The steward requested starting this conversation with agent 'kimi'.",
      }),
    );
    expect(presentation).toEqual({ label: "Conversation started with agent kimi" });
  });

  it("returns null for a non-system lookalike origin with an identical body (fail safe)", () => {
    for (const [authorKind, author] of [
      ["agent", "dipu"],
      ["steward", "steward"],
      ["system", "not-system"],
      ["agent", "system"],
    ] as const) {
      const lookalike = event({
        kind: "conversation_start_requested",
        authorKind,
        author,
        body: "The steward requested starting this conversation with agent 'dipu'.",
      });
      expect(conversationStartOriginPresentation(lookalike), `${authorKind}/${author}`).toBeNull();
    }
  });

  it("returns null for a system-authored origin whose body is not the exact durable shape (malformed)", () => {
    for (const body of [
      "The steward requested starting this conversation with agent dipu.",
      "The steward requested starting this conversation with agent 'dipu'",
      "The steward requested starting this conversation with agent 'dipu'. extra",
      "something else entirely",
    ]) {
      const malformed = event({
        kind: "conversation_start_requested",
        authorKind: "system",
        author: "system",
        body,
      });
      expect(conversationStartOriginPresentation(malformed), JSON.stringify(body)).toBeNull();
    }
  });

  it("returns null for every other event kind, even system-authored ones", () => {
    expect(
      conversationStartOriginPresentation(
        run("run_started", { correlationId: "o1", runAgent: "dipu" }),
      ),
    ).toBeNull();
    expect(
      conversationStartOriginPresentation(
        event({ kind: "agent_message", authorKind: "agent", author: "dipu", body: "hi" }),
      ),
    ).toBeNull();
  });

  it("leaves the durable origin row, D3 suppression, and fail-safe evidence cases untouched", () => {
    const rows = groupConversationTranscript(agentFirstItems());
    // The origin remains a visible evidence row carrying the unchanged
    // durable event (kind, body, id, ordering all intact).
    expect(rowIds(rows)).toEqual(["o1", "am1"]);
    const originRow = rowFor(rows, "o1");
    expect(originRow.type).toBe("evidence");
    if (originRow.type === "evidence") {
      expect(originRow.event.kind).toBe("conversation_start_requested");
      expect(originRow.event.body).toBe("The steward requested starting this conversation with agent 'dipu'.");
    }
  });

  it("renders through one shared presentation call site in the evidence row (static pin)", async () => {
    const source = await readFile(join(process.cwd(), "web", "src", "ConversationTimeline.tsx"), "utf8");
    // Exactly one presentation call site, inside the single evidence-row
    // renderer, so inspection and live surfaces can never diverge; the body
    // is suppressed only when the exact origin presentation applies.
    expect(source.match(/conversationStartOriginPresentation\(/g)?.length).toBe(1);
    expect(source).toContain("startOrigin !== null ? startOrigin.label : conversationEventLabel(row.event)");
    expect(source).toContain('row.event.body !== "" && startOrigin === null');
  });
});
