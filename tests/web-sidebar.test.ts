// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("Sidebar conversation list created timestamp", () => {
  let container: HTMLDivElement;
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
      const time = entry.querySelector<HTMLElement>("time.sidebar-conversation-created");
      expect(time).not.toBeNull();
      // Machine-readable value is present and the localized text is non-empty.
      expect(time?.getAttribute("dateTime")?.length ?? 0).toBeGreaterThan(0);
      expect((time?.textContent?.length ?? 0)).toBeGreaterThan(0);
      // The timestamp renders ABOVE the title (the first child of the entry).
      expect(entry.firstElementChild?.classList.contains("sidebar-conversation-created")).toBe(true);
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
