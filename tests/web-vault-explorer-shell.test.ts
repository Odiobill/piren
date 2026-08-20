// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AppShell } from "../web/src/AppShell.js";
import {
  fetchConversationAgents,
  fetchConversations,
  fetchVaultList,
  fetchVaultRead,
} from "../web/src/api.js";
import type { VaultListResponse, VaultReadResponse } from "../web/src/vault-explorer.js";

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchConversationAgents: vi.fn(),
    fetchConversations: vi.fn(),
    fetchVaultList: vi.fn(),
    fetchVaultRead: vi.fn(),
  };
});

// Capture the navigator props so the test can drive the selection signal.
let navigatorProps: Record<string, unknown> = {};
vi.mock("../web/src/ConversationNavigator.js", () => ({
  ConversationNavigator: (props: Record<string, unknown>) => {
    navigatorProps = props;
    return createElement("div", { className: "mock-navigator" });
  },
}));
vi.mock("../web/src/DashboardView.js", () => ({
  DashboardView: () => createElement("div", { className: "mock-dashboard" }),
}));

vi.mocked(fetchConversationAgents).mockResolvedValue({ agents: [] });
vi.mocked(fetchConversations).mockResolvedValue({ conversations: [] });

const LIST: VaultListResponse = {
  path: ".",
  entries: [{ name: "index.md", path: "index.md", type: "file", bytes: 8, mtimeMs: 1 }],
  capped: false,
};
const READ: VaultReadResponse = { path: "index.md", content: "# Hi", bytes: 6, mtimeMs: 1, capped: false };
vi.mocked(fetchVaultList).mockResolvedValue(LIST);
vi.mocked(fetchVaultRead).mockResolvedValue(READ);

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderShell(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(AppShell, {
        phase: "ready-local",
        token: "T",
        onValidated: vi.fn(),
        onUnauthorized: vi.fn(),
      }),
    );
  });
}

function toggleButton(): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  const found = buttons.find((b) => b.textContent?.trim() === "Vault Explorer");
  if (found === undefined) throw new Error("missing Vault Explorer toggle");
  return found;
}

function navigateToSelection(): void {
  const onSelectionChange = navigatorProps.onSelectionChange as (title: string | null, active: boolean) => void;
  act(() => onSelectionChange("A conversation", true));
}

beforeEach(() => {
  vi.clearAllMocks();
  navigatorProps = {};
  vi.mocked(fetchConversationAgents).mockResolvedValue({ agents: [] });
  vi.mocked(fetchConversations).mockResolvedValue({ conversations: [] });
  vi.mocked(fetchVaultList).mockResolvedValue(LIST);
  vi.mocked(fetchVaultRead).mockResolvedValue(READ);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

describe("AppShell Vault Explorer wiring (W2)", () => {
  it("adds one explicit toggle in the Conversation context, aria-pressed false by default", async () => {
    await renderShell();
    const toggle = toggleButton();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".split-workspace")).toBeNull();
  });

  it("no selected Conversation: opening shows the full-page Explorer; the chat stays mounted behind; close restores the view and returns focus", async () => {
    await renderShell();
    await flush();
    const toggle = toggleButton();
    toggle.focus();

    await act(async () => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    // Full-page module surface: no split/resizer, no focus theft.
    const fullpage = container.querySelector<HTMLElement>(".vault-explorer-fullpage");
    expect(fullpage).not.toBeNull();
    expect(fullpage?.hidden).toBe(false);
    expect(container.querySelector(".split-resizer-host")).toBeNull();
    expect(document.activeElement).toBe(toggle);
    // The conversations panel is hidden but the Conversation UI stays mounted;
    // the dashboard panel is also hidden while the full-page surface shows.
    const conversationsPanel = container.querySelector<HTMLElement>(".workspace-panel-conversations");
    expect(conversationsPanel?.hidden).toBe(true);
    expect(container.querySelector<HTMLElement>(".mock-dashboard")?.closest(".workspace-panel")?.getAttribute("hidden")).not.toBeNull();
    expect(container.querySelector(".mock-navigator")).not.toBeNull();
    // The explorer listed the bounded root through the existing route.
    expect(fetchVaultList).toHaveBeenCalledWith(".", "T", expect.anything());
    expect(container.textContent).toContain("index.md");

    // Close returns focus to the opener and restores the normal view.
    await act(async () => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(container.querySelector(".vault-explorer-fullpage")).toBeNull();
    // The default surface (dashboard) is visible again; the conversations
    // panel stays hidden because the conversations page is not selected.
    expect(container.querySelector<HTMLElement>(".mock-dashboard")?.closest(".workspace-panel")?.getAttribute("hidden")).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it("selected Conversation: opening shows the W1 split (upper Explorer, lower live chat)", async () => {
    await renderShell();
    await flush();
    navigateToSelection();
    await flush();
    const toggle = toggleButton();
    toggle.focus();
    await act(async () => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(container.querySelector(".vault-explorer-fullpage")).toBeNull();
    const split = container.querySelector<HTMLElement>(".split-workspace");
    expect(split).not.toBeNull();
    // Upper companion pane holds the Explorer; lower chat pane holds the live navigator.
    expect(split?.querySelector(".split-companion-pane .vault-explorer")).not.toBeNull();
    expect(split?.querySelector(".split-chat-pane .mock-navigator")).not.toBeNull();
    expect(fetchVaultList).toHaveBeenCalledWith(".", "T", expect.anything());
    // No focus theft on open.
    expect(document.activeElement).toBe(toggle);
  });

  it("mobile/portrait: opening selects the Explorer pane; the labelled toggle retains the chat mounted", async () => {
    const mql = {
      matches: true,
      media: "(max-width: 560px), (orientation: portrait)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: vi.fn().mockReturnValue(mql) });

    await renderShell();
    await flush();
    navigateToSelection();
    await flush();
    const toggle = toggleButton();
    toggle.focus();
    await act(async () => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    const pressed = Array.from(container.querySelectorAll<HTMLButtonElement>(".split-mobile-toggle button")).find(
      (b) => b.getAttribute("aria-pressed") === "true",
    );
    expect(pressed?.textContent?.trim()).toBe("Vault Explorer");
    // The chat stays mounted underneath (hidden, not unmounted).
    expect(container.querySelector(".split-chat-pane .mock-navigator")).not.toBeNull();
    expect(container.querySelector<HTMLElement>(".split-chat-pane")?.hidden).toBe(true);
  });
});
