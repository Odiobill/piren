import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConversation,
  appendConversationEvent,
  readConversation,
  readConversationEvents,
  transitionConversationLifecycle,
  updateConversationAudience,
  type ConversationLifecycleTransitionKind,
  type ConversationManifest,
  type ConversationWriteIo,
} from "../src/conversations.js";
import { resolveStewardMentions } from "../src/conversation-contract.js";

/**
 * L1 — pure durable Conversation lifecycle core (accepted contract
 * `conversation-archive-reopen-lifecycle-contract.md`, selected defaults):
 * status-safe manifest rewrites, archive/reopen transitions over the existing
 * per-conversation lock, exactly one `lifecycle_transition` event per actual
 * transition, idempotent no-op repeats, manifest-first event ordering with a
 * typed event-append-failed outcome (no rollback/retry/auto-repair), and no
 * broker/Pi/HTTP/session/membership side effects.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-lifecycle-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const NOW = new Date("2026-08-05T13:15:30.000Z");
const LATER = new Date("2026-08-05T14:00:00.000Z");
const LATER2 = new Date("2026-08-05T15:00:00.000Z");

async function openConversation(text = "Lifecycle seed @zai", audience: string[] = ["zai"]): Promise<ConversationManifest> {
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

describe("status-safe manifest rewrites (L1)", () => {
  it("preserves an archived manifest status through an audience update (never silently reopens)", async () => {
    const conversation = await openConversation();
    const archived = await transitionConversationLifecycle({
      vaultRoot: root, conversationId: conversation.id, transition: "archive", now: () => LATER,
    });
    if (!archived.ok || !archived.transitioned) throw new Error("setup: archive failed");

    const dipu = resolveStewardMentions("@dipu", ["dipu", "zai"]);
    if (!dipu.ok) throw new Error("test setup");
    const updated = await updateConversationAudience({
      vaultRoot: root,
      conversationId: conversation.id,
      additions: dipu.validated,
      now: () => LATER2,
    });

    // The audience update preserved the archived state; created stays
    // byte-for-byte; updated bumped; audience grew additively.
    expect(updated.status).toBe("archived");
    expect(updated.created).toBe(NOW.toISOString());
    expect(updated.updated).toBe(LATER2.toISOString());
    expect(updated.audience).toEqual(["zai", "dipu"]);
    const reread = await readConversation({ vaultRoot: root, conversationId: conversation.id });
    expect(reread.status).toBe("archived");
    expect(reread.audience).toEqual(["zai", "dipu"]);
  });

  it("preserves an open status through an audience update (regression)", async () => {
    const conversation = await openConversation();
    const dipu = resolveStewardMentions("@dipu", ["dipu", "zai"]);
    if (!dipu.ok) throw new Error("test setup");
    const updated = await updateConversationAudience({
      vaultRoot: root, conversationId: conversation.id, additions: dipu.validated, now: () => LATER,
    });
    expect(updated.status).toBe("open");
  });
});

describe("transitionConversationLifecycle archive/reopen success (L1)", () => {
  it("archives an open conversation: status flipped, created/audience preserved, updated bumped", async () => {
    const conversation = await openConversation();
    const result = await transitionConversationLifecycle({
      vaultRoot: root, conversationId: conversation.id, transition: "archive", now: () => LATER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.transitioned).toBe(true);
    expect(result.conversation.status).toBe("archived");
    expect(result.conversation.created).toBe(NOW.toISOString());
    expect(result.conversation.audience).toEqual(["zai"]);
    expect(result.conversation.updated).toBe(LATER.toISOString());

    const raw = await readFile(manifestPath(conversation.id), "utf8");
    expect(raw).toContain("status: archived");
    expect(raw).toContain(`created: ${NOW.toISOString()}`);
    const reread = await readConversation({ vaultRoot: root, conversationId: conversation.id });
    expect(reread.status).toBe("archived");
  });

  it("reopens an archived conversation and emits exactly one lifecycle_transition event each way", async () => {
    const conversation = await openConversation();
    const archive = await transitionConversationLifecycle({
      vaultRoot: root, conversationId: conversation.id, transition: "archive", now: () => LATER,
    });
    if (!archive.ok || !archive.transitioned) throw new Error("setup: archive failed");
    expect(archive.event.kind).toBe("lifecycle_transition");

    const reopen = await transitionConversationLifecycle({
      vaultRoot: root, conversationId: conversation.id, transition: "reopen", now: () => LATER2,
    });
    expect(reopen.ok).toBe(true);
    if (!reopen.ok) throw new Error("expected ok");
    expect(reopen.transitioned).toBe(true);
    expect(reopen.conversation.status).toBe("open");
    expect(reopen.conversation.created).toBe(NOW.toISOString());
    expect(reopen.conversation.audience).toEqual(["zai"]);
    expect(reopen.conversation.updated).toBe(LATER2.toISOString());

    const events = await readConversationEvents({ vaultRoot: root, conversationId: conversation.id });
    expect(events.map((e) => e.kind)).toEqual(["lifecycle_transition", "lifecycle_transition"]);
    // Bounded steward-authored semantics + metadata, parsed back fail-closed.
    expect(events[0]?.authorKind).toBe("steward");
    expect(events[0]?.author).toBe("steward");
    expect(events[0]?.body).toBe("Archived by steward.");
    expect(events[0]?.lifecycleState).toBe("archived");
    expect(events[1]?.body).toBe("Reopened by steward.");
    expect(events[1]?.lifecycleState).toBe("open");
    expect(events[1]?.sequence).toBeGreaterThan(events[0]?.sequence ?? 0);
  });
});

describe("idempotent no-op repeats (L1 selected default)", () => {
  it("archiving an already-archived conversation writes nothing and appends no event", async () => {
    const conversation = await openConversation();
    const archive = await transitionConversationLifecycle({
      vaultRoot: root, conversationId: conversation.id, transition: "archive", now: () => LATER,
    });
    if (!archive.ok || !archive.transitioned) throw new Error("setup: archive failed");
    const before = await readFile(manifestPath(conversation.id), "utf8");
    const eventCount = (await readConversationEvents({ vaultRoot: root, conversationId: conversation.id })).length;

    const repeat = await transitionConversationLifecycle({
      vaultRoot: root, conversationId: conversation.id, transition: "archive", now: () => LATER2,
    });
    expect(repeat.ok).toBe(true);
    if (!repeat.ok) throw new Error("expected ok");
    expect(repeat.transitioned).toBe(false);
    expect(repeat.conversation.status).toBe("archived");
    // No manifest write (updated untouched) and no new event.
    expect(await readFile(manifestPath(conversation.id), "utf8")).toBe(before);
    expect((await readConversationEvents({ vaultRoot: root, conversationId: conversation.id })).length).toBe(eventCount);
  });

  it("reopening an already-open conversation writes nothing and appends no event", async () => {
    const conversation = await openConversation();
    const before = await readFile(manifestPath(conversation.id), "utf8");
    const repeat = await transitionConversationLifecycle({
      vaultRoot: root, conversationId: conversation.id, transition: "reopen", now: () => LATER,
    });
    expect(repeat.ok).toBe(true);
    if (!repeat.ok) throw new Error("expected ok");
    expect(repeat.transitioned).toBe(false);
    expect(repeat.conversation.status).toBe("open");
    expect(await readFile(manifestPath(conversation.id), "utf8")).toBe(before);
    expect(await readConversationEvents({ vaultRoot: root, conversationId: conversation.id })).toEqual([]);
  });
});

describe("lifecycle event kind/metadata validation (fail-closed, additive)", () => {
  it("appends a lifecycle_transition event with valid metadata and reads it back", async () => {
    const conversation = await openConversation();
    const event = await appendConversationEvent({
      vaultRoot: root,
      conversationId: conversation.id,
      kind: "lifecycle_transition",
      authorKind: "steward",
      author: "steward",
      body: "Archived by steward.",
      lifecycleState: "archived",
      now: () => LATER,
      nonce: () => "lc1",
    });
    expect(event.kind).toBe("lifecycle_transition");
    const events = await readConversationEvents({ vaultRoot: root, conversationId: conversation.id });
    expect(events[0]?.lifecycleState).toBe("archived");
  });

  it("rejects a present-but-invalid lifecycleState at append time", async () => {
    const conversation = await openConversation();
    await expect(
      appendConversationEvent({
        vaultRoot: root, conversationId: conversation.id, kind: "lifecycle_transition",
        authorKind: "steward", author: "steward", body: "x", lifecycleState: "bogus" as never,
        now: () => LATER,
      }),
    ).rejects.toThrow(/lifecycleState/i);
  });

  it("rejects a malformed stored lifecycleState fail-closed at parse time, naming the path", async () => {
    const conversation = await openConversation();
    const eventsDir = join(root, "collaboration", "conversations", conversation.id, "events");
    // Hand-write one event whose frontmatter carries a present-but-invalid
    // lifecycleState: the strict parser must reject it, naming the path.
    await writeFile(
      join(eventsDir, "00000001.md"),
      [
        "---",
        "type: Conversation Event",
        "id: e-bogus",
        `conversationId: ${conversation.id}`,
        "kind: lifecycle_transition",
        "authorKind: steward",
        "author: steward",
        `created: ${NOW.toISOString()}`,
        "sequence: 1",
        "lifecycleState: bogus",
        "---",
        "",
        "Archived by steward.",
        "",
      ].join("\n"),
      "utf8",
    );
    await expect(readConversationEvents({ vaultRoot: root, conversationId: conversation.id })).rejects.toThrow(/lifecycleState/);
  });

  it("existing event kinds still parse and remain compatible", async () => {
    const conversation = await openConversation();
    await appendConversationEvent({
      vaultRoot: root, conversationId: conversation.id, kind: "steward_message",
      authorKind: "steward", author: "steward", body: "seed", now: () => NOW,
    });
    await appendConversationEvent({
      vaultRoot: root, conversationId: conversation.id, kind: "run_finished",
      authorKind: "system", author: "system", body: "ok", runStatus: "completed", now: () => NOW,
    });
    const events = await readConversationEvents({ vaultRoot: root, conversationId: conversation.id });
    expect(events.map((e) => e.kind)).toEqual(["steward_message", "run_finished"]);
    expect(events[0]?.lifecycleState).toBeUndefined();
  });
});

describe("locking and races (L1)", () => {
  it("a missing conversation is NOT lock-busy: the honest absence error propagates (Kimi review fix)", async () => {
    // The typed lock-busy boundary covers ONLY contention on a held lock. A
    // lock-acquisition I/O failure for an absent conversation (ENOENT) must
    // propagate so the later L2 gateway slice can map it to the contract's
    // 404 (absent is not contention; conversationError maps ENOENT to 404).
    await mkdir(join(root, "collaboration", "conversations"), { recursive: true });
    let caught: unknown;
    try {
      await transitionConversationLifecycle({
        vaultRoot: root, conversationId: "20260806T000000000Z-missing", transition: "archive", now: () => LATER,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: unknown }).code).toBe("ENOENT");
  });

  it("a held lock fails closed before any manifest write or lifecycle event", async () => {
    const conversation = await openConversation();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = transitionConversationLifecycle({
      vaultRoot: root, conversationId: conversation.id, transition: "archive",
      now: () => LATER, holdBarrier: gate,
    });
    await waitForLock(conversation.id);

    const before = await readFile(manifestPath(conversation.id), "utf8");
    const contended = await transitionConversationLifecycle({
      vaultRoot: root, conversationId: conversation.id, transition: "reopen", now: () => LATER2,
    });
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
    expect(winner.transitioned).toBe(true);
    expect(winner.conversation.status).toBe("archived");
    // The winner released the lock.
    await expect(stat(lockPath(conversation.id))).rejects.toThrow();
  });

  it("serialized archive/reopen never produces a torn or last-writer-wins manifest", async () => {
    const conversation = await openConversation();
    // A deterministic serialized sequence of transitions; every readback is a
    // fully parseable manifest in exactly one state with preserved fields.
    const states: string[] = [];
    for (const transition of ["archive", "reopen", "archive"] as const) {
      const result = await transitionConversationLifecycle({
        vaultRoot: root, conversationId: conversation.id, transition, now: () => LATER,
      });
      if (!result.ok || !result.transitioned) throw new Error(`setup: ${transition} failed`);
      states.push(result.conversation.status);
    }
    expect(states).toEqual(["archived", "open", "archived"]);
    const final = await readConversation({ vaultRoot: root, conversationId: conversation.id });
    expect(final.status).toBe("archived");
    expect(final.created).toBe(NOW.toISOString());
    expect(final.audience).toEqual(["zai"]);
    // Exactly one status line in the whole manifest (no torn/last-writer-wins
    // merge), and the file parses cleanly through the strict reader.
    const raw = await readFile(manifestPath(conversation.id), "utf8");
    const statusLines = raw.split("\n").filter((line) => line.startsWith("status:"));
    expect(statusLines).toEqual(["status: archived"]);
  });
});

describe("event-append failure boundary (L1)", () => {
  it("a failed lifecycle event append leaves the transitioned manifest authoritative and returns the typed failure", async () => {
    const conversation = await openConversation();
    // Failing io: every no-clobber link throws, so the event append fails while
    // the manifest rewrite (writeFile+rename) still succeeds.
    const failingIo: ConversationWriteIo = {
      linkNoClobber: async () => {
        throw new Error("disk full (injected)");
      },
      remove: async () => {},
    };
    const result = await transitionConversationLifecycle({
      vaultRoot: root, conversationId: conversation.id, transition: "archive",
      now: () => LATER, io: failingIo, nonce: () => "lc",
    });
    if (result.ok || result.kind !== "event-append-failed") throw new Error("expected event-append-failed");
    expect(result.conversation.status).toBe("archived");

    // No rollback, no auto-repair/retry, no fake event: the manifest stays
    // archived and the events dir contains no lifecycle event.
    const reread = await readConversation({ vaultRoot: root, conversationId: conversation.id });
    expect(reread.status).toBe("archived");
    expect(reread.updated).toBe(LATER.toISOString());
    const events = await readConversationEvents({ vaultRoot: root, conversationId: conversation.id });
    expect(events.every((e) => e.kind !== "lifecycle_transition")).toBe(true);
    expect(events).toHaveLength(0);

    // A later transition with a working io succeeds and appends exactly one
    // event (no duplicate from the failed attempt).
    const retry = await transitionConversationLifecycle({
      vaultRoot: root, conversationId: conversation.id, transition: "reopen", now: () => LATER2,
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error("expected ok");
    expect(retry.transitioned).toBe(true);
    expect(retry.conversation.status).toBe("open");
    const after = await readConversationEvents({ vaultRoot: root, conversationId: conversation.id });
    expect(after.map((e) => e.kind)).toEqual(["lifecycle_transition"]);
    expect(after[0]?.lifecycleState).toBe("open");
  });
});

describe("no broker/Pi/HTTP side effects (L1)", () => {
  it("the lifecycle core introduces no broker/Pi/HTTP imports or calls", async () => {
    const source = await readFile(join(process.cwd(), "src", "conversations.ts"), "utf8");
    const importLines = source.split("\n").filter((line) => /^import\s/.test(line));
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      expect(line).not.toMatch(/gateway|broker|rpc|pi-|pi\.|http/i);
    }
    // The transition helper never mentions dispatch/session/stream/membership
    // side effects in its own implementation body (no such calls exist).
    expect(source).not.toMatch(/new ConversationBroker|PiRpcClient|dispatchConversationMention/);
  });

  it("transition changes no membership and never touches collaboration/rooms", async () => {
    const conversation = await openConversation();
    const result = await transitionConversationLifecycle({
      vaultRoot: root, conversationId: conversation.id, transition: "archive", now: () => LATER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.conversation.audience).toEqual(["zai"]);
    await expect(stat(join(root, "collaboration", "rooms"))).rejects.toThrow();
    const conversationsDir = await readdir(join(root, "collaboration", "conversations"));
    expect(conversationsDir).toEqual([conversation.id]);
  });
});
