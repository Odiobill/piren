import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  closeDrawer,
  initialNavState,
  selectPage,
  shouldRestoreFocusAfterSelect,
  toggleDrawer,
  type NavState,
  type Page,
} from "../web/src/nav.js";

/**
 * ADR-0041 R3b-2.5: responsive workbench app shell contract.
 * Pure nav-state transitions plus static a11y/behavior guards for the
 * sidebar, mobile drawer, read-only About page, and the stable-workspace
 * rule (ConversationNavigator stays mounted across view switches; a view
 * change never cancels a conversation run or creates client-side truth).
 */
const webSrc = join(process.cwd(), "web", "src");

describe("nav state model (pure)", () => {
  it("starts on the Conversations page with the drawer closed", () => {
    expect(initialNavState()).toEqual({ page: "conversations", drawerOpen: false });
  });

  it("selectPage switches the page and always closes the drawer", () => {
    const open: NavState = { page: "conversations", drawerOpen: true };
    expect(selectPage(open, "about")).toEqual({ page: "about", drawerOpen: false });
    expect(selectPage(initialNavState(), "agents")).toEqual({ page: "agents", drawerOpen: false });
  });

  it("selectPage on the same page with a closed drawer is a no-op", () => {
    const state = initialNavState();
    expect(selectPage(state, "conversations")).toBe(state);
  });

  it("toggleDrawer flips and closeDrawer is idempotent", () => {
    expect(toggleDrawer(initialNavState())).toEqual({ page: "conversations", drawerOpen: true });
    expect(closeDrawer({ page: "agents", drawerOpen: true })).toEqual({ page: "agents", drawerOpen: false });
    const closed = initialNavState();
    expect(closeDrawer(closed)).toBe(closed);
  });

  it("exposes exactly the three shell pages", () => {
    const pages: readonly Page[] = ["conversations", "agents", "about"];
    expect(pages).toEqual(["conversations", "agents", "about"]);
  });

  it("a nav selection must restore toggle focus exactly when the drawer was open", () => {
    expect(shouldRestoreFocusAfterSelect({ page: "conversations", drawerOpen: true })).toBe(true);
    expect(shouldRestoreFocusAfterSelect(initialNavState())).toBe(false);
  });
});

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

describe("app shell source surface (static)", () => {
  it("the sidebar is the conversation switcher with no redundant Conversations nav link and no inline create form", async () => {
    const sources = await readSourceFiles();
    const sidebar = sources.get("Sidebar.tsx") ?? "";
    // U1: the sidebar remains the conversation switcher and creation entry
    // point, but the standalone "Conversations" nav item is redundant (the
    // conversation list lives in the sidebar itself) and must be removed.
    // (Note: `fetchConversations` legitimately contains that substring, so
    // the pin is the nav-item label, not the bare word.)
    expect(sidebar).not.toContain('label: "Conversations"');
    expect(sidebar).not.toContain('{ page: "conversations", label');
    // Creation entry remains, but it opens the main-window draft template
    // (home hash) instead of an inline first-message form in the sidebar.
    expect(sidebar).toContain("+ New conversation");
    expect(sidebar).toContain('window.location.hash = ""');
    expect(sidebar).not.toContain("sidebar-create");
    expect(sidebar).not.toContain("showCreate");
    // The list fetch and the two remaining pages stay.
    expect(sidebar).toContain("fetchConversations");
    expect(sidebar).toContain("Agents");
    expect(sidebar).toContain("About");
    expect(sidebar).toContain("aria-current");
  });

  it("removes routine gateway-reachability chrome and obsolete work-in-progress copy", async () => {
    const sources = await readSourceFiles();
    const shell = sources.get("AppShell.tsx") ?? "";
    const badge = sources.get("StatusBadge.tsx") ?? "";
    expect(shell).not.toContain("Gateway reachable");
    expect(shell).not.toContain("Coming next");
    expect(badge).not.toContain("Gateway reachable");
  });

  it("keeps desktop application chrome fixed while the selected conversation scrolls independently", async () => {
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    expect(styles).toMatch(/\.shell\s*\{[\s\S]*height:\s*100dvh/);
    expect(styles).toMatch(/\.shell-header\s*\{[\s\S]*flex:\s*none/);
    expect(styles).toMatch(/\.sidebar-desktop\s*\{[\s\S]*overflow-y:\s*auto/);
    expect(styles).toMatch(/\.shell-main\s*\{[\s\S]*overflow-y:\s*auto/);
    // U1: a selected conversation fills the full workspace height inside the
    // shell-main dedicated scroll area.
    expect(styles).toMatch(/\.workspace-panel\s*\{[\s\S]*min-height:\s*100%/);
  });

  it("the mobile drawer is labelled, aria-expanded, and closes on Escape with focus return", async () => {
    const sources = await readSourceFiles();
    const drawer = [...sources.values()].join("\n");
    expect(drawer).toContain("aria-expanded");
    expect(drawer).toContain("Escape");
    expect(drawer).toContain("Tab");
  });

  it("the narrow-layout menu toggle is an accessible three-line hamburger icon, not bare text", async () => {
    const sources = await readSourceFiles();
    const shell = sources.get("AppShell.tsx") ?? "";
    // U1: the textual "Menu" becomes a classic three-line hamburger; the
    // accessible name is preserved via a screen-reader-only label.
    expect(shell).toContain("hamburger");
    expect(shell).toContain('className="sr-only">Menu<');
    expect(shell).not.toMatch(/nav-toggle[^>]*>\s*Menu\s*<\/button>/);
    // The aria contract on the toggle is preserved.
    expect(shell).toContain("aria-expanded");
    expect(shell).toContain('aria-controls="mobile-drawer"');
  });

  it("About is read-only: no form controls and no configuration wording", async () => {
    const sources = await readSourceFiles();
    const about = sources.get("AboutView.tsx") ?? "";
    expect(about.length).toBeGreaterThan(0);
    expect(about).not.toMatch(/<input|<select|<textarea|<form/);
    expect(about).not.toMatch(/thinking|provider|secret|package/);
    expect(about).toContain("not shown or edited");
  });

  it("About never claims token readiness is validated before a successful protected request", async () => {
    const sources = await readSourceFiles();
    const about = sources.get("AboutView.tsx") ?? "";
    // The token-ready status must use explicit future/non-validation wording.
    expect(about).toContain("not yet validated");
    // The ambiguous already-validated phrasing is forbidden.
    expect(about).not.toContain("validated by your first");
  });

  it("the Agents page renders the roster non-interactively with a chat-unavailable note", async () => {
    const sources = await readSourceFiles();
    const agents = sources.get("AgentsView.tsx") ?? "";
    expect(agents.length).toBeGreaterThan(0);
    expect(agents).toContain("/api/conversation-agents");
    expect(agents).toContain("not available");
    expect(agents).not.toMatch(/onClick|onSubmit|<button/);
  });

  it("ConversationNavigator stays mounted across view switches (stable workspace)", async () => {
    const sources = await readSourceFiles();
    const shell = sources.get("AppShell.tsx") ?? "";
    expect(shell).toContain("ConversationNavigator");
    expect(shell).toContain("hidden");
  });

  it("drawer nav selection restores focus to the menu toggle via the pure decision", async () => {
    const sources = await readSourceFiles();
    const shell = sources.get("AppShell.tsx") ?? "";
    expect(shell).toContain("shouldRestoreFocusAfterSelect");
    expect(shell).toContain("toggleRef.current?.focus()");
  });

  it("the drawer container is programmatically focusable and the Tab trap covers drawer focus", async () => {
    const sources = await readSourceFiles();
    const drawer = sources.get("MobileDrawer.tsx") ?? "";
    expect(drawer).toContain("tabIndex={-1}");
    expect(drawer).toContain("active === drawer");
  });

  it("the menu toggle's aria-controls targets a real drawer id", async () => {
    const sources = await readSourceFiles();
    const shell = sources.get("AppShell.tsx") ?? "";
    const drawer = sources.get("MobileDrawer.tsx") ?? "";
    // The toggle declares aria-controls="mobile-drawer"; the drawer region
    // itself must carry the matching stable id (not the backdrop).
    expect(shell).toContain('aria-controls="mobile-drawer"');
    expect(drawer).toContain('id="mobile-drawer"');
  });

  it("the shell never calls chat endpoints, uses no storage, and has no writes", async () => {
    const sources = await readSourceFiles();
    const shell = [...sources.values()].join("\n");
    // R3b-3 authorized room event + stream reads; R3b-4 authorized the
    // structured messages POST (composer). C3-C3 (2026-08-07) authorizes the
    // Conversation approve/abort endpoints. Chat, vault, native SSE, and
    // storage stay forbidden across the whole workbench.
    for (const forbidden of ["/api/chat", "new EventSource", "/api/vault", "localStorage", "sessionStorage"]) {
      expect(shell, `${forbidden} must not appear in the shell surface`).not.toContain(forbidden);
    }
  });
});
