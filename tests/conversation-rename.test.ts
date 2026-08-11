import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConversation,
  normalizeConversationTitle,
  readConversation,
  readConversationEvents,
  renameConversation,
  transitionConversationLifecycle,
  type ConversationManifest,
  type ConversationWriteIo,
} from "../src/conversations.js";

/**
 * U2 — pure durable Conversation rename core (accepted
 * `conversation-details-rename-contract.md`): trim-normalized single-line
 * 1–120 Unicode-code-unit title validation, atomic title-and-updated-only
 * manifest rewrite preserving id/audience/status/created_by/created, exactly
 * one immutable `conversation_renamed` event (previousTitle/title evidence)
 * per actual rename, idempotent `renamed:false` no-ops, manifest-first
 * event-append residual, shared-lock serialization, and no broker/Pi/HTTP/
 * membership side effects.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-rename-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const NOW = new Date("2026-08-05T13:15:30.000Z");
const LATER = new Date("2026-08-05T14:00:00.000Z");
const LATER2 = new Date("2026-08-05T15:00:00.000Z");

async function openConversation(text = "Rename seed @zai", audience: string[] = ["zai"]): Promise<ConversationManifest> {
  return createConversation({ vaultRoot: root, text, audience, now: () => NOW });
}

function manifestPath(conversationId: string): string {
  return join(root, "collaboration", "conversations", conversationId, "index.md");
}

function lockPath(conversationId: string): string {
  return join(root, "collaboration", "conversations", conversationId, ".audience.lock");
}

async function waitForLock(conversationId: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      await stat(lockPath(conversationId));
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error("lock did not appear");
}

describe("conversation title validation and trim normalization (U2)", () => {
  it("accepts a bounded single-line title and stores the trimmed value", () => {
    expect(normalizeConversationTitle("  My new title  ")).toEqual({ ok: true, title: "My new title" });
    expect(normalizeConversationTitle("x".repeat(120))).toEqual({ ok: true, title: "x".repeat(120) });
    // Quotes and backslashes are legal title characters; the manifest renderer
    // round-trips them (the validator is contract-exact: empty/control/overlong
    // only — quotes must NOT be rejected).
    expect(normalizeConversationTitle('He said "hi" \\ back')).toEqual({ ok: true, title: 'He said "hi" \\ back' });
  });

  it("rejects empty, control/newline, and overlength titles with exact reasons", () => {
    expect(normalizeConversationTitle("   ")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeConversationTitle("line one\nline two")).toEqual({ ok: false, reason: "control-or-newline" });
    expect(normalizeConversationTitle("tab\there")).toEqual({ ok: false, reason: "control-or-newline" });
    expect(normalizeConversationTitle("bell\u0007")).toEqual({ ok: false, reason: "control-or-newline" });
    expect(normalizeConversationTitle("x".repeat(121))).toEqual({ ok: false, reason: "too-long" });
    // Boundary: exactly 120 UTF-16 code units is valid; 121 is not.
    expect(normalizeConversationTitle("a".repeat(120))?.ok).toBe(true);
  });

  it("rejects a rename whose normalized title is empty/control/overlong without any write or event", async () => {
    const conversation = await openConversation();
    const before = await readFile(manifestPath(conversation.id), "utf8");
    for (const bad of ["   ", "a\nb", "x".repeat(121)]) {
      const result = await renameConversation({ vaultRoot: root, conversationId: conversation.id, title: bad, now: () => LATER });
      if (result.ok) throw new Error("expected invalid-title");
      expect(result.kind).toBe("invalid-title");
      if (result.kind === "invalid-title") {
        expect(result.message).not.toMatch(/\n|: |\\/);
      }
    }
    expect(await readFile(manifestPath(conversation.id), "utf8")).toBe(before);
    expect(await readConversationEvents({ vaultRoot: root, conversationId: conversation.id })).toEqual([]);
  });
});

describe("renameConversation success (U2)", () => {
  it("renames: title and updated change; id/audience/status/created/created_by preserved byte-for-byte", async () => {
    const conversation = await openConversation("Rename seed @zai");
    const result = await renameConversation({ vaultRoot: root, conversationId: conversation.id, title: "  Ship notes  ", now: () => LATER });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.renamed).toBe(true);
    expect(result.conversation.title).toBe("Ship notes");
    expect(result.conversation.updated).toBe(LATER.toISOString());
    expect(result.conversation.created).toBe(NOW.toISOString());
    expect(result.conversation.audience).toEqual(["zai"]);
    expect(result.conversation.status).toBe("open");
    expect(result.conversation.createdBy).toBe("steward");
    expect(result.conversation.id).toBe(conversation.id);
    if (result.ok && result.renamed) {
      expect(result.previousTitle).toBe(conversation.title);
      expect(result.title).toBe("Ship notes");
    }

    // Durable truth: exactly one title line, one status line, preserved fields.
    const raw = await readFile(manifestPath(conversation.id), "utf8");
    expect(raw.split("\n").filter((line) => line.startsWith("title:"))).toEqual(['title: "Ship notes"']);
    expect(raw.split("\n").filter((line) => line.startsWith("status:"))).toEqual(["status: open"]);
    expect(raw).toContain(`created: ${NOW.toISOString()}`);
    expect(raw).toContain(`updated: ${LATER.toISOString()}`);
    const reread = await readConversation({ vaultRoot: root, conversationId: conversation.id });
    expect(reread.title).toBe("Ship notes");
    expect(reread.audience).toEqual(["zai"]);
  });

  it("appends exactly one immutable conversation_renamed event with previous/new title evidence", async () => {
    const conversation = await openConversation("Rename seed @zai");
    const result = await renameConversation({ vaultRoot: root, conversationId: conversation.id, title: "New title", now: () => LATER });
    if (!result.ok || !result.renamed) throw new Error("expected rename");
    expect(result.event.kind).toBe("conversation_renamed");

    const events = await readConversationEvents({ vaultRoot: root, conversationId: conversation.id });
    expect(events.map((e) => e.kind)).toEqual(["conversation_renamed"]);
    expect(events[0]?.authorKind).toBe("steward");
    expect(events[0]?.author).toBe("steward");
    expect(events[0]?.body).toContain("New title");
    expect(events[0]?.previousTitle).toBe(conversation.title);
    expect(events[0]?.title).toBe("New title");
    // The event is evidence, not authority: the manifest carries the title.
    expect((await readConversation({ vaultRoot: root, conversationId: conversation.id })).title).toBe("New title");
  });

  it("renames an archived conversation (title presentation is independent of attach state)", async () => {
    const conversation = await openConversation("Rename seed @zai");
    const archived = await transitionConversationLifecycle({
      vaultRoot: root, conversationId: conversation.id, transition: "archive", now: () => LATER,
    });
    if (!archived.ok || !archived.transitioned) throw new Error("setup: archive failed");
    const result = await renameConversation({ vaultRoot: root, conversationId: conversation.id, title: "Archived but titled", now: () => LATER2 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.renamed).toBe(true);
    expect(result.conversation.status).toBe("archived");
    expect(result.conversation.title).toBe("Archived but titled");
    const events = await readConversationEvents({ vaultRoot: root, conversationId: conversation.id });
    expect(events.map((e) => e.kind)).toEqual(["lifecycle_transition", "conversation_renamed"]);
  });

  it("round-trips titles containing quotes and backslashes through the manifest renderer", async () => {
    const conversation = await openConversation("Rename seed");
    const tricky = 'He said "hi" \\ and / more';
    const result = await renameConversation({ vaultRoot: root, conversationId: conversation.id, title: tricky, now: () => LATER });
    if (!result.ok || !result.renamed) throw new Error("expected rename");
    const reread = await readConversation({ vaultRoot: root, conversationId: conversation.id });
    expect(reread.title).toBe(tricky);
    const events = await readConversationEvents({ vaultRoot: root, conversationId: conversation.id });
    expect(events[0]?.title).toBe(tricky);
    expect(events[0]?.previousTitle).toBe(conversation.title);
  });
});

describe("idempotent same-title no-op (U2 selected default)", () => {
  it("a request whose normalized title equals the durable title returns renamed:false with NO write and NO event", async () => {
    const conversation = await openConversation("Rename seed @zai");
    const before = await readFile(manifestPath(conversation.id), "utf8");
    const eventCount = (await readConversationEvents({ vaultRoot: root, conversationId: conversation.id })).length;

    const repeat = await renameConversation({ vaultRoot: root, conversationId: conversation.id, title: `  ${conversation.title}  `, now: () => LATER });
    expect(repeat.ok).toBe(true);
    if (!repeat.ok) throw new Error("expected ok");
    expect(repeat.renamed).toBe(false);
    expect(repeat.conversation.title).toBe(conversation.title);
    // No manifest write (updated untouched) and no new event.
    expect(await readFile(manifestPath(conversation.id), "utf8")).toBe(before);
    expect((await readConversationEvents({ vaultRoot: root, conversationId: conversation.id })).length).toBe(eventCount);
  });
});

describe("locking and races (U2)", () => {
  it("a missing conversation is NOT lock-busy: the honest absence error propagates", async () => {
    await mkdir(join(root, "collaboration", "conversations"), { recursive: true });
    let caught: unknown;
    try {
      await renameConversation({ vaultRoot: root, conversationId: "20260806T000000000Z-missing", title: "x", now: () => LATER });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: unknown }).code).toBe("ENOENT");
  });

  it("a held lock fails closed before any manifest write or rename event", async () => {
    const conversation = await openConversation();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = renameConversation({
      vaultRoot: root, conversationId: conversation.id, title: "Winner title",
      now: () => LATER, holdBarrier: gate,
    });
    await waitForLock(conversation.id);

    const before = await readFile(manifestPath(conversation.id), "utf8");
    const contended = await renameConversation({ vaultRoot: root, conversationId: conversation.id, title: "Loser title", now: () => LATER2 });
    expect(contended.ok).toBe(false);
    if (contended.ok) throw new Error("expected lock-busy");
    expect(contended.kind).toBe("lock-busy");
    // No manifest write and no event side effect from the contended attempt.
    expect(await readFile(manifestPath(conversation.id), "utf8")).toBe(before);
    expect(await readConversationEvents({ vaultRoot: root, conversationId: conversation.id })).toEqual([]);

    release();
    const winner = await held;
    expect(winner.ok).toBe(true);
    if (!winner.ok) throw new Error("expected ok");
    expect(winner.renamed).toBe(true);
    expect(winner.conversation.title).toBe("Winner title");
    await expect(stat(lockPath(conversation.id))).rejects.toThrow();
  });

  it("rename serializes with the lifecycle transition lock (contention is a typed 409 boundary)", async () => {
    const conversation = await openConversation();
    // Archive holds the lock via its own acquisition; a concurrent rename
    // attempt while the lifecycle lock is held fails closed.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = transitionConversationLifecycle({
      vaultRoot: root, conversationId: conversation.id, transition: "archive",
      now: () => LATER, holdBarrier: gate,
    });
    await waitForLock(conversation.id);
    const contended = await renameConversation({ vaultRoot: root, conversationId: conversation.id, title: "Busy", now: () => LATER2 });
    expect(contended.ok).toBe(false);
    if (contended.ok) throw new Error("expected lock-busy");
    expect(contended.kind).toBe("lock-busy");
    release();
    await held;
  });
});

describe("event-append failure boundary (U2)", () => {
  it("a failed rename event append leaves the renamed manifest authoritative and returns the typed failure", async () => {
    const conversation = await openConversation();
    const failingIo: ConversationWriteIo = {
      linkNoClobber: async () => {
        throw new Error("disk full (injected)");
      },
      remove: async () => {},
    };
    const result = await renameConversation({
      vaultRoot: root, conversationId: conversation.id, title: "Renamed anyway",
      now: () => LATER, io: failingIo, nonce: () => "rn",
    });
    if (result.ok || result.kind !== "event-append-failed") throw new Error("expected event-append-failed");
    expect(result.conversation.title).toBe("Renamed anyway");
    expect(result.conversation.updated).toBe(LATER.toISOString());

    // No rollback, no auto-repair/retry, no fake event: the manifest stays
    // renamed and the events dir contains no rename event.
    const reread = await readConversation({ vaultRoot: root, conversationId: conversation.id });
    expect(reread.title).toBe("Renamed anyway");
    expect(await readConversationEvents({ vaultRoot: root, conversationId: conversation.id })).toEqual([]);

    // A later rename with a working io appends exactly one event (no duplicate
    // from the failed attempt).
    const retry = await renameConversation({ vaultRoot: root, conversationId: conversation.id, title: "Renamed again", now: () => LATER2 });
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error("expected ok");
    expect(retry.renamed).toBe(true);
    const after = await readConversationEvents({ vaultRoot: root, conversationId: conversation.id });
    expect(after.map((e) => e.kind)).toEqual(["conversation_renamed"]);
    expect(after[0]?.title).toBe("Renamed again");
    expect(after[0]?.previousTitle).toBe("Renamed anyway");
  });
});

describe("conversation_renamed event kind/metadata (fail-closed, additive)", () => {
  it("reads a conversation_renamed event back with both bounded titles and keeps old kinds compatible", async () => {
    const conversation = await openConversation("Rename seed");
    const result = await renameConversation({ vaultRoot: root, conversationId: conversation.id, title: "Fresh name", now: () => LATER });
    if (!result.ok || !result.renamed) throw new Error("expected rename");
    const events = await readConversationEvents({ vaultRoot: root, conversationId: conversation.id });
    expect(events[0]?.previousTitle).toBe(conversation.title);
    expect(events[0]?.title).toBe("Fresh name");
    expect(events[0]?.sequence).toBe(1);
    // The strict parser rejects a present-but-invalid stored rename metadata.
    const eventsDir = join(root, "collaboration", "conversations", conversation.id, "events");
    await writeFile(
      join(eventsDir, "00000002.md"),
      [
        "---",
        "type: Conversation Event",
        "id: e-bogus",
        `conversationId: ${conversation.id}`,
        "kind: conversation_renamed",
        "authorKind: steward",
        "author: steward",
        `created: ${LATER.toISOString()}`,
        "sequence: 2",
        'previousTitle: "old"',
        "title: 42",
        "---",
        "",
        "Renamed.",
        "",
      ].join("\n"),
      "utf8",
    );
    await expect(readConversationEvents({ vaultRoot: root, conversationId: conversation.id })).rejects.toThrow(/title/i);
  });

  it("existing event kinds still parse after the additive kind (compatibility)", async () => {
    const conversation = await openConversation("Rename seed");
    const result = await renameConversation({ vaultRoot: root, conversationId: conversation.id, title: "N", now: () => LATER });
    if (!result.ok || !result.renamed) throw new Error("expected rename");
    const events = await readConversationEvents({ vaultRoot: root, conversationId: conversation.id });
    expect(events.map((e) => e.kind)).toEqual(["conversation_renamed"]);
    expect(events[0]?.lifecycleState).toBeUndefined();
  });
});

describe("no broker/Pi/HTTP side effects (U2)", () => {
  it("the rename core introduces no broker/Pi/HTTP imports or calls", async () => {
    const source = await readFile(join(process.cwd(), "src", "conversations.ts"), "utf8");
    const importLines = source.split("\n").filter((line) => /^import\s/.test(line));
    for (const line of importLines) {
      expect(line).not.toMatch(/gateway|broker|rpc|pi-|pi\.|http/i);
    }
    expect(source).not.toMatch(/new ConversationBroker|PiRpcClient|dispatchConversationMention/);
  });

  it("rename changes no membership and never touches collaboration/rooms", async () => {
    const conversation = await openConversation("Rename seed @zai");
    const result = await renameConversation({ vaultRoot: root, conversationId: conversation.id, title: "Member-safe", now: () => LATER });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.conversation.audience).toEqual(["zai"]);
    await expect(stat(join(root, "collaboration", "rooms"))).rejects.toThrow();
    const conversationsDir = await readdir(join(root, "collaboration", "conversations"));
    expect(conversationsDir).toEqual([conversation.id]);
  });
});
