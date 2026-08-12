import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  conversationAuthorInitial,
  conversationStatusSymbol,
  groupConversationTranscript,
  type ConversationStatusAttachment,
  type ConversationTranscriptRow,
} from "../web/src/conversation-transcript.js";
import { parseConversationEventRecord, type ConversationEventRecord } from "../web/src/conversations.js";

/**
 * P3 — message-first Conversation transcript and fixed correlated status
 * clusters (accepted `conversation-message-first-transcript-contract.md`,
 * 2026-08-12): durable steward/agent messages are compact chat rows; eligible
 * U5 run statuses attach ONLY by durable `correlationId` to a displayed
 * requester message row; uncorrelated/unknown/unattributed/malformed evidence
 * fails safe to compact visible rows. No dedupe/overwrite, no text/activity/
 * adjacency/roster inference, no read/seen/delivery claim, no Markdown.
 */

const CID = "20260812T000000000Z-p3";

function event(overrides: Partial<ConversationEventRecord>): ConversationEventRecord {
  return parseConversationEventRecord({
    id: "e1",
    conversationId: CID,
    kind: "steward_message",
    authorKind: "steward",
    author: "steward",
    created: "2026-08-12T00:00:00.000Z",
    sequence: 1,
    mentions: [],
    body: "x",
    path: "collaboration/conversations/c1/events/00000001.md",
    ...overrides,
  });
}

function run(kind: ConversationEventRecord["kind"], overrides: Partial<ConversationEventRecord>): ConversationEventRecord {
  return event({
    kind,
    authorKind: "system",
    author: "system",
    ...overrides,
  });
}

function item(eventRecord: ConversationEventRecord) {
  return { type: "event" as const, id: eventRecord.id, event: eventRecord };
}

function statuses(row: ConversationTranscriptRow): ConversationStatusAttachment[] {
  if (row.type !== "message") throw new Error("expected a message row");
  return row.statuses;
}

describe("groupConversationTranscript (pure durable grouping)", () => {
  it("attaches a normal correlated run to its steward requester row and keeps the agent reply separate", () => {
    const sm1 = event({ id: "sm1", kind: "steward_message", author: "steward", body: "please @dipu", sequence: 1 });
    const r1 = run("run_started", { id: "r1", correlationId: "sm1", runAgent: "dipu", runStatus: "running", sequence: 2 });
    const am1 = event({ id: "am1", kind: "agent_message", author: "dipu", body: "done", sequence: 3 });
    const r2 = run("run_finished", { id: "r2", correlationId: "sm1", runAgent: "dipu", runStatus: "completed", sequence: 4 });

    const rows = groupConversationTranscript([item(sm1), item(r1), item(am1), item(r2)]);
    expect(rows.map((row) => (row.type === "message" ? row.event.id : row.type))).toEqual(["sm1", "am1"]);
    expect(statuses(rows[0] as ConversationTranscriptRow).map((s) => s.reaction.label)).toEqual(["dipu received", "dipu completed"]);
    expect(statuses(rows[1] as ConversationTranscriptRow)).toEqual([]);
  });

  it("handles multiple agents and preserves server evidence order in the cluster", () => {
    const sm1 = event({ id: "sm1", kind: "steward_message", author: "steward", body: "go @dipu @zai", sequence: 1 });
    const r1 = run("run_started", { id: "r1", correlationId: "sm1", runAgent: "dipu", sequence: 2 });
    const r2 = run("run_started", { id: "r2", correlationId: "sm1", runAgent: "zai", sequence: 3 });
    const am1 = event({ id: "am1", kind: "agent_message", author: "dipu", body: "hi", sequence: 4 });
    const r3 = run("run_finished", { id: "r3", correlationId: "sm1", runAgent: "dipu", runStatus: "completed", sequence: 5 });
    const r4 = run("run_finished", { id: "r4", correlationId: "sm1", runAgent: "zai", runStatus: "completed", sequence: 6 });

    const rows = groupConversationTranscript([item(sm1), item(r1), item(r2), item(am1), item(r3), item(r4)]);
    const cluster = statuses(rows[0] as ConversationTranscriptRow).map((s) => s.reaction.label);
    expect(cluster).toEqual(["dipu received", "zai received", "dipu completed", "zai completed"]);
  });

  it("never dedupes or overwrites distinct durable events, even when status/agent match", () => {
    const sm1 = event({ id: "sm1", kind: "steward_message", author: "steward", body: "x", sequence: 1 });
    const f1 = run("run_finished", { id: "f1", correlationId: "sm1", runAgent: "dipu", runStatus: "completed", sequence: 2 });
    const f2 = run("run_finished", { id: "f2", correlationId: "sm1", runAgent: "dipu", runStatus: "completed", sequence: 3 });
    const c1 = run("run_cancelled", { id: "c1", correlationId: "sm1", runAgent: "zai", runStatus: "cancelled", sequence: 4 });

    const rows = groupConversationTranscript([item(sm1), item(f1), item(f2), item(c1)]);
    const cluster = statuses(rows[0] as ConversationTranscriptRow);
    expect(cluster.map((s) => s.reaction.label)).toEqual(["dipu completed", "dipu completed", "zai cancelled"]);
    expect(cluster.map((s) => s.eventId)).toEqual(["f1", "f2", "c1"]);
  });

  it("attaches a C5 child run to its durable handoff requester row (staged/handoff correlation preserved)", () => {
    const sm1 = event({ id: "sm1", kind: "steward_message", author: "steward", body: "start", sequence: 1 });
    const r1 = run("run_started", { id: "r1", correlationId: "sm1", runAgent: "dipu", sequence: 2 });
    const h1 = event({ id: "h1", kind: "agent_message", author: "dipu", addressedAgent: "zai", body: "handoff text", sequence: 3 });
    const r2 = run("run_started", { id: "r2", correlationId: "h1", runAgent: "zai", sequence: 4 });
    const r3 = run("run_finished", { id: "r3", correlationId: "h1", runAgent: "zai", runStatus: "completed", sequence: 5 });
    const r4 = run("run_finished", { id: "r4", correlationId: "sm1", runAgent: "dipu", runStatus: "completed", sequence: 6 });

    const rows = groupConversationTranscript([item(sm1), item(r1), item(h1), item(r2), item(r3), item(r4)]);
    expect(rows.map((row) => row.type)).toEqual(["message", "message"]);
    expect(statuses(rows[0] as ConversationTranscriptRow).map((s) => s.reaction.label)).toEqual(["dipu received", "dipu completed"]);
    // The handoff requester row carries the child run's own durable statuses.
    expect(statuses(rows[1] as ConversationTranscriptRow).map((s) => s.reaction.label)).toEqual(["zai received", "zai completed"]);
  });

  it("fails safe to a visible evidence row for uncorrelated run evidence (with the U5 chip when mapping exists)", () => {
    const u1 = run("run_started", { id: "u1", runAgent: "dipu", runStatus: "running", sequence: 1 });
    const f1 = run("run_finished", { id: "f1", correlationId: "ghost-id", runAgent: "dipu", runStatus: "completed", sequence: 2 });

    const rows = groupConversationTranscript([item(u1), item(f1)]);
    expect(rows.map((row) => row.type)).toEqual(["evidence", "evidence"]);
    expect((rows[0] as Extract<ConversationTranscriptRow, { type: "evidence" }>).reaction?.label).toBe("dipu received");
    expect((rows[1] as Extract<ConversationTranscriptRow, { type: "evidence" }>).reaction?.label).toBe("dipu completed");
  });

  it("fails safe for missing runAgent, unknown/malformed terminal, and non-run system evidence", () => {
    const sm1 = event({ id: "sm1", kind: "steward_message", author: "steward", body: "x", sequence: 1 });
    // Correlated id + no runAgent: never attributed.
    const noAgent = run("run_finished", { id: "f1", correlationId: "sm1", runStatus: "completed", sequence: 2 });
    // Correlated id + runAgent + unknown terminal status: no U5 mapping.
    const bogus = run("run_finished", { id: "f2", correlationId: "sm1", runAgent: "dipu", runStatus: "bogus", sequence: 3 });
    // Model fallback and lifecycle evidence are never statuses.
    const fallback = event({ id: "m1", kind: "model_fallback", authorKind: "system", author: "system", body: "fallback note", sequence: 4 });
    const lifecycle = event({ id: "l1", kind: "lifecycle_transition", authorKind: "system", author: "system", body: "archived", lifecycleState: "archived", sequence: 5 });

    const rows = groupConversationTranscript([item(sm1), item(noAgent), item(bogus), item(fallback), item(lifecycle)]);
    expect(rows.map((row) => row.type)).toEqual(["message", "evidence", "evidence", "evidence", "evidence"]);
    // sm1 keeps no fabricated statuses.
    expect(statuses(rows[0] as ConversationTranscriptRow)).toEqual([]);
    for (const evidence of rows.slice(1) as Extract<ConversationTranscriptRow, { type: "evidence" }>[]) {
      expect(evidence.reaction).toBeNull();
    }
  });

  it("keeps the literal durable body and error diagnostics as distinct rows in order", () => {
    const sm1 = event({ id: "sm1", kind: "steward_message", author: "steward", body: "literal *text* with <b>html</b>", sequence: 1 });
    const err = { type: "error" as const, id: "error-x", message: "unreadable conversation_event frame (non-authoritative)" };

    const rows = groupConversationTranscript([item(sm1), err]);
    expect(rows).toHaveLength(2);
    expect((rows[0] as Extract<ConversationTranscriptRow, { type: "message" }>).event.body).toBe("literal *text* with <b>html</b>");
    expect(rows[1]).toEqual(err);
  });
});

describe("conversationAuthorInitial (deterministic decorative initial)", () => {
  it("uppercases the first Unicode code point of the durable author string", () => {
    expect(conversationAuthorInitial("dipu")).toBe("D");
    expect(conversationAuthorInitial("piren-agent")).toBe("P");
    expect(conversationAuthorInitial("øla")).toBe("Ø");
    expect(conversationAuthorInitial("")).toBe("");
  });
});

describe("conversationStatusSymbol (fixed P3 symbols)", () => {
  it("maps the four U5 kinds to their exact fixed symbols", () => {
    expect(conversationStatusSymbol("received")).toBe("⏳");
    expect(conversationStatusSymbol("completed")).toBe("✅");
    expect(conversationStatusSymbol("failed")).toBe("⚠️");
    expect(conversationStatusSymbol("cancelled")).toBe("⏹");
  });
});

describe("P3 static boundary", () => {
  const webSrc = join(process.cwd(), "web", "src");

  it("the transcript core is pure: no storage, SSE, fetch, Markdown/HTML, or writes", async () => {
    const core = await readFile(join(webSrc, "conversation-transcript.ts"), "utf8");
    for (const forbidden of ["fetch(", "localStorage", "sessionStorage", "new EventSource", "dangerouslySetInnerHTML", "markdown", "onClick", "read receipt", "seen by", "delivered to", "has read", "/api/"]) {
      expect(core, `conversation-transcript.ts must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("the timeline renders message rows with You/initial/author/time and fixed clusters, not the old cards/chips", async () => {
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    expect(timeline).toContain("groupConversationTranscript");
    expect(timeline).toContain("conversationAuthorInitial");
    expect(timeline).toContain("isConversationHandoffEvent");
    expect(timeline).toContain('"You"');
    expect(timeline).toContain("transcript-list");
    expect(timeline).toContain("status-cluster");
    // ADR-0043: the superseded bordered card/chip presentation branches are gone.
    expect(timeline).not.toContain("timeline-entry");
    expect(timeline).not.toContain("conversation-reaction-");
  });

  it("clusters expose the exact U5 label via aria-label/title and are non-interactive", async () => {
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    expect(timeline).toContain("aria-label={reaction.label}");
    expect(timeline).toContain("title={reaction.label}");
    expect(timeline).toContain("aria-hidden=\"true\"");
    // No button/picker/selection on the fixed cluster items.
    expect(timeline).not.toMatch(/<button[^>]*status-cluster|status-cluster[^>]*<button/);
  });

  it("read-only inspection and live history share the same durable grouping path", async () => {
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    // The pure grouping is applied to the accumulated durable items in both
    // phases; read-only still opens no stream and manufactures no activity.
    expect(timeline).toContain("no live stream");
    expect(timeline).toContain("groupConversationTranscript(items)");
  });
});
