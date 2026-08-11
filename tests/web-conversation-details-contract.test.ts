import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRenameHttpError, parseRenameResponse, normalizeConversationTitle } from "../web/src/conversation-details.js";
import { conversationEventLabel } from "../web/src/conversation-timeline.js";
import type { ConversationEventRecord } from "../web/src/conversations.js";

/**
 * U2 — Workbench details modal + rename client contract (accepted
 * `conversation-details-rename-contract.md` §U2 UI contract):
 *   - fail-closed rename envelope parsing (event present iff renamed:true,
 *     carrying both bounded titles);
 *   - bounded rename error mapping (no raw server internals; 500 never
 *     echoed raw);
 *   - mirror title validation for the truthful Save-disable rule;
 *   - an accessible focus-managed details modal with the metadata +
 *     Archive/Reopen controls relocated inside it, a composer-right details
 *     toggle on the active surface, a minimal inspection action row on
 *     read-only inspection, and NO details surface for a browser-local draft.
 */

const webSrc = join(process.cwd(), "web", "src");

async function readSourceFiles(): Promise<Map<string, string>> {
  const files = await readdir(webSrc, { recursive: true });
  const sources = new Map<string, string>();
  for (const f of files) {
    if (typeof f === "string" && (f.endsWith(".ts") || f.endsWith(".tsx"))) {
      sources.set(f, await readFile(join(webSrc, f), "utf8"));
    }
  }
  return sources;
}

const BASE_EVENT = {
  id: "e1",
  conversationId: "c1",
  kind: "conversation_renamed",
  created: "2026-08-11T00:00:00.000Z",
  previousTitle: "Old",
  title: "New",
};

const BASE_CONVERSATION = {
  id: "c1",
  title: "New",
  path: "collaboration/conversations/c1/index.md",
  createdBy: "steward",
  audience: [] as string[],
  status: "open",
  created: "2026-08-05T00:00:00.000Z",
  updated: "2026-08-11T00:00:00.000Z",
};

describe("rename response envelope parser (pure)", () => {
  it("accepts renamed:true with the event carrying both bounded titles", () => {
    const parsed = parseRenameResponse({ renamed: true, conversation: BASE_CONVERSATION, event: BASE_EVENT });
    expect(parsed.renamed).toBe(true);
    if (!parsed.renamed) throw new Error("expected renamed");
    expect(parsed.conversation.title).toBe("New");
    expect(parsed.event.kind).toBe("conversation_renamed");
    expect(parsed.event.previousTitle).toBe("Old");
    expect(parsed.event.title).toBe("New");
  });

  it("accepts renamed:false without an event (same-title no-op)", () => {
    const parsed = parseRenameResponse({ renamed: false, conversation: { ...BASE_CONVERSATION, title: "Old" } });
    expect(parsed.renamed).toBe(false);
    if (parsed.renamed) throw new Error("expected no-op");
    expect(parsed.conversation.title).toBe("Old");
  });

  it("rejects contradictory envelopes fail-closed", () => {
    // Event required when renamed:true.
    expect(() => parseRenameResponse({ renamed: true, conversation: BASE_CONVERSATION })).toThrow();
    // Event forbidden when renamed:false.
    expect(() => parseRenameResponse({ renamed: false, conversation: BASE_CONVERSATION, event: BASE_EVENT })).toThrow();
    // Wrong event kind.
    expect(() =>
      parseRenameResponse({ renamed: true, conversation: BASE_CONVERSATION, event: { ...BASE_EVENT, kind: "lifecycle_transition" } }),
    ).toThrow();
    // Missing bounded titles in the event.
    expect(() =>
      parseRenameResponse({
        renamed: true,
        conversation: BASE_CONVERSATION,
        event: { id: "e1", conversationId: "c1", kind: "conversation_renamed", created: "x", previousTitle: "Old" },
      }),
    ).toThrow();
    // Malformed conversation record.
    expect(() => parseRenameResponse({ renamed: false, conversation: { ...BASE_CONVERSATION, audience: "no" } })).toThrow();
  });
});

describe("rename error mapping (pure, bounded)", () => {
  it("maps 400 to invalid-title with the bounded server text when present", () => {
    const error = parseRenameHttpError(400, { error: "conversation title is required" });
    expect(error.kind).toBe("invalid-title");
    expect(error.message).toBe("conversation title is required");
  });

  it("maps 404/409 to not-found/conflict with deterministic copy", () => {
    expect(parseRenameHttpError(404, { error: "whatever" }).kind).toBe("not-found");
    expect(parseRenameHttpError(409, { error: "busy text" }).kind).toBe("conflict");
    expect(parseRenameHttpError(409, { error: "busy text" }).message).toContain("busy text");
  });

  it("maps 500 to a deterministic server message and never echoes raw internals", () => {
    const error = parseRenameHttpError(500, { error: "ENOTDIR: not a directory /var/..." });
    expect(error.kind).toBe("server");
    expect(error.message).not.toMatch(/ENOTDIR|var\/|absolutePath|token|disk full/i);
  });

  it("falls back to typed copy when the body has no usable error text", () => {
    expect(parseRenameHttpError(400, null).kind).toBe("invalid-title");
    expect(parseRenameHttpError(409, null).kind).toBe("conflict");
    expect(parseRenameHttpError(500, null).kind).toBe("server");
    expect(parseRenameHttpError(418, { error: "teapot" }).kind).toBe("server");
  });
});

describe("mirror title validation (pure, truthful Save-disable)", () => {
  it("normalizes and validates exactly like the server core (trim, 1–120 code units, no control/newline)", () => {
    expect(normalizeConversationTitle("  Ready  ")).toEqual({ ok: true, title: "Ready" });
    expect(normalizeConversationTitle("   ")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeConversationTitle("a\nb")).toEqual({ ok: false, reason: "control-or-newline" });
    expect(normalizeConversationTitle("x".repeat(121))).toEqual({ ok: false, reason: "too-long" });
    expect(normalizeConversationTitle("a".repeat(120))?.ok).toBe(true);
  });
});

describe("timeline label for the durable rename evidence (pure)", () => {
  it("labels a conversation_renamed event neutrally without manufacturing history", () => {
    const event: ConversationEventRecord = {
      id: "e1",
      conversationId: "c1",
      kind: "conversation_renamed",
      authorKind: "steward",
      author: "steward",
      created: "2026-08-11T00:00:00.000Z",
      sequence: 2,
      mentions: [],
      body: "Renamed to: New",
      path: "collaboration/conversations/c1/events/00000002.md",
    };
    expect(conversationEventLabel(event)).toBe("Conversation renamed");
  });
});

describe("details modal + toggle surface (static)", () => {
  it("the details modal is an accessible focus-managed dialog with labelled title editing", async () => {
    const sources = await readSourceFiles();
    const modal = sources.get("ConversationDetailsModal.tsx") ?? "";
    expect(modal).toContain('role="dialog"');
    expect(modal).toContain('aria-modal="true"');
    expect(modal).toContain("aria-labelledby");
    expect(modal).toContain('"Escape"');
    expect(modal).toContain('"Tab"');
    expect(modal).toContain("aria-label");
    expect(modal).toContain("Save");
    expect(modal).toContain("Cancel");
    expect(modal).toContain("Retry");
    expect(modal).toContain('role="alert"');
  });

  it("the details toggle has the accessible name Conversation details and sits composer-right on the active surface", async () => {
    const sources = await readSourceFiles();
    const navigator = sources.get("ConversationNavigator.tsx") ?? "";
    expect(navigator).toContain('aria-label="Conversation details"');
    expect(navigator).toContain("composer-action-row");
    expect(navigator).toContain("inspection-actions");
  });

  it("title/id/status/audience/timestamps and Archive/Reopen live inside the modal, not on the routine card", async () => {
    const sources = await readSourceFiles();
    const modal = sources.get("ConversationDetailsModal.tsx") ?? "";
    const navigator = sources.get("ConversationNavigator.tsx") ?? "";
    expect(modal).toContain("ConversationLifecycleControls");
    expect(modal).toContain("AudienceMembers");
    expect(modal).toContain("conversation.updated");
    expect(modal).toContain("conversation.created");
    // The navigator opens the modal for the selected conversation; the modal
    // is mounted only while it is explicitly open.
    expect(navigator).toContain("detailsOpen");
    expect(navigator).toContain("ConversationDetailsModal");
  });

  it("a browser-local draft has no details surface (modal renders only for a selected conversation)", async () => {
    const sources = await readSourceFiles();
    const navigator = sources.get("ConversationNavigator.tsx") ?? "";
    // The modal is guarded by detailsOpen and rendered only inside the
    // active/read-only selection branch; the draft branch never references it.
    expect(navigator).toMatch(/detailsOpen\s*&&\s*\(\s*<ConversationDetailsModal/);
    const draftIndex = navigator.indexOf("conversation-draft");
    expect(draftIndex).toBeGreaterThan(-1);
    const draftSection = navigator.slice(draftIndex, draftIndex + 700);
    expect(draftSection).not.toContain("Conversation details");
  });

  it("no storage, forbidden endpoints, or raw internals in the details/rename surface", async () => {
    const sources = await readSourceFiles();
    // The new U2 files must never reference storage, native SSE, or the
    // chat/room/vault endpoint families; api.ts is the shared transport and
    // legitimately contains the room family, so it is checked only for
    // rename-surface raw internals.
    for (const name of ["ConversationDetailsModal.tsx", "conversation-details.ts", "ConversationNavigator.tsx"]) {
      const content = sources.get(name) ?? "";
      for (const forbidden of ["localStorage", "sessionStorage", "new EventSource", "/api/chat", "/api/rooms", "/api/vault"]) {
        expect(content, `${name} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
    const details = sources.get("conversation-details.ts") ?? "";
    expect(details).not.toMatch(/absolutePath|acquiredAt|ENOTDIR|EACCES|disk full|token:/i);
  });
});
