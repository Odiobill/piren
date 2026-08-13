import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConversation,
  readConversation,
  listConversations,
  readConversationEvents,
  conversationGenericId,
  conversationIdFromText,
  randomConversationSuffix,
  CONVERSATION_GENERIC_SUFFIX_HEX_LENGTH,
  CONVERSATION_GENERIC_MAX_CANDIDATES,
} from "../src/conversations.js";

/**
 * P2 — generic Conversation id contract (accepted
 * `conversation-generic-id-contract.md`, 2026-08-12): new Conversations get
 * server-generated neutral `<compact-UTC>-c-<12-lowercase-hex>` ids with no
 * first-message text/mentions; atomic no-clobber with bounded collision
 * retry (three total candidates then the existing safe 409); the injected
 * suffix seam is test-only and never HTTP-exposed; existing slug ids remain
 * valid forever with no migration.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-p2-ids-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const NOW = new Date("2026-08-05T13:15:30.000Z");

describe("conversationGenericId (exact neutral shape)", () => {
  it("builds `<compact-UTC>-c-<12-lowercase-hex>` from the timestamp and injected suffix", () => {
    const id = conversationGenericId(NOW, "4fa21bc093de");
    expect(id).toBe("20260805T131530000Z-c-4fa21bc093de");
    expect(id).toMatch(/^[0-9]{8}T[0-9]{9}Z-c-[0-9a-f]{12}$/);
    expect(CONVERSATION_GENERIC_SUFFIX_HEX_LENGTH).toBe(12);
  });

  it("rejects a malformed suffix fail-closed before any id is produced", () => {
    for (const bad of ["", "abc", "4fa21bc093de0", "4FA21BC093DE", "4fa21bc093d-", "4fa21bc093de!"] as const) {
      expect(() => conversationGenericId(NOW, bad)).toThrow(/Invalid conversation id suffix/i);
    }
  });
});

describe("randomConversationSuffix (production generator)", () => {
  it("returns exactly 12 lowercase hexadecimal characters and varies across calls", () => {
    const suffixes = new Set<string>();
    for (let index = 0; index < 16; index += 1) {
      const suffix = randomConversationSuffix();
      expect(suffix).toMatch(/^[0-9a-f]{12}$/);
      suffixes.add(suffix);
    }
    // Collision chance for 16 draws of 48-bit nonces is negligible.
    expect(suffixes.size).toBeGreaterThan(1);
  });
});

describe("createConversation with the injected suffix seam", () => {
  it("writes the manifest and events under the neutral id with no first-message text anywhere in the id", async () => {
    const text = "Please review the C2 contract @zai and @ghost";
    const conversation = await createConversation({
      vaultRoot: root,
      text,
      audience: ["zai", "ghost"],
      now: () => NOW,
      suffix: () => "4fa21bc093de",
    });
    expect(conversation.id).toBe("20260805T131530000Z-c-4fa21bc093de");
    // No message text, mention, title, or slug fragment leaks into the id.
    for (const leaked of ["review", "contract", "zai", "ghost", "please", "hello", "conversation"]) {
      expect(conversation.id).not.toContain(leaked);
    }
    const dir = join(root, "collaboration", "conversations", conversation.id);
    const entries = await readdir(dir);
    expect(entries).toEqual(["events", "index.md"]);
    const raw = await readFile(join(dir, "index.md"), "utf8");
    expect(raw).toContain(`id: ${conversation.id}`);
    // The display title drops only the literal `Conversation ` prefix (P6);
    // the id remains neutral and first-message-free (P2).
    expect(conversation.title).toBe("2026-08-05 13:15 - Please review the C2 contract @zai and @ghost");
  });

  it("retries a forced collision on the second candidate (atomic no-clobber preserved)", async () => {
    await createConversation({ vaultRoot: root, text: "first", audience: [], now: () => NOW, suffix: () => "aaaaaaaaaaaa" });
    let calls = 0;
    const suffix = () => {
      calls += 1;
      return calls === 1 ? "aaaaaaaaaaaa" : "bbbbbbbbbbbb";
    };
    const second = await createConversation({ vaultRoot: root, text: "second", audience: [], now: () => NOW, suffix });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(second.id).toBe("20260805T131530000Z-c-bbbbbbbbbbbb");
    // The first conversation is untouched (no overwrite, no extra events).
    const first = await readConversation({ vaultRoot: root, conversationId: "20260805T131530000Z-c-aaaaaaaaaaaa" });
    expect(first.title).toContain("first");
    expect((await readConversationEvents({ vaultRoot: root, conversationId: first.id }))).toEqual([]);
  });

  it("bounded exhaustion (three total candidates) fails safe with no overwrite/event/membership/dispatch", async () => {
    // Pre-create three conversations whose ids the failing attempt will hit.
    const existing: string[] = [];
    for (const suffix of ["111111111111", "222222222222", "333333333333"] as const) {
      const created = await createConversation({ vaultRoot: root, text: `pre ${suffix}`, audience: [], now: () => NOW, suffix: () => suffix });
      existing.push(created.id);
    }
    const before = new Map<string, string>();
    for (const id of existing) {
      before.set(id, await readFile(join(root, "collaboration", "conversations", id, "index.md"), "utf8"));
    }

    const colliding = ["111111111111", "222222222222", "333333333333"];
    let calls = 0;
    const suffix = () => colliding[calls++] as string;
    await expect(
      createConversation({ vaultRoot: root, text: "doomed", audience: [], now: () => NOW, suffix }),
    ).rejects.toThrow(/Conversation already exists/i);
    expect(calls).toBe(CONVERSATION_GENERIC_MAX_CANDIDATES);
    expect(CONVERSATION_GENERIC_MAX_CANDIDATES).toBe(3);

    // No overwrite: every existing manifest is byte-identical.
    for (const id of existing) {
      expect(await readFile(join(root, "collaboration", "conversations", id, "index.md"), "utf8")).toBe(before.get(id));
    }
    // No new directory, no membership/dispatch side effect, no events.
    const dirs = (await readdir(join(root, "collaboration", "conversations"))).sort();
    expect(dirs).toEqual([...existing].sort());
    for (const id of existing) {
      expect(await readConversationEvents({ vaultRoot: root, conversationId: id })).toEqual([]);
    }
    expect((await listConversations({ vaultRoot: root })).map((c) => c.id).sort()).toEqual([...existing].sort());
  });
});

describe("legacy slug-id backward compatibility (no migration)", () => {
  it("existing slug ids keep parsing, reading, listing, and deep-link formatting unchanged", async () => {
    // Simulate a pre-P2 conversation: a manifest under the legacy slug id.
    const legacyId = conversationIdFromText("Hello @zai", NOW);
    expect(legacyId).toBe("20260805T131530000Z-hello-zai");
    const legacyDir = join(root, "collaboration", "conversations", legacyId);
    await import("node:fs/promises").then((fs) => fs.mkdir(join(legacyDir, "events"), { recursive: true }));
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        join(legacyDir, "index.md"),
        [
          "---",
          "type: Conversation Manifest",
          `id: ${legacyId}`,
          `title: "Legacy conversation"`,
          "audience: []",
          "status: open",
          "created_by: steward",
          "created: 2026-08-05T13:15:30.000Z",
          "updated: 2026-08-05T13:15:30.000Z",
          "---",
          "",
        ].join("\n"),
        "utf8",
      ),
    );

    // Read and list still work byte-for-byte under existing rules.
    const conversation = await readConversation({ vaultRoot: root, conversationId: legacyId });
    expect(conversation.id).toBe(legacyId);
    expect(conversation.title).toBe("Legacy conversation");
    expect((await listConversations({ vaultRoot: root })).map((c) => c.id)).toEqual([legacyId]);
    expect((await readConversationEvents({ vaultRoot: root, conversationId: legacyId }))).toEqual([]);
    // A generic create beside it coexists; the old record is never touched.
    const generic = await createConversation({
      vaultRoot: root,
      text: "new @zai",
      audience: ["zai"],
      now: () => NOW,
      suffix: () => "4fa21bc093de",
    });
    expect(generic.id).toMatch(/^20260805T131530000Z-c-[0-9a-f]{12}$/);
    expect((await listConversations({ vaultRoot: root })).map((c) => c.id).sort()).toEqual([legacyId, generic.id].sort());
    expect((await readConversation({ vaultRoot: root, conversationId: legacyId })).title).toBe("Legacy conversation");
  });
});

describe("the suffix seam is never exposed through HTTP", () => {
  it("the gateway create route reads only {text} and never accepts an id/suffix field or option", async () => {
    const gateway = await import("node:fs/promises").then((fs) => fs.readFile(join(process.cwd(), "src", "gateway-http.ts"), "utf8"));
    const createSection = gateway.slice(gateway.indexOf("private async handleConversationCreate"), gateway.indexOf("private async handleConversationList"));
    // The request body field is exactly text.
    expect(createSection).toContain("const text = parsed.value.text;");
    expect(createSection).not.toMatch(/parsed\.value\.(id|suffix|nonce)/);
    // The durable core is invoked without any suffix seam from the gateway.
    expect(createSection).toContain("audience: resolved.recipients,");
    expect(createSection).not.toMatch(/suffix\s*:/);
    const core = await import("node:fs/promises").then((fs) => fs.readFile(join(process.cwd(), "src", "conversations.ts"), "utf8"));
    // The seam exists only as an injected option in the durable core.
    expect(core).toContain("suffix?: () => string");
  });
});
