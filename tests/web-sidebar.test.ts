// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Sidebar } from "../web/src/Sidebar.js";
import { formatConversationCreatedTimestamp } from "../web/src/conversations.js";
import { fetchConversations } from "../web/src/api.js";
import type { ConversationRecord } from "../web/src/conversations.js";

/**
 * Workbench sidebar origin-fact slice: the durable `created` timestamp
 * renders ABOVE each conversation title as an accessible local date/time with
 * a machine-readable `dateTime` value. Lead choice: created, not updated —
 * a stable origin fact, never an activity cue. No new fetch, polling, state,
 * URL, or persistence; malformed/unavailable time fails quiet (no fabricated
 * date).
 */

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchConversations: vi.fn(),
  };
});

function conversation(overrides: Partial<ConversationRecord>): ConversationRecord {
  return {
    id: "c1",
    path: "collaboration/conversations/c1/index.md",
    title: "Conversation with dipu",
    createdBy: "steward",
    audience: ["dipu"],
    status: "open",
    created: "2026-08-15T13:00:00.000Z",
    updated: "2026-08-15T13:00:00.000Z",
    ...overrides,
  };
}

describe("formatConversationCreatedTimestamp (pure)", () => {
  it("returns a localized text plus machine-readable dateTime for a valid created value", () => {
    const result = formatConversationCreatedTimestamp("2026-08-15T13:00:00.000Z");
    expect(result).not.toBeNull();
    expect(result?.dateTime).toBe("2026-08-15T13:00:00.000Z");
    expect((result?.text.length ?? 0)).toBeGreaterThan(0);
  });

  it("returns null for malformed values so the sidebar fails quiet (never a fabricated date)", () => {
    expect(formatConversationCreatedTimestamp("not-a-date")).toBeNull();
    expect(formatConversationCreatedTimestamp("")).toBeNull();
    expect(formatConversationCreatedTimestamp("2026-13-45T99:99:99.000Z")).toBeNull();
  });
});

describe("Sidebar conversation list created timestamp", () => {  let container: HTMLDivElement;
  let root: Root;

  function renderSidebar(): void {
    root = createRoot(container);
    act(() => {
      root.render(
        createElement(Sidebar, {
          page: "conversations",
          token: "test-token",
          onSelect: () => {},
          onValidated: () => {},
          onUnauthorized: () => {},
          conversationsReloadKey: 0,
          explorerOpen: false,
          onToggleExplorer: () => {},
          onOpenExplorerFullPage: () => {},
          explorerToggleRef: { current: null },
        }),
      );
    });
  }

  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.mocked(fetchConversations).mockReset();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
  });

  it("renders the durable created timestamp above each conversation title with a machine-readable value", async () => {
    vi.mocked(fetchConversations).mockResolvedValue({
      conversations: [
        conversation({ id: "c1", title: "Conversation with dipu", created: "2026-08-15T13:00:00.000Z" }),
        conversation({ id: "c2", title: "Conversation with kimi", created: "2026-08-16T09:30:00.000Z" }),
      ],
    });
    renderSidebar();
    await flush();

    const entries = container.querySelectorAll<HTMLButtonElement>(".sidebar-conversation-entry");
    expect(entries.length).toBe(2);
    for (const entry of entries) {
      // WUX-C — the decorative message glyph and the durable created date
      // share ONE compact meta line above the title.
      const meta = entry.querySelector<HTMLElement>("span.sidebar-conversation-meta");
      expect(meta).not.toBeNull();
      // The decorative icon is inside the same compact meta line.
      expect(meta?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
      const time = meta?.querySelector<HTMLElement>("time.sidebar-conversation-created");
      expect(time).not.toBeNull();
      // Machine-readable value is present and the localized text is non-empty.
      expect(time?.getAttribute("dateTime")?.length ?? 0).toBeGreaterThan(0);
      expect((time?.textContent?.length ?? 0)).toBeGreaterThan(0);
      // The meta line renders FIRST (above the title span), then the title,
      // then the audience summary.
      const children = Array.from(entry.children);
      expect(children.findIndex((c) => c.classList.contains("sidebar-conversation-meta"))).toBe(0);
      expect(children.findIndex((c) => c.classList.contains("sidebar-conversation-title"))).toBeGreaterThan(0);
      // Title and audience summary remain intact.
      expect(entry.textContent).toContain("Conversation");
      expect(entry.textContent).toContain("Dipu");
    }
    expect(entries[0]?.querySelector("time")?.getAttribute("dateTime")).toBe("2026-08-15T13:00:00.000Z");
  });

  it("fails quiet for a malformed created value (no time element, no fabricated date, title kept)", async () => {
    vi.mocked(fetchConversations).mockResolvedValue({
      conversations: [conversation({ id: "c1", title: "Conversation with dipu", created: "not-a-date" })],
    });
    renderSidebar();
    await flush();

    const entry = container.querySelector<HTMLButtonElement>(".sidebar-conversation-entry");
    expect(entry).not.toBeNull();
    expect(entry?.querySelector("time.sidebar-conversation-created")).toBeNull();
    // The entry still renders its title truthfully.
    expect(entry?.textContent).toContain("Conversation with dipu");
  });
});

describe("Sidebar WUX-A: icons, exclusive active state, and 80/20 Explorer row", () => {
  let container: HTMLDivElement;
  let root: Root;

  function renderSidebar(overrides: { page?: "dashboard" | "settings" | "conversations"; explorerOpen?: boolean; explorerFullPage?: boolean } = {}): void {
    root = createRoot(container);
    act(() => {
      root.render(
        createElement(Sidebar, {
          page: overrides.page ?? "dashboard",
          token: "test-token",
          onSelect: () => {},
          onValidated: () => {},
          onUnauthorized: () => {},
          conversationsReloadKey: 0,
          explorerOpen: overrides.explorerOpen ?? false,
          onToggleExplorer: () => {},
          onOpenExplorerFullPage: () => {},
          ...(overrides.explorerFullPage !== undefined ? { explorerFullPage: overrides.explorerFullPage } : {}),
        }),
      );
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.mocked(fetchConversations).mockReset();
    vi.mocked(fetchConversations).mockResolvedValue({ conversations: [] });
  });

  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
  });

  it("decorates the Dashboard and Settings navigation labels with icons", async () => {
    renderSidebar();
    const dashboard = container.querySelector<HTMLButtonElement>('.sidebar-pages .nav-item');
    expect(dashboard?.textContent).toContain("Dashboard");
    expect(dashboard?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    const items = container.querySelectorAll(".sidebar-pages .nav-item");
    expect(items.length).toBe(2);
    for (const item of items) {
      expect(item.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    }
  });

  it("keeps the full-page Explorer as the SOLE highlighted module (no Dashboard/Settings highlight alongside it)", async () => {
    renderSidebar({ page: "dashboard", explorerOpen: true, explorerFullPage: true });
    await flush();
    for (const item of Array.from(container.querySelectorAll(".sidebar-pages .nav-item"))) {
      expect(item.classList.contains("active")).toBe(false);
      expect(item.getAttribute("aria-current")).toBeNull();
    }
    // The open companion remains visibly highlighted.
    const toggle = container.querySelector<HTMLButtonElement>(".sidebar-companion-row .nav-item");
    expect(toggle?.classList.contains("active")).toBe(true);
  });

  it("restores the underlying page highlight when the full-page Explorer closes", async () => {
    renderSidebar({ page: "settings", explorerOpen: false, explorerFullPage: false });
    await flush();
    const settings = Array.from(container.querySelectorAll(".sidebar-pages .nav-item"))[1] as HTMLButtonElement;
    expect(settings.textContent).toContain("Settings");
    expect(settings.classList.contains("active")).toBe(true);
    expect(settings.getAttribute("aria-current")).toBe("page");
  });

  it("pins the WUX-C compact icon+date meta line and labeled-nav icon/text gap in CSS", async () => {
    renderSidebar({ page: "dashboard" });
    await flush();
    const css = await readFile(join(process.cwd(), "web", "src", "styles.css"), "utf8");
    // The conversation meta line is one compact inline-flex row.
    const metaBlock = css.slice(css.indexOf(".sidebar-conversation-meta"));
    expect(css).toContain(".sidebar-conversation-meta");
    expect(metaBlock).toMatch(/display:\s*inline-flex/s);
    expect(metaBlock).toMatch(/align-items:\s*center/s);
    // Labeled nav items keep their WUX-A icons with a small consistent gap.
    const navItemStart = css.indexOf(".nav-item {");
    expect(navItemStart).toBeGreaterThanOrEqual(0);
    const navItemBlock = css.slice(navItemStart, css.indexOf("}", navItemStart));
    expect(navItemBlock).toMatch(/display:\s*inline-flex/s);
    expect(navItemBlock).toMatch(/align-items:\s*center/s);
    expect(navItemBlock).toMatch(/gap:\s*8px/s);
  });

  it("grows the Explorer name control to about 80% and the full-page action to about 20% of the row", async () => {
    renderSidebar();
    await flush();
    const css = await readFile(join(process.cwd(), "web", "src", "styles.css"), "utf8");
    const rowBlock = css.slice(css.indexOf(".sidebar-companion-row .nav-item"));
    expect(rowBlock).toMatch(/\.sidebar-companion-row \.nav-item \{[^}]*flex:\s*4\b/s);
    const fullBlock = css.slice(css.indexOf(".sidebar-companion-row .sidebar-companion-fullpage"));
    expect(fullBlock).toMatch(/\.sidebar-companion-row \.sidebar-companion-fullpage \{[^}]*flex:\s*1\b/s);
  });
});
