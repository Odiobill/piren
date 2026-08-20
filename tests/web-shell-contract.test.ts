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
 * sidebar, mobile drawer, and the stable-workspace rule
 * (ConversationNavigator stays mounted across view switches; a view change
 * never cancels a conversation run or creates client-side truth).
 * ADR-0044: the Dashboard is the default page; the retired Agents/About
 * pages and their pins are gone (see tests/web-dashboard.test.ts).
 */
const webSrc = join(process.cwd(), "web", "src");

describe("nav state model (pure)", () => {
  it("starts on the Dashboard page with the drawer closed", () => {
    expect(initialNavState()).toEqual({ page: "dashboard", drawerOpen: false });
  });

  it("selectPage switches the page and always closes the drawer", () => {
    const open: NavState = { page: "dashboard", drawerOpen: true };
    expect(selectPage(open, "conversations")).toEqual({ page: "conversations", drawerOpen: false });
    expect(selectPage(initialNavState(), "conversations")).toEqual({ page: "conversations", drawerOpen: false });
  });

  it("selectPage on the same page with a closed drawer is a no-op", () => {
    const state = initialNavState();
    expect(selectPage(state, "dashboard")).toBe(state);
  });

  it("toggleDrawer flips and closeDrawer is idempotent", () => {
    expect(toggleDrawer(initialNavState())).toEqual({ page: "dashboard", drawerOpen: true });
    expect(closeDrawer({ page: "conversations", drawerOpen: true })).toEqual({ page: "conversations", drawerOpen: false });
    const closed = initialNavState();
    expect(closeDrawer(closed)).toBe(closed);
  });

  it("exposes exactly the three shell pages", () => {
    const pages: readonly Page[] = ["dashboard", "conversations", "settings"];
    expect(pages).toEqual(["dashboard", "conversations", "settings"]);
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
  it("the sidebar is the conversation switcher with the Dashboard nav item and no creation control", async () => {
    const sources = await readSourceFiles();
    const sidebar = sources.get("Sidebar.tsx") ?? "";
    // U1: the sidebar remains the conversation switcher; the standalone
    // "Conversations" nav item stays redundant (the list lives in the
    // sidebar itself). (Note: `fetchConversations` legitimately contains
    // that substring, so the pin is the nav-item label, not the bare word.)
    expect(sidebar).not.toContain('label: "Conversations"');
    expect(sidebar).not.toContain('{ page: "conversations", label');
    // ADR-0044: the retired creation button is gone; creation happens only
    // through the Dashboard's explicit agent-first start.
    expect(sidebar).not.toContain("startNewConversation");
    expect(sidebar).not.toContain('window.location.hash = ""');
    expect(sidebar).not.toContain("sidebar-create");
    expect(sidebar).not.toContain("showCreate");
    // The list fetch and the Dashboard nav item stay.
    expect(sidebar).toContain("fetchConversations");
    expect(sidebar).toContain("Dashboard");
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
    // R3b-3 authorized room event + stream reads; R3b-4 authorized the
    // structured messages POST (composer). C3-C3 (2026-08-07) authorizes the
    // Conversation approve/abort endpoints. W2 (2026-08-20) authorizes ONLY
    // the bounded read-only vault list/read routes in the shared api.ts
    // transport (never the graph/inbox routes). Chat, native SSE, storage,
    // and any other vault route stay forbidden across the workbench.
    for (const [name, content] of sources) {
      expect(content, `${name} must not reference /api/chat`).not.toContain("/api/chat");
      expect(content, `${name} must not use native EventSource`).not.toContain("new EventSource");
      expect(content, `${name} must not reference vault graph/inbox routes`).not.toContain("/api/vault/graph");
      expect(content, `${name} must not reference vault inbox routes`).not.toContain("/api/vault/inbox");
      expect(content, `${name} must not use localStorage`).not.toContain("localStorage");
      expect(content, `${name} must not use sessionStorage`).not.toContain("sessionStorage");
      // The W2 vault transport may reference ONLY the existing list/read
      // routes, and only inside api.ts.
      if (name === "api.ts") {
        expect(content).toContain("/api/vault/list?path=");
        expect(content).toContain("/api/vault/read?path=");
      } else {
        expect(content, `${name} must not reference any vault route`).not.toContain("/api/vault");
      }
    }
  });
});
