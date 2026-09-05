// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AppShell } from "../web/src/AppShell.js";
import {
  fetchConversationAgents,
  fetchConversations,
  fetchStewardAlerts,
  fetchVaultList,
  fetchVaultRead,
} from "../web/src/api.js";

/**
 * 0.2.5 correction S3 — the Steward Alerts sidebar row gains the same
 * distinct sibling "expand to full page" affordance the Vault Explorer
 * already has. The shell already renders the no-selection full-page Alerts
 * surface; this slice adds and wires the missing action. It reuses the
 * V1 Explorer full-page semantics exactly: no unnecessary hash write with
 * no selected Conversation, the existing no-selection hash route with one,
 * the still-mounted navigator's ordinary signal yields the fallback,
 * mutual exclusion with the Explorer, and mobile drawer focus return.
 */

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchConversationAgents: vi.fn(),
    fetchConversations: vi.fn(),
    fetchVaultList: vi.fn(),
    fetchVaultRead: vi.fn(),
    fetchStewardAlerts: vi.fn(),
  };
});

// Capture the navigator props so the test can drive the selection signal.
let navigatorProps: Record<string, unknown> = {};

function NavigatorProbe(): ReactElement {
  const [probe, setProbe] = useState("unset");
  return createElement(
    "div",
    { className: "mock-navigator", "data-probe": probe },
    createElement(
      "button",
      { type: "button", className: "probe-mark", onClick: () => setProbe("sampled") },
      "probe-mark",
    ),
  );
}

vi.mock("../web/src/ConversationNavigator.js", () => ({
  ConversationNavigator: (props: Record<string, unknown>) => {
    navigatorProps = props;
    return createElement(NavigatorProbe);
  },
}));
vi.mock("../web/src/DashboardView.js", () => ({
  DashboardView: () => createElement("div", { className: "mock-dashboard" }),
}));
vi.mock("../web/src/StewardAlerts.js", () => ({
  StewardAlerts: () => createElement("div", { className: "mock-steward-alerts" }),
}));
vi.mock("../web/src/StewardAlertBadge.js", () => ({
  StewardAlertBadge: () => null,
}));

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

function alertsToggleButton(): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  const found = buttons.find((b) => b.textContent?.trim() === "Steward Alerts");
  if (found === undefined) throw new Error("missing Steward Alerts toggle");
  return found;
}

function alertsFullPageAction(scope: ParentNode = container): HTMLButtonElement {
  const found = scope.querySelector<HTMLButtonElement>(
    'button[aria-label="Open Steward Alerts full page"]',
  );
  if (found === null) throw new Error("missing Open Steward Alerts full page action");
  return found;
}

function explorerFullPageAction(scope: ParentNode = container): HTMLButtonElement {
  const found = scope.querySelector<HTMLButtonElement>(
    'button[aria-label="Open Vault Explorer full page"]',
  );
  if (found === null) throw new Error("missing Open Vault Explorer full page action");
  return found;
}

async function click(element: HTMLButtonElement): Promise<void> {
  await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function navigateToSelection(): void {
  const onSelectionChange = navigatorProps.onSelectionChange as (title: string | null, active: boolean) => void;
  act(() => onSelectionChange("A conversation", true));
}

beforeEach(() => {
  vi.clearAllMocks();
  navigatorProps = {};
  window.location.hash = "";
  vi.mocked(fetchConversationAgents).mockResolvedValue({ agents: [] });
  vi.mocked(fetchConversations).mockResolvedValue({ conversations: [] });
  vi.mocked(fetchVaultList).mockResolvedValue({
    path: ".",
    entries: [{ name: "index.md", path: "index.md", type: "file", bytes: 8, mtimeMs: 1 }],
    capped: false,
  });
  vi.mocked(fetchVaultRead).mockResolvedValue({
    path: "index.md",
    content: "# Hi",
    bytes: 6,
    mtimeMs: 1,
    capped: false,
  });
  vi.mocked(fetchStewardAlerts).mockResolvedValue({ attentionCount: 0, alerts: [] });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

describe("AppShell Steward Alerts full-page action (correction S3)", () => {
  it("adds the distinct sibling action beside the Steward Alerts toggle (never nested inside it)", async () => {
    await renderShell();
    await flush();
    const toggle = alertsToggleButton();
    const action = alertsFullPageAction();
    // Siblings in the same row; the action is NOT a descendant of the toggle.
    expect(action.closest("li")).toBe(toggle.closest("li"));
    expect(toggle.contains(action)).toBe(false);
    expect(action.getAttribute("aria-label")).toBe("Open Steward Alerts full page");
    expect(action.getAttribute("title")).toBe("Open Steward Alerts full page");
  });

  it("no selected Conversation: the action opens the Alerts full page with no unnecessary hash write and no desktop focus theft", async () => {
    await renderShell();
    await flush();
    const historyLength = window.history.length;
    const action = alertsFullPageAction();
    action.focus();
    await click(action);
    await flush();
    expect(container.querySelector(".steward-alerts-fullpage")).not.toBeNull();
    expect(container.querySelector(".mock-steward-alerts")).not.toBeNull();
    // No-selection: no hash write at all.
    expect(window.history.length).toBe(historyLength);
    expect(window.location.hash).toBe("");
    // Desktop: no programmatic focus move away from the invoked control.
    expect(document.activeElement).toBe(action);
    // The Alerts toggle stays open (aria-pressed) through the transition.
    expect(alertsToggleButton().getAttribute("aria-pressed")).toBe("true");
  });

  it("selected Conversation: the action writes the existing no-selection hash route once; the mounted navigator's ordinary signal yields the full-page fallback; no lifecycle change", async () => {
    await renderShell();
    await flush();
    navigateToSelection();
    await flush();
    await act(async () => {
      window.location.hash = "#conversation/abc-1";
    });
    await flush();
    const fetchCallsBefore = vi.mocked(fetchConversations).mock.calls.length;
    const historyLength = window.history.length;

    await click(alertsFullPageAction());
    await flush();

    // Exactly the one explicit no-selection hash write.
    expect(window.location.hash).toBe("");
    expect(window.history.length).toBe(historyLength + 1);
    // The still-mounted navigator remains the selection authority: only its
    // ordinary no-selection signal produces the full-page fallback.
    const onSelectionChange = navigatorProps.onSelectionChange as (title: string | null, active: boolean) => void;
    await act(async () => onSelectionChange(null, false));
    await flush();
    expect(container.querySelector(".steward-alerts-fullpage")).not.toBeNull();
    expect(container.querySelector(".mock-steward-alerts")).not.toBeNull();
    // Alerts stays open through the transition (never closed by the action).
    expect(alertsToggleButton().getAttribute("aria-pressed")).toBe("true");
    // No lifecycle side effects: no conversation-list refresh, no extra reads.
    expect(vi.mocked(fetchConversations).mock.calls.length).toBe(fetchCallsBefore);
    // Truthful shell subtitle reset by the navigator's own signal.
    expect(container.querySelector(".shell-subtitle")?.textContent).toBe("A calm workspace for your local-first agent team");
  });

  it("Alerts and Vault Explorer remain mutually exclusive across the full-page context", async () => {
    await renderShell();
    await flush();
    await click(explorerFullPageAction());
    await flush();
    expect(container.querySelector(".vault-explorer-fullpage")).not.toBeNull();

    await click(alertsFullPageAction());
    await flush();
    expect(container.querySelector(".steward-alerts-fullpage")).not.toBeNull();
    expect(container.querySelector(".vault-explorer-fullpage")).toBeNull();
    // The Explorer closed with the exclusive switch; its toggle is no longer
    // pressed and the Alerts toggle is.
    const toggles = Array.from(container.querySelectorAll<HTMLButtonElement>(".sidebar-companion-row .nav-item"));
    const explorerToggle = toggles.find((b) => b.textContent?.trim() === "Vault Explorer");
    expect(explorerToggle?.getAttribute("aria-pressed")).toBe("false");
    expect(alertsToggleButton().getAttribute("aria-pressed")).toBe("true");
  });

  it("a normal Dashboard selection exits the companion full-page context so the Dashboard is reachable", async () => {
    await renderShell();
    await flush();
    await click(alertsFullPageAction());
    await flush();
    expect(container.querySelector(".steward-alerts-fullpage")).not.toBeNull();
    const dashboardNav = container.querySelector<HTMLButtonElement>(".sidebar-pages .nav-item");
    await click(dashboardNav!);
    await flush();
    expect(container.querySelector(".steward-alerts-fullpage")).toBeNull();
  });

  it("from the mobile drawer, the action closes the drawer and returns focus to the persistent Menu control", async () => {
    await renderShell();
    await flush();
    const menuToggle = container.querySelector<HTMLButtonElement>(".nav-toggle");
    await act(async () => menuToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const drawerAction = alertsFullPageAction(container.querySelector("#mobile-drawer") ?? container);
    drawerAction.focus();
    await click(drawerAction);
    await flush();
    expect(container.querySelector("#mobile-drawer")).toBeNull();
    expect(container.querySelector(".steward-alerts-fullpage")).not.toBeNull();
    expect(document.activeElement).toBe(menuToggle);
  });
});
