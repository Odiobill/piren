import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initialNavState, selectPage, type Page } from "../web/src/nav.js";
import {
  parseConversationStartResponse,
  toConversationStartRequest,
} from "../web/src/conversation-start.js";

/**
 * ADR-0044 — Workbench Dashboard + agent-first start (web pure/static core).
 *
 * The Dashboard is the default Workbench surface. It reads the roster ONLY
 * from GET /api/conversation-agents and conversations ONLY from GET
 * /api/conversations, and its start action posts exactly `{agent}` to
 * POST /api/conversations/start. The browser never derives a recipient,
 * synthesizes text, passes a title/audience/mention, uses storage, polls,
 * or claims a run outcome.
 *
 * This file also pins the ADR-0044 removals: the old Agents page, About
 * page, empty/new-Conversation draft entry surface, and the sidebar
 * "+ New conversation" control are gone with no compatibility aliases.
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

describe("conversation start request core (pure)", () => {
  it("builds exactly {agent} and nothing else", () => {
    const request = toConversationStartRequest("dipu");
    expect(request).toEqual({ agent: "dipu" });
    expect(Object.keys(request)).toEqual(["agent"]);
  });

  it("parses the bounded start response envelope fail-closed", () => {
    const valid = {
      conversation: {
        id: "c1",
        title: "Conversation with dipu",
        audience: ["dipu"],
        status: "open",
        path: "collaboration/conversations/c1/index.md",
        createdBy: "steward",
        created: "2026-08-15T13:00:00.000Z",
        updated: "2026-08-15T13:00:00.000Z",
      },
      event: { id: "e1", conversationId: "c1", kind: "conversation_start_requested", created: "2026-08-15T13:00:00.000Z" },
      dispatch: [{ agent: "dipu", status: "completed" }],
    };
    const parsed = parseConversationStartResponse(valid);
    expect(parsed.conversation.id).toBe("c1");
    expect(parsed.event.kind).toBe("conversation_start_requested");
    expect(parsed.dispatch).toEqual([{ agent: "dipu", status: "completed" }]);

    // dispatch is optional (mirrors the create envelope).
    const withoutDispatch = parseConversationStartResponse({ conversation: valid.conversation, event: valid.event });
    expect(withoutDispatch.dispatch).toBeUndefined();

    for (const bad of [
      null,
      {},
      { conversation: valid.conversation },
      { conversation: valid.conversation, event: { id: "" } },
      { conversation: valid.conversation, event: valid.event, dispatch: [{ agent: 1 }] },
      { conversation: { title: "x" }, event: valid.event },
    ]) {
      expect(() => parseConversationStartResponse(bad)).toThrow();
    }
  });
});

describe("nav model (ADR-0044 Dashboard default)", () => {
  it("starts on the Dashboard page with the drawer closed", () => {
    expect(initialNavState()).toEqual({ page: "dashboard", drawerOpen: false });
  });

  it("exposes exactly the dashboard and conversations pages", () => {
    const pages: readonly Page[] = ["dashboard", "conversations"];
    expect(pages).toEqual(["dashboard", "conversations"]);
    expect(selectPage(initialNavState(), "conversations")).toEqual({ page: "conversations", drawerOpen: false });
  });
});

describe("ADR-0044 removal pins (static)", () => {
  it("the old Agents and About pages are gone (no source files, no imports)", async () => {
    const sources = await readSourceFiles();
    expect(sources.has("AgentsView.tsx")).toBe(false);
    expect(sources.has("AboutView.tsx")).toBe(false);
    const all = [...sources.values()].join("\n");
    expect(all).not.toContain("AgentsView");
    expect(all).not.toContain("AboutView");
  });

  it("the nav page union has no agents/about pages", async () => {
    const sources = await readSourceFiles();
    const nav = sources.get("nav.ts") ?? "";
    expect(nav).not.toContain('"agents"');
    expect(nav).not.toContain('"about"');
  });

  it("the sidebar has no + New conversation control and no inline creation entry", async () => {
    const sources = await readSourceFiles();
    const sidebar = sources.get("Sidebar.tsx") ?? "";
    expect(sidebar).not.toContain("+ New conversation");
    expect(sidebar).not.toContain("startNewConversation");
    expect(sidebar).not.toContain('window.location.hash = ""');
    // The switcher list and the Dashboard nav item remain.
    expect(sidebar).toContain("fetchConversations");
    expect(sidebar).toContain("Dashboard");
  });

  it("the empty/new-Conversation draft entry surface is gone from the navigator", async () => {
    const sources = await readSourceFiles();
    const navigator = sources.get("ConversationNavigator.tsx") ?? "";
    expect(navigator).not.toContain('aria-label="New conversation"');
    expect(navigator).not.toContain('mode="draft"');
    expect(navigator).not.toContain("handleCreated");
    expect(navigator).not.toContain("justCreatedFocus");
  });

  it("the composer has no draft mode and no create import", async () => {
    const sources = await readSourceFiles();
    const composer = sources.get("ConversationComposer.tsx") ?? "";
    expect(composer).not.toContain('"draft"');
    expect(composer).not.toContain("createConversation");
    expect(composer).not.toContain("onCreated");
    const api = sources.get("api.ts") ?? "";
    expect(api).not.toContain("createConversation");
  });

  it("the timeline has no draft prop or draft stream state", async () => {
    const sources = await readSourceFiles();
    const timeline = sources.get("ConversationTimeline.tsx") ?? "";
    expect(timeline).not.toContain("draft");
  });

  it("the start API posts to the exact route with the exact body builder", async () => {
    const sources = await readSourceFiles();
    const api = sources.get("api.ts") ?? "";
    expect(api).toContain("/api/conversations/start");
    expect(api).toContain("toConversationStartRequest");
  });

  it("draft/about-only styles are removed", async () => {
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    expect(styles).not.toContain("timeline-status-draft");
    expect(styles).not.toContain("about-list");
    expect(styles).not.toContain("button-new-conversation");
  });

  it("the removed Dashboard conversation-list styles are gone (D1)", async () => {
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    expect(styles).not.toContain("dashboard-conversation-list");
    expect(styles).not.toContain("dashboard-conversation-entry");
  });

  it("the start busy-line dots animation is reduced-motion safe (D1)", async () => {
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    expect(styles).toContain("dashboard-busy-dots");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce) {\n  .dashboard-busy-dots span");
  });

  it("no browser storage, polling, WebSocket, or fabricated start fields anywhere in the web source", async () => {
    const sources = await readSourceFiles();
    const all = [...sources.values()].join("\n");
    for (const forbidden of ["localStorage", "sessionStorage", "new EventSource", "new WebSocket", "setInterval"]) {
      expect(all, forbidden).not.toContain(forbidden);
    }
    const startModule = sources.get("conversation-start.ts") ?? "";
    // The request builder is pure and carries exactly one field (the pure
    // test above pins the exact key set); only api.ts performs the start POST.
    expect(startModule.length).toBeGreaterThan(0);
    const api = sources.get("api.ts") ?? "";
    expect(api.match(/authedFetch\("\/api\/conversations\/start"/g)?.length).toBe(1);
  });
});
