import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConversation,
  appendConversationEvent,
  readConversation,
  listConversations,
  readConversationEvents,
  updateConversationAudience,
  conversationIdFromText,
  conversationTitleFromText,
  type ConversationEventRecord,
} from "../src/conversations.js";
import { resolveStewardMentions } from "../src/conversation-contract.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-conversations-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const NOW = new Date("2026-08-05T13:15:30.000Z");

describe("conversationIdFromText / conversationTitleFromText (deterministic, no LLM)", () => {
  it("derives a compact-UTC id with a bounded 48-char slug from the first message", () => {
    const id = conversationIdFromText("Please review the C2 contract @zai", NOW);
    expect(id).toBe("20260805T131530000Z-please-review-the-c2-contract-zai");
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it("normalizes and bounds the slug to 48 chars, falling back to conversation", () => {
    const long = "word ".repeat(40);
    const id = conversationIdFromText(long, NOW);
    const slug = id.slice(id.indexOf("-") + 1);
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(conversationIdFromText("", NOW)).toBe("20260805T131530000Z-conversation");
    expect(conversationIdFromText("   ", NOW)).toBe("20260805T131530000Z-conversation");
  });

  it("builds a deterministic title with a bounded plain-text prefix", () => {
    expect(conversationTitleFromText("Hello world", NOW)).toBe("Conversation 2026-08-05 13:15 - Hello world");
    expect(conversationTitleFromText("", NOW)).toBe("Conversation 2026-08-05 13:15");
    const long = "A".repeat(60);
    expect(conversationTitleFromText(long, NOW)).toContain("A".repeat(48));
  });
});

describe("createConversation", () => {
  it("creates a Conversation Manifest with the additive audience", async () => {
    const conversation = await createConversation({
      vaultRoot: root,
      text: "Hello @zai",
      audience: ["zai"],
      now: () => NOW,
    });

    expect(conversation.id).toBe("20260805T131530000Z-hello-zai");
    expect(conversation.status).toBe("open");
    expect(conversation.createdBy).toBe("steward");
    expect(conversation.audience).toEqual(["zai"]);
    expect(conversation.title).toBe("Conversation 2026-08-05 13:15 - Hello @zai");

    const raw = await readFile(join(root, "collaboration", "conversations", conversation.id, "index.md"), "utf8");
    expect(raw).toContain("type: Conversation Manifest");
    expect(raw).toContain("audience:");
    expect(raw).toContain("- zai");
  });

  it("rejects a missing id collision atomically (no-clobber)", async () => {
    const options = { vaultRoot: root, text: "Same text", audience: [], now: () => NOW };
    await createConversation(options);
    await expect(createConversation(options)).rejects.toThrow(/Conversation already exists/i);
  });

  it("never writes under collaboration/rooms", async () => {
    await createConversation({ vaultRoot: root, text: "Hello", audience: [], now: () => NOW });
    await expect(stat(join(root, "collaboration", "rooms"))).rejects.toThrow();
    const conversationsDir = await readdir(join(root, "collaboration", "conversations"));
    expect(conversationsDir).toEqual(["20260805T131530000Z-hello"]);
  });
});

describe("appendConversationEvent + readConversationEvents", () => {
  it("appends a steward_message exactly once and reads it chronologically", async () => {
    const conversation = await createConversation({ vaultRoot: root, text: "First", audience: [], now: () => NOW });
    const event = await appendConversationEvent({
      vaultRoot: root,
      conversationId: conversation.id,
      kind: "steward_message",
      authorKind: "steward",
      author: "steward",
      body: "First",
      now: () => NOW,
    });

    const events = await readConversationEvents({ vaultRoot: root, conversationId: conversation.id });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("steward_message");
    expect(events[0]?.body).toBe("First");
    expect(events[0]?.id).toBe(event.id);
  });

  it("appends typed run events with bounded outcomes (run_finished failed carries failure_kind)", async () => {
    const conversation = await createConversation({ vaultRoot: root, text: "Go", audience: [], now: () => NOW });
    const cid = conversation.id;
    let seq = 0;
    const nonce = () => `n${++seq}`;
    // The gateway appends the first steward_message before broker dispatch.
    await appendConversationEvent({
      vaultRoot: root, conversationId: cid, kind: "steward_message", authorKind: "steward", author: "steward",
      body: "Go", now: () => NOW, nonce,
    });
    const started = await appendConversationEvent({
      vaultRoot: root, conversationId: cid, kind: "run_started", authorKind: "system", author: "system",
      body: "Run started.", runStatus: "running", correlationId: "s1", now: () => NOW, nonce,
    });
    expect(started.kind).toBe("run_started");
    const finished = await appendConversationEvent({
      vaultRoot: root, conversationId: cid, kind: "run_finished", authorKind: "system", author: "system",
      body: "Run failed.", runStatus: "failed", failureKind: "launch_failure", correlationId: "s1", now: () => NOW, nonce,
    });
    expect(finished.kind).toBe("run_finished");

    const events = await readConversationEvents({ vaultRoot: root, conversationId: cid });
    expect(events.map((e) => e.kind)).toEqual(["steward_message", "run_started", "run_finished"]);
  });

  it("rejects an invalid run outcome fail-closed (failed without failure_kind)", async () => {
    const conversation = await createConversation({ vaultRoot: root, text: "Go", audience: [], now: () => NOW });
    await expect(
      appendConversationEvent({
        vaultRoot: root, conversationId: conversation.id, kind: "run_finished", authorKind: "system", author: "system",
        body: "x", runStatus: "failed", now: () => NOW,
      }),
    ).rejects.toThrow(/failure_?kind/i);
  });

  it("appends events with a deterministic no-clobber id per event", async () => {
    const conversation = await createConversation({ vaultRoot: root, text: "Go", audience: [], now: () => NOW });
    let nonceSeq = 0;
    await appendConversationEvent({
      vaultRoot: root, conversationId: conversation.id, kind: "steward_message", authorKind: "steward", author: "steward",
      body: "a", now: () => NOW, nonce: () => `n${++nonceSeq}`,
    });
    await appendConversationEvent({
      vaultRoot: root, conversationId: conversation.id, kind: "steward_message", authorKind: "steward", author: "steward",
      body: "b", now: () => NOW, nonce: () => `n${++nonceSeq}`,
    });
    const events = await readConversationEvents({ vaultRoot: root, conversationId: conversation.id });
    expect(events.map((e) => e.id)).toEqual(["20260805T131530000Z-n1", "20260805T131530000Z-n2"]);
  });
});

describe("readConversation / listConversations", () => {
  it("reads a conversation manifest with the additive audience", async () => {
    await createConversation({ vaultRoot: root, text: "Hello @zai @dipu", audience: ["zai", "dipu"], now: () => NOW });
    const conversations = await listConversations({ vaultRoot: root });
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.audience).toEqual(["zai", "dipu"]);
    const read = await readConversation({ vaultRoot: root, conversationId: conversations[0]!.id });
    expect(read.title).toBe("Conversation 2026-08-05 13:15 - Hello @zai @dipu");
  });

  it("lists newest-first with a deterministic tiebreak", async () => {
    const base = new Date("2026-08-05T10:00:00.000Z");
    await createConversation({ vaultRoot: root, text: "Older", audience: [], now: () => new Date(base.getTime() + 60000) });
    await createConversation({ vaultRoot: root, text: "Newer", audience: [], now: () => base });
    const conversations = await listConversations({ vaultRoot: root });
    expect(conversations.map((c) => c.title)).toEqual([
      "Conversation 2026-08-05 10:01 - Older",
      "Conversation 2026-08-05 10:00 - Newer",
    ]);
  });

  it("lists empty when the namespace is missing and rejects malformed manifests naming their path", async () => {
    await expect(listConversations({ vaultRoot: root })).resolves.toEqual([]);
    await createConversation({ vaultRoot: root, text: "Hi", audience: [], now: () => NOW });
    const id = "20260805T131530000Z-hi";
    await writeFile(join(root, "collaboration", "conversations", id, "index.md"), "---\nnot: a manifest\n---\n", "utf8");
    await expect(readConversation({ vaultRoot: root, conversationId: id })).rejects.toThrow(/Conversation Manifest/);
  });
});

describe("updateConversationAudience (additive later-mention membership, C2 rework)", () => {
  it("grows the audience additively in C1 first-mention order and bumps updated", async () => {
    const conversation = await createConversation({ vaultRoot: root, text: "Hello @zai", audience: ["zai"], now: () => NOW });
    const later = new Date("2026-08-05T14:00:01.000Z");
    const validated = resolveStewardMentions("please @dipu @sam", ["dipu", "sam", "zai"]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error("test setup");

    const updated = await updateConversationAudience({
      vaultRoot: root,
      conversationId: conversation.id,
      additions: validated.validated,
      now: () => later,
    });

    expect(updated.audience).toEqual(["zai", "dipu", "sam"]);
    expect(updated.updated).toBe("2026-08-05T14:00:01.000Z");
    const reread = await readConversation({ vaultRoot: root, conversationId: conversation.id });
    expect(reread.audience).toEqual(["zai", "dipu", "sam"]);
    expect(reread.updated).toBe("2026-08-05T14:00:01.000Z");
  });

  it("never removes or reorders existing members and no-ops on duplicates", async () => {
    const conversation = await createConversation({ vaultRoot: root, text: "Hi @dipu", audience: ["dipu"], now: () => NOW });
    const validated = resolveStewardMentions("@zai @dipu @zai", ["dipu", "zai"]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error("test setup");
    const updated = await updateConversationAudience({
      vaultRoot: root,
      conversationId: conversation.id,
      additions: validated.validated,
      now: () => new Date("2026-08-05T14:00:02.000Z"),
    });
    expect(updated.audience).toEqual(["dipu", "zai"]);
  });

  it("serializes concurrent audience updates via the vault-visible lock: a contended update fails closed and the union is never lost", async () => {
    const conversation = await createConversation({ vaultRoot: root, text: "Hello @zai", audience: ["zai"], now: () => NOW });
    const dipu = resolveStewardMentions("@dipu", ["dipu", "zai"]);
    const sam = resolveStewardMentions("@sam", ["dipu", "sam", "zai"]);
    expect(dipu.ok && sam.ok).toBe(true);
    if (!dipu.ok || !sam.ok) throw new Error("test setup");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockPath = join(root, "collaboration", "conversations", conversation.id, ".audience.lock");
    const first = updateConversationAudience({
      vaultRoot: root, conversationId: conversation.id, additions: dipu.validated,
      now: () => new Date("2026-08-05T14:01:00.000Z"), holdBarrier: gate,
    });
    // Deterministic barrier: wait for the first update to hold the visible lock.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        await stat(lockPath);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    await expect(stat(lockPath)).resolves.toBeDefined();

    // The contended update fails closed (no silent last-writer-wins loss).
    const contended = updateConversationAudience({
      vaultRoot: root, conversationId: conversation.id, additions: sam.validated,
      now: () => new Date("2026-08-05T14:02:00.000Z"),
    });
    await expect(contended).rejects.toThrow(/busy/i);

    release();
    const result = await first;
    expect(result.audience).toEqual(["zai", "dipu"]);
    const final = await readConversation({ vaultRoot: root, conversationId: conversation.id });
    expect(final.audience).toEqual(["zai", "dipu"]);
    expect(final.created).toBe("2026-08-05T13:15:30.000Z");
    // The winner released the lock on completion.
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it("releases the lock on an expected failure so a later update succeeds", async () => {
    const conversation = await createConversation({ vaultRoot: root, text: "Hello @zai", audience: ["zai"], now: () => NOW });
    const dipu = resolveStewardMentions("@dipu", ["dipu", "zai"]);
    expect(dipu.ok).toBe(true);
    if (!dipu.ok) throw new Error("test setup");
    // Deterministic deferred-reject barrier: reject after the lock is held so
    // the update fails inside the locked section (no leaked unhandled rejection).
    let failBarrier!: (error: unknown) => void;
    const gate = new Promise<void>((_resolve, reject) => {
      failBarrier = reject;
    });
    const lockPath = join(root, "collaboration", "conversations", conversation.id, ".audience.lock");
    const update = updateConversationAudience({
      vaultRoot: root, conversationId: conversation.id, additions: dipu.validated,
      now: () => new Date("2026-08-05T14:04:00.000Z"), holdBarrier: gate,
    });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try { await stat(lockPath); break; } catch { await new Promise((r) => setTimeout(r, 5)); }
    }
    await expect(stat(lockPath)).resolves.toBeDefined();
    failBarrier(new Error("boom"));
    await expect(update).rejects.toThrow(/boom/);
    // The lock was released in the finally: a subsequent update succeeds.
    const second = await updateConversationAudience({
      vaultRoot: root, conversationId: conversation.id, additions: dipu.validated,
      now: () => new Date("2026-08-05T14:03:00.000Z"),
    });
    expect(second.audience).toEqual(["zai", "dipu"]);
    await expect(stat(join(root, "collaboration", "conversations", conversation.id, ".audience.lock"))).rejects.toThrow();
  });

  it("preserves the original created timestamp across multiple audience updates (immutable created)", async () => {
    const conversation = await createConversation({ vaultRoot: root, text: "Hello @zai", audience: ["zai"], now: () => NOW });
    const dipu = resolveStewardMentions("@dipu", ["dipu", "zai"]);
    const sam = resolveStewardMentions("@sam", ["dipu", "sam", "zai"]);
    expect(dipu.ok && sam.ok).toBe(true);
    if (!dipu.ok || !sam.ok) throw new Error("test setup");

    await updateConversationAudience({
      vaultRoot: root,
      conversationId: conversation.id,
      additions: dipu.validated,
      now: () => new Date("2026-08-05T14:00:01.000Z"),
    });
    await updateConversationAudience({
      vaultRoot: root,
      conversationId: conversation.id,
      additions: sam.validated,
      now: () => new Date("2026-08-05T14:00:02.000Z"),
    });

    const final = await readConversation({ vaultRoot: root, conversationId: conversation.id });
    // created is byte-for-byte the original activation timestamp.
    expect(final.created).toBe("2026-08-05T13:15:30.000Z");
    expect(final.updated).toBe("2026-08-05T14:00:02.000Z");
    expect(final.audience).toEqual(["zai", "dipu", "sam"]);
    expect(final.id).toBe(conversation.id);
    expect(final.status).toBe("open");
  });
});

describe("event sequence allocation (atomic, race-safe durable order)", () => {
  it("allocates unique contiguous sequences atomically under concurrent same-ms appends", async () => {
    const conversation = await createConversation({ vaultRoot: root, text: "Go", audience: [], now: () => NOW });
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        appendConversationEvent({
          vaultRoot: root,
          conversationId: conversation.id,
          kind: "steward_message",
          authorKind: "steward",
          author: "steward",
          body: `msg-${i}`,
          now: () => NOW,
          nonce: () => `n${i}`,
        }),
      ),
    );
    const events = await readConversationEvents({ vaultRoot: root, conversationId: conversation.id });
    expect(events).toHaveLength(5);
    // Strictly increasing, contiguous, unique sequences in durable read order.
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(events.map((e) => e.sequence)).size).toBe(5);
  });

  it("uses sequence (not created) as the authoritative durable order under clock skew", async () => {
    const conversation = await createConversation({ vaultRoot: root, text: "Go", audience: [], now: () => NOW });
    const later = new Date("2026-08-05T14:00:05.000Z");
    const earlier = new Date("2026-08-05T13:00:00.000Z");
    const first = await appendConversationEvent({
      vaultRoot: root, conversationId: conversation.id, kind: "steward_message", authorKind: "steward", author: "steward",
      body: "first", now: () => later, nonce: () => "a",
    });
    const second = await appendConversationEvent({
      vaultRoot: root, conversationId: conversation.id, kind: "steward_message", authorKind: "steward", author: "steward",
      body: "second", now: () => earlier, nonce: () => "b",
    });
    expect(first.sequence).toBeLessThan(second.sequence);
    const events = await readConversationEvents({ vaultRoot: root, conversationId: conversation.id });
    // Sequence is primary: the first-appended event comes first even though
    // its wall clock is later than the second event's.
    expect(events.map((e) => e.body)).toEqual(["first", "second"]);
  });
});

describe("ConversationEventRecord shape", () => {
  it("carries the C2 metadata fields on the parsed event record", async () => {
    const conversation = await createConversation({ vaultRoot: root, text: "Go", audience: [], now: () => NOW });
    await appendConversationEvent({
      vaultRoot: root, conversationId: conversation.id, kind: "steward_message", authorKind: "steward", author: "steward",
      body: "Go", mentions: ["zai"], now: () => NOW,
    });
    const events: ConversationEventRecord[] = await readConversationEvents({ vaultRoot: root, conversationId: conversation.id });
    expect(events[0]?.mentions).toEqual(["zai"]);
  });

  it("preserves append order for events sharing the same millisecond (run_started, agent_message, run_finished)", async () => {
    // A fast (fake-Pi) run appends run_started -> agent_message -> run_finished
    // back-to-back, all in the same millisecond. The durable read must return
    // them in append order, not a random-nonce id tiebreak.
    const conversation = await createConversation({ vaultRoot: root, text: "Run", audience: ["zai"], now: () => NOW });
    const sameMs = () => NOW;
    await appendConversationEvent({ vaultRoot: root, conversationId: conversation.id, kind: "run_started", authorKind: "system", author: "system", body: "started", runStatus: "running", now: sameMs, nonce: () => "aaa" });
    await appendConversationEvent({ vaultRoot: root, conversationId: conversation.id, kind: "agent_message", authorKind: "agent", author: "zai", body: "visible reply", now: sameMs, nonce: () => "zzz" });
    await appendConversationEvent({ vaultRoot: root, conversationId: conversation.id, kind: "run_finished", authorKind: "system", author: "system", body: "finished", runStatus: "completed", now: sameMs, nonce: () => "mmm" });
    const events = await readConversationEvents({ vaultRoot: root, conversationId: conversation.id });
    expect(events.map((e) => e.kind)).toEqual(["run_started", "agent_message", "run_finished"]);
  });
});
