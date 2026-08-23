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

  it("normal Settings navigation closes a no-selection full-page Explorer so the Settings page is reachable", async () => {
    await renderShell();
    await flush();
    const explorerToggle = toggleButton();
    await act(async () => explorerToggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(container.querySelector(".vault-explorer-fullpage")).not.toBeNull();

    const settingsButton = Array.from(container.querySelectorAll<HTMLButtonElement>(".sidebar-desktop button"))
      .find((button) => button.textContent?.trim() === "Settings");
    expect(settingsButton).toBeDefined();
    await act(async () => settingsButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(container.querySelector(".vault-explorer-fullpage")).toBeNull();
    expect(container.querySelector(".settings-page h2")?.textContent).toBe("Settings");
  });

  it("returns mobile-drawer Explorer focus to the persistent menu toggle when the drawer unmounts", async () => {
    await renderShell();
    await flush();
    const menuToggle = container.querySelector<HTMLButtonElement>(".nav-toggle");
    expect(menuToggle).not.toBeNull();

    await act(async () => menuToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const drawerToggle = Array.from(container.querySelectorAll<HTMLButtonElement>("#mobile-drawer button"))
      .find((button) => button.textContent?.trim() === "Vault Explorer");
    expect(drawerToggle).toBeDefined();
    drawerToggle?.focus();

    await act(async () => drawerToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(container.querySelector("#mobile-drawer")).toBeNull();
    expect(container.querySelector(".vault-explorer-fullpage")).not.toBeNull();
    expect(document.activeElement).toBe(menuToggle);
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
    expect(split?.closest<HTMLElement>(".workspace-panel")?.hidden).toBe(false);
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

describe("AppShell Vault Explorer full-page action (V1)", () => {
  beforeEach(() => {
    window.location.hash = "";
  });

  function fullPageActionButton(scope: ParentNode = container): HTMLButtonElement {
    const found = scope.querySelector<HTMLButtonElement>(
      'button[aria-label="Open Vault Explorer full page"]',
    );
    if (found === null) throw new Error("missing Open Vault Explorer full page action");
    return found;
  }

  async function click(element: HTMLButtonElement): Promise<void> {
    await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  }

  it("adds a distinct sibling action beside the Explorer toggle (never nested inside it)", async () => {
    await renderShell();
    await flush();
    const toggle = toggleButton();
    const action = fullPageActionButton();
    // Siblings in the same row; the action is NOT a descendant of the toggle.
    expect(action.closest("li")).toBe(toggle.closest("li"));
    expect(toggle.contains(action)).toBe(false);
    expect(action.getAttribute("aria-label")).toBe("Open Vault Explorer full page");
  });

  it("desktop action does not steal focus and makes no unnecessary hash write with no selection", async () => {
    await renderShell();
    await flush();
    const historyLength = window.history.length;
    const action = fullPageActionButton();
    action.focus();
    await click(action);
    await flush();
    expect(container.querySelector(".vault-explorer-fullpage")).not.toBeNull();
    // No-selection: no hash write at all.
    expect(window.history.length).toBe(historyLength);
    // Desktop: no programmatic focus move away from the invoked control.
    expect(document.activeElement).toBe(action);
  });

  it("selected Conversation: the action writes the existing no-selection hash route once; the mounted navigator's ordinary signal yields the full-page fallback; no lifecycle change", async () => {
    await renderShell();
    await flush();
    navigateToSelection();
    await flush();
    // A selected conversation hash like the sidebar writes.
    await act(async () => {
      window.location.hash = "#conversation/abc-1";
    });
    await flush();
    const fetchCallsBefore = vi.mocked(fetchConversations).mock.calls.length;
    const historyLength = window.history.length;

    await click(fullPageActionButton());
    await flush();

    // Exactly the one explicit no-selection hash write.
    expect(window.location.hash).toBe("");
    expect(window.history.length).toBe(historyLength + 1);
    // The still-mounted navigator remains the selection authority: only its
    // ordinary no-selection signal produces the full-page fallback.
    const onSelectionChange = navigatorProps.onSelectionChange as (title: string | null, active: boolean) => void;
    await act(async () => onSelectionChange(null, false));
    await flush();
    expect(container.querySelector(".vault-explorer-fullpage")).not.toBeNull();
    // The Explorer stays open through the transition.
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    // No lifecycle side effects: no conversation-list refresh, no extra reads.
    expect(vi.mocked(fetchConversations).mock.calls.length).toBe(fetchCallsBefore);
    // Truthful shell subtitle reset by the navigator's own signal.
    expect(container.querySelector(".shell-subtitle")?.textContent).toBe("A calm workspace for your local-first agent team");
  });

  it("from the mobile drawer, the action closes the drawer and returns focus to the persistent Menu control", async () => {
    await renderShell();
    await flush();
    const menuToggle = container.querySelector<HTMLButtonElement>(".nav-toggle");
    await act(async () => menuToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const drawerAction = fullPageActionButton(container.querySelector("#mobile-drawer") ?? container);
    drawerAction.focus();
    await click(drawerAction);
    await flush();
    expect(container.querySelector("#mobile-drawer")).toBeNull();
    expect(container.querySelector(".vault-explorer-fullpage")).not.toBeNull();
    expect(document.activeElement).toBe(menuToggle);
  });
});

describe("Vault Explorer split pane scroll repair (V1 static pins)", () => {
  it("the split companion pane is a non-scrolling layout host with no inset padding; Explorer regions stay the sole scroll owners", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const styles = await readFile(join(process.cwd(), "web", "src", "styles.css"), "utf8");
    const start = styles.indexOf(".split-companion-pane {");
    expect(start).toBeGreaterThan(-1);
    const rule = styles.slice(start, styles.indexOf("}", start));
    // Non-scrolling host: no own vertical scroll region.
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).not.toMatch(/overflow-y:\s*(auto|scroll)/);
    // No inset padding: the inner scrollbar reaches the pane right edge.
    expect(rule).not.toMatch(/padding:/);
    // The Explorer entries/document regions remain the sole scroll owners.
    for (const owner of [".vault-explorer-entries {", ".vault-explorer-document {"]) {
      const ownerStart = styles.indexOf(owner);
      const ownerRule = styles.slice(ownerStart, styles.indexOf("}", ownerStart));
      expect(ownerRule).toMatch(/overflow-y:\s*auto/);
    }
  });
});

describe("AppShell Vault Explorer continuity across presentations (WUX-B)", () => {
  it("a nested directory and open document survive split-to-full-page transitions without resetting to the root", async () => {
    // Root listing offers one directory; that directory offers one document.
    vi.mocked(fetchVaultList).mockImplementation(async (path: string) => {
      if (path === "team") {
        return {
          path: "team",
          entries: [{ name: "notes.md", path: "team/notes.md", type: "file", bytes: 9, mtimeMs: 4 }],
          capped: false,
        };
      }
      return {
        path: ".",
        entries: [{ name: "team", path: "team", type: "directory", mtimeMs: 5 }],
        capped: false,
      };
    });
    vi.mocked(fetchVaultRead).mockResolvedValue({ ...READ, path: "team/notes.md" });

    await renderShell();
    await flush();

    // Full-page presentation: navigate into team, then open notes.md.
    await act(async () => toggleButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    const dirEntry = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.getAttribute("aria-label") === "Open directory team",
    );
    expect(dirEntry).toBeDefined();
    await act(async () => dirEntry?.click());
    await flush();
    const docEntry = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.getAttribute("aria-label") === "Read file notes.md",
    );
    expect(docEntry).toBeDefined();
    await act(async () => docEntry?.click());
    await flush();
    expect(container.querySelector('[aria-label="Document: notes.md"]')).not.toBeNull();
    expect(container.textContent).toContain("Hi");

    // Switch to a selected Conversation: the Explorer re-presents as the W1
    // split. A fresh bounded reread of the SAME location is allowed; the
    // root must NOT replace the retained directory/document.
    const listCallsBefore = vi.mocked(fetchVaultList).mock.calls.length;
    navigateToSelection();
    await flush();
    const calls = vi.mocked(fetchVaultList).mock.calls.slice(listCallsBefore);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const call of calls) {
      expect(call[0]).toBe("team");
    }
    expect(vi.mocked(fetchVaultRead)).toHaveBeenCalledWith("team/notes.md", "T", expect.anything());
    // The document is visible in the split companion pane.
    const companion = container.querySelector<HTMLElement>(".split-companion-pane");
    expect(companion?.textContent).toContain("notes.md");
  });
});

describe("WUX-B full-page Explorer single scroll owner", () => {
  it("the shell marks the full-page Explorer presentation and stops being an inset scrolling host", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const appShellSource = await readFile(join(process.cwd(), "web", "src", "AppShell.tsx"), "utf8");
    expect(appShellSource).toContain("shell-explorer-fullpage");

    const css = await readFile(join(process.cwd(), "web", "src", "styles.css"), "utf8");
    const block = css.slice(css.indexOf(".shell.shell-explorer-fullpage .shell-main"));
    expect(block.startsWith(".shell.shell-explorer-fullpage .shell-main")).toBe(true);
    expect(block.slice(0, block.indexOf("}"))).toMatch(/overflow:\s*hidden/);
    expect(block.slice(0, block.indexOf("}"))).toMatch(/padding:\s*0/);
  });

  it("applies the full-page presentation class only while the no-selection Explorer is open", async () => {
    await renderShell();
    await flush();
    expect(container.querySelector(".shell")?.className).not.toContain("shell-explorer-fullpage");

    await act(async () => toggleButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(container.querySelector(".shell")?.className).toContain("shell-explorer-fullpage");

    // Closing restores the normal presentation class state.
    await act(async () => toggleButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(container.querySelector(".shell")?.className).not.toContain("shell-explorer-fullpage");
  });
});
