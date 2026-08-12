import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  conversationAudienceSummary,
  conversationMemberTitle,
  SIDEBAR_AUDIENCE_SUMMARY_FIT_CHARS,
} from "../web/src/conversations.js";
import { selectedConversationIdFromHash } from "../web/src/hash-route.js";

/**
 * P2 — Workbench gateway-truth refresh, sidebar selection/audience summary,
 * and contextual shell subtitle (accepted `workbench-chat-surface-polish-plan.md`
 * §P2): the UI refreshes the conversation list and the selected manifest only
 * from existing gateway reads/responses after create/message/rename/lifecycle;
 * the sidebar highlights the selected row and shows gateway-authoritative
 * title-cased audience names with a deterministic honest compact fallback;
 * the shell subtitle becomes the selected conversation's authoritative title
 * (draft keeps the calm generic subtitle). No client membership derivation,
 * optimistic invented audience, polling, storage, or new API/SSE schema.
 */

const webSrc = join(process.cwd(), "web", "src");

describe("conversationAudienceSummary (deterministic, gateway-truth formatting only)", () => {
  it("keeps the empty audience honest", () => {
    expect(conversationAudienceSummary([])).toBe("No agents yet");
  });

  it("shows a single member as its title-cased name", () => {
    expect(conversationAudienceSummary(["piren"])).toBe("Piren");
    expect(conversationAudienceSummary(["dipu"])).toBe("Dipu");
  });

  it("shows title-cased names joined when they fit one sidebar row", () => {
    expect(conversationAudienceSummary(["piren", "dipu"])).toBe("Piren, Dipu");
    expect(conversationAudienceSummary(["piren", "dipu", "kimi"])).toBe("Piren, Dipu, Kimi");
  });

  it("falls back to `First +N` when the joined names would overflow", () => {
    const many = ["piren", "dipu", "kimi", "sam", "zai", "zora", "nora", "dario"];
    expect(conversationAudienceSummary(many)).toBe("Piren +7");
  });

  it("falls back to the plain member count when even the compact form would overflow", () => {
    const hugeFirst = ["this-is-an-extremely-long-agent-name", "dipu", "kimi"];
    expect(conversationAudienceSummary(hugeFirst)).toBe("3 members");
  });

  it("respects an explicit fit bound and stays deterministic", () => {
    expect(conversationAudienceSummary(["piren", "dipu"], { fitChars: 9 })).toBe("Piren +1");
    expect(conversationAudienceSummary(["piren", "dipu"], { fitChars: 9 })).toBe("Piren +1");
    expect(conversationAudienceSummary(["piren", "dipu"], { fitChars: 4 })).toBe("2 members");
    expect(conversationAudienceSummary(["piren", "dipu"], { fitChars: 100 })).toBe("Piren, Dipu");
    expect(SIDEBAR_AUDIENCE_SUMMARY_FIT_CHARS).toBeGreaterThan(0);
  });
});

describe("conversationMemberTitle (lowercase-kebab → Title Case)", () => {
  it("title-cases single and multi-part agent names", () => {
    expect(conversationMemberTitle("piren")).toBe("Piren");
    expect(conversationMemberTitle("piren-agent")).toBe("Piren Agent");
    expect(conversationMemberTitle("a-b-c")).toBe("A B C");
    expect(conversationMemberTitle("agent0")).toBe("Agent0");
  });
});

describe("selectedConversationIdFromHash (sidebar selection truth)", () => {
  it("extracts the selected conversation id from a valid deep link", () => {
    expect(selectedConversationIdFromHash("#conversation/20260805T131530000Z-c-4fa21bc093de")).toBe(
      "20260805T131530000Z-c-4fa21bc093de",
    );
    expect(selectedConversationIdFromHash("#conversation/20260805T131530000Z-hello-zai")).toBe(
      "20260805T131530000Z-hello-zai",
    );
  });

  it("returns null for home and invalid routes (no selection)", () => {
    expect(selectedConversationIdFromHash("")).toBeNull();
    expect(selectedConversationIdFromHash("#conversation/")).toBeNull();
    expect(selectedConversationIdFromHash("#foo")).toBeNull();
    expect(selectedConversationIdFromHash("#conversation/Bad ID!")).toBeNull();
  });
});

describe("P2 Workbench refresh surface (static)", () => {
  it("the sidebar distinguishes the selected row and renders the honest audience summary", async () => {
    const sidebar = await readFile(join(webSrc, "Sidebar.tsx"), "utf8");
    expect(sidebar).toContain("conversationAudienceSummary");
    expect(sidebar).toContain("selectedConversationIdFromHash");
    expect(sidebar).toContain('aria-current={selected ? "true" : undefined}');
    expect(sidebar).toContain('"sidebar-conversation-entry active"');
    expect(sidebar).not.toContain("`${conversation.audience.length} member");
  });

  it("the shell subtitle is contextual: selected conversation title, else the calm generic draft subtitle", async () => {
    const shell = await readFile(join(webSrc, "AppShell.tsx"), "utf8");
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    expect(shell).toContain("contextualTitle");
    expect(shell).toContain('{contextualTitle ?? "A calm workspace for your local-first agent team"}');
    expect(shell).toContain("onSelectionChange");
    expect(navigator).toContain("onSelectionChange");
  });

  it("the navigator refreshes list + selected manifest from existing gateway reads after create/message/lifecycle", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    // Message: the composer's onSent triggers an existing read of the selected
    // manifest plus the sidebar list reload; never an optimistic audience.
    expect(navigator).toContain("onSent={handleMessageSent}");
    expect(navigator).toContain("onConversationsChanged()");
    expect(navigator).toContain("fetchConversation(conversationId, token)");
    expect(navigator).not.toContain("setAudience");
    // Lifecycle success refreshes the list too (fresh re-gate truth).
    const lifecycleSection = navigator.slice(navigator.indexOf("async function handleLifecycleAction"), navigator.indexOf("const handleLifecycleEvent"));
    expect(lifecycleSection).toContain("onConversationsChanged()");
  });

  it("the composer exposes onSent for an accepted send with no other side effects", async () => {
    const composer = await readFile(join(webSrc, "ConversationComposer.tsx"), "utf8");
    expect(composer).toContain("onSent?: () => void");
    expect(composer).toContain("onSent?.()");
  });

  it("no polling, storage, new endpoints, or client id generation in the P2 web surface", async () => {
    for (const name of ["Sidebar.tsx", "AppShell.tsx", "ConversationNavigator.tsx", "ConversationComposer.tsx", "conversations.ts", "hash-route.ts"]) {
      const content = await readFile(join(webSrc, name), "utf8");
      for (const forbidden of ["localStorage", "sessionStorage", "setInterval", "new EventSource", "/api/conversations", "crypto.randomUUID", "Math.random"]) {
        // conversations.ts legitimately defines the /api/conversations parse
        // contract; api.ts (not scanned) is the only transport.
        if (name === "conversations.ts" && forbidden === "/api/conversations") continue;
        expect(content, `${name} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("the new generic id flows through the existing web parsers and deep-link route unchanged", async () => {
    const { parseConversationRecord } = await import("../web/src/conversations.js");
    const record = parseConversationRecord({
      id: "20260805T131530000Z-c-4fa21bc093de",
      title: "A title",
      status: "open",
      audience: ["dipu"],
      path: "collaboration/conversations/20260805T131530000Z-c-4fa21bc093de/index.md",
      createdBy: "steward",
      created: "2026-08-05T13:15:30.000Z",
      updated: "2026-08-05T13:15:30.000Z",
    });
    expect(record.id).toBe("20260805T131530000Z-c-4fa21bc093de");
    const { formatConversationHash, parseHashRoute } = await import("../web/src/hash-route.js");
    expect(parseHashRoute(formatConversationHash(record.id)).kind).toBe("conversation");
  });
});
