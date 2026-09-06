// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DashboardView } from "../web/src/DashboardView.js";
import { SettingsView } from "../web/src/SettingsView.js";
import { VaultExplorer } from "../web/src/VaultExplorer.js";
import { StewardAlerts } from "../web/src/StewardAlerts.js";
import {
  fetchConversationAgents,
  fetchServiceStatus,
  fetchStewardAlert,
  fetchStewardAlerts,
  closeStewardAlert,
  fetchVaultList,
  fetchVaultRead,
  startConversation,
} from "../web/src/api.js";

// One file-level API mock: each surface describe configures exactly the
// reads it owns in beforeEach.
vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchConversationAgents: vi.fn(),
    fetchConversations: vi.fn(),
    fetchServiceStatus: vi.fn(),
    startConversation: vi.fn(),
    fetchVaultList: vi.fn(),
    fetchVaultRead: vi.fn(),
    fetchStewardAlerts: vi.fn(),
    fetchStewardAlert: vi.fn(),
    closeStewardAlert: vi.fn(),
  };
});

/**
 * 0.2.5 S10 — coherent premium Workbench presentation. One shared first-party
 * visual language across Dashboard, Settings, Vault Explorer, and Steward
 * Alerts. These tests pin STRUCTURE, SEMANTICS, and TOKEN-DERIVED styling
 * invariants — not arbitrary CSS declaration counts:
 *
 * - the shared presentational vocabulary exists (page header, elevated
 *   surface, pill, interactive row) and is token-only (no light-only
 *   hard-coded colors) so dark theme is correct by construction;
 * - a reduced-motion guard covers the shared interactive motion;
 * - each surface carries the shared header/surface/pill/row classes while
 *   its authoritative behavior stays byte-for-byte unchanged;
 * - resolved and closed terminal alert states stay visually distinct.
 */

const STYLES = readFileSync(join(process.cwd(), "web", "src", "styles.css"), "utf8");

/** The single S10 shared-language section (append-only; last section). */
function s10Section(): string {
  const marker = "0.2.5 S10 — shared Workbench presentation language";
  const index = STYLES.indexOf(marker);
  expect(index, "S10 shared presentation section marker present").toBeGreaterThan(-1);
  return STYLES.slice(index);
}

describe("S10 shared presentation vocabulary (static CSS contract)", () => {
  it("defines the shared page-header, surface, pill, and interactive-row classes", () => {
    for (const className of [
      ".wb-page-header",
      ".wb-page-icon",
      ".wb-page-heading",
      ".wb-page-lede",
      ".wb-surface",
      ".wb-pill",
      ".wb-row",
    ]) {
      expect(s10Section()).toContain(className);
    }
  });

  it("pill variants derive only from theme tokens (correct in light and dark)", () => {
    const section = s10Section();
    for (const [variant, token] of [
      [".wb-pill-ok", "var(--ok)"],
      [".wb-pill-muted", "var(--muted)"],
      [".wb-pill-warn", "var(--warn)"],
      [".wb-pill-error", "var(--error)"],
      [".wb-pill-accent", "var(--accent)"],
    ] as const) {
      expect(section).toContain(variant);
      const at = section.indexOf(variant);
      const rule = section.slice(at, section.indexOf("}", at));
      expect(rule, `${variant} uses ${token}`).toContain(token);
    }
    // No light-only hard-coded colors in the shared vocabulary: every color
    // decision flows through tokens/color-mix so dark theme needs no dupes.
    expect(section).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("interactive rows expose hover, selected, and disabled states with a visible focus ring", () => {
    const section = s10Section();
    expect(section).toMatch(/\.wb-row:hover/);
    expect(section).toMatch(/\.wb-row\[aria-pressed="true"\]/);
    expect(section).toMatch(/\.wb-row:disabled/);
    expect(section).toMatch(/\.wb-row:focus-visible/);
  });

  it("shared motion is restrained and honors prefers-reduced-motion", () => {
    const section = s10Section();
    // Any transition on interactive rows is wrapped by a reduced-motion guard
    // for the same selectors.
    expect(section).toMatch(/\.wb-row\s*\{[^}]*transition:/);
    expect(section).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.wb-row/);
  });
}

);

describe("S10 Dashboard presentation (behavior unchanged)", () => {
  const ROSTER = {
    agents: [
      { name: "dipu", online: true, model: "anthropic/claude-opus-4.6" },
      { name: "zora", online: false },
    ],
  };

  const SERVICE_SNAPSHOT: import("../web/src/service-observation.js").ServiceStatusSnapshot = {
    observedAt: "2026-08-16T12:00:00.000Z",
    manager: "systemd-user",
    targets: [
      { target: "telegram", state: "active" },
      { target: "discord", state: "unknown" },
      { target: "scheduler", state: "not-installed" },
    ],
  };

  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
    vi.mocked(fetchConversationAgents).mockResolvedValue(ROSTER);
    vi.mocked(fetchServiceStatus).mockResolvedValue(SERVICE_SNAPSHOT);
    vi.mocked(startConversation).mockResolvedValue({
      conversation: {
        id: "c9",
        title: "Conversation with dipu",
        audience: ["dipu"],
        status: "open",
        path: "collaboration/conversations/c9/index.md",
        createdBy: "steward",
        created: "2026-09-06T12:00:00.000Z",
        updated: "2026-09-06T12:00:00.000Z",
      },
      event: { id: "e9", conversationId: "c9", kind: "conversation_start_requested", created: "2026-09-06T12:00:00.000Z" },
      dispatch: [{ agent: "dipu", status: "completed" }],
    } as never);
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function renderDashboard(): Promise<void> {
    root = createRoot(container);
    act(() => {
      root.render(
        createElement(DashboardView, {
          token: "t",
          onUnauthorized: () => {},
          onValidated: () => {},
          onOpenConversation: () => {},
          reloadKey: 0,
        }),
      );
    });
    await flush();
  }

  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("carries the shared page-header vocabulary with the truthful mark and lede", async () => {
    await renderDashboard();
    expect(container.querySelector(".dashboard-welcome.wb-page-header")).not.toBeNull();
    expect(container.querySelector(".dashboard-welcome .wb-page-lede")).not.toBeNull();
    // The transparent Piren mark remains the Dashboard icon treatment.
    expect(container.querySelector("img.dashboard-mark")).not.toBeNull();
  });

  it("agent and service states use the shared pill vocabulary on top of the existing status classes", async () => {
    await renderDashboard();
    const onlinePill = container.querySelector<HTMLElement>('[data-agent="dipu"] .agent-status');
    expect(onlinePill?.classList.contains("wb-pill")).toBe(true);
    expect(onlinePill?.classList.contains("wb-pill-ok")).toBe(true);
    const offlinePill = container.querySelector<HTMLElement>('[data-agent="zora"] .agent-status');
    expect(offlinePill?.classList.contains("wb-pill-muted")).toBe(true);
    const serviceRows = container.querySelectorAll(".dashboard-service-list .agent-status");
    expect(serviceRows.length).toBe(4);
    // Gateway (authenticated roster fact) and the directly reported active
    // target are success pills; unknown is caution; not-installed is muted.
    expect(serviceRows[0]?.classList.contains("wb-pill-ok")).toBe(true);
    expect(serviceRows[1]?.classList.contains("wb-pill-ok")).toBe(true);
    expect(serviceRows[2]?.classList.contains("wb-pill-warn")).toBe(true);
    expect(serviceRows[3]?.classList.contains("wb-pill-muted")).toBe(true);
  });

  it("elevates the agent and services cards with the shared surface class", async () => {
    await renderDashboard();
    expect(container.querySelector(".card.dashboard-services.wb-surface")).not.toBeNull();
    const agentCards = container.querySelectorAll(".agent-card");
    expect(agentCards.length).toBe(2);
  });

  it("keeps the one-selection model and cardinality-routed Start control unchanged", async () => {
    let opened: string[] = [];
    root = createRoot(container);
    act(() => {
      root.render(
        createElement(DashboardView, {
          token: "t",
          onUnauthorized: () => {},
          onValidated: () => {},
          onOpenConversation: (id: string) => opened.push(id),
          reloadKey: 0,
        }),
      );
    });
    await flush();
    const dipu = container.querySelector<HTMLButtonElement>('[data-agent="dipu"]');
    expect(dipu?.getAttribute("aria-pressed")).toBe("false");
    await act(async () => dipu!.click());
    expect(dipu?.getAttribute("aria-pressed")).toBe("true");
    const start = container.querySelector<HTMLButtonElement>(".dashboard-start");
    expect(start).not.toBeNull();
    expect(start?.disabled).toBe(false);
    // Exactly-one selection routes to the single-agent start path; the roster
    // read count never grows from a start action.
    const rosterReads = vi.mocked(fetchConversationAgents).mock.calls.length;
    await act(async () => start!.click());
    await flush();
    expect(startConversation).toHaveBeenCalledTimes(1);
    expect(opened).toEqual(["c9"]);
    expect(vi.mocked(fetchConversationAgents).mock.calls.length).toBe(rosterReads);
  });
});

describe("S10 Settings presentation (tabs and forms unchanged)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container.remove();
  });

  function renderSettings(): void {
    root = createRoot(container);
    act(() => {
      root.render(
        createElement(SettingsView, { token: "t", onUnauthorized: () => {}, onValidated: () => {} }),
      );
    });
  }

  it("uses the shared page-header vocabulary with an icon tile and lede", () => {
    renderSettings();
    const header = container.querySelector(".settings-header.wb-page-header");
    expect(header).not.toBeNull();
    expect(header?.querySelector(".wb-page-icon")).not.toBeNull();
    expect(header?.querySelector(".wb-page-heading h2")?.textContent).toBe("Settings");
    expect(header?.querySelector(".wb-page-lede")).not.toBeNull();
  });

  it("keeps exactly three WAI-ARIA tabs with arrow-key movement and all panels mounted", () => {
    renderSettings();
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs.length).toBe(3);
    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist?.getAttribute("aria-label")).toBe("Settings sections");
    // Arrow key moves focus only.
    tabs[0]?.focus();
    tabs[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(tabs[1]);
    // All three panels remain mounted (typed forms keep state).
    expect(container.querySelectorAll('section[role="tabpanel"]').length).toBe(3);
    expect(container.querySelector("#settings-panel-agents")?.getAttribute("hidden")).not.toBeNull();
  });

  it("family cards carry the shared elevated surface class", () => {
    renderSettings();
    const families = container.querySelectorAll(".settings-family.wb-surface");
    expect(families.length).toBeGreaterThanOrEqual(3);
  });
});

describe("S10 Vault Explorer presentation (S9 links and scroll ownership unchanged)", () => {
  const LIST: import("../web/src/vault-explorer.js").VaultListResponse = {
    path: ".",
    entries: [
      { path: "Projects", name: "Projects", type: "directory" as const, mtimeMs: 1725000000000 },
      { path: "SOUL.md", name: "SOUL.md", type: "file" as const, bytes: 1200, mtimeMs: 1725000000000 },
      { path: "data.json", name: "data.json", type: "file" as const, bytes: 42, mtimeMs: 1725000000000 },
    ],
    capped: false,
  };

  const DOC = {
    path: "SOUL.md",
    content: "---\ntype: Concept\ntitle: Example\nlinks:\n  - /Projects/Piren/index.md\n---\n\n# Example\n\nBody text.\n",
    bytes: 1200,
    mtimeMs: 1725000000000,
    capped: false,
  };

  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
    vi.mocked(fetchVaultList).mockResolvedValue(LIST);
    vi.mocked(fetchVaultRead).mockResolvedValue(DOC);
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function renderExplorer(): { locations: string[] } {
    const locations: string[] = [];
    root = createRoot(container);
    act(() => {
      root.render(
        createElement(VaultExplorer, {
          token: "t",
          onUnauthorized: () => {},
          onValidated: () => {},
          onLocationChange: (location) => locations.push(location.path),
        }),
      );
    });
    return { locations };
  }

  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("gives file and directory rows the shared interactive-row treatment", async () => {
    renderExplorer();
    await flush();
    const rows = container.querySelectorAll(".vault-explorer-entry.wb-row");
    expect(rows.length).toBe(3);
  });

  it("keeps the breadcrumb toolbar with its order affordance and applies the shared toolbar class", async () => {
    renderExplorer();
    await flush();
    expect(container.querySelector(".vault-explorer-breadcrumb.wb-toolbar")).not.toBeNull();
    expect(container.querySelector(".vault-explorer-order-toggle")).not.toBeNull();
  });

  it("presents the frontmatter metadata card as a shared elevated surface and keeps S9 links operable", async () => {
    renderExplorer();
    await flush();
    const file = container.querySelectorAll<HTMLButtonElement>(".vault-explorer-entry")[2]!;
    expect(file.textContent).toContain("SOUL.md");
    await act(async () => file.click());
    await flush();
    expect(container.querySelector(".vault-explorer-frontmatter.wb-surface")).not.toBeNull();
    // S9: the internal frontmatter link is still an in-place navigation button.
    const link = container.querySelector<HTMLButtonElement>(".vault-explorer-frontmatter-link");
    expect(link?.tagName).toBe("BUTTON");
    await act(async () => link!.click());
    await flush();
    expect(fetchVaultRead).toHaveBeenCalledWith("Projects/Piren/index.md", "t", expect.anything());
  });

  it("renders the reading canvas through the shared comfortable-measure wrapper", async () => {
    renderExplorer();
    await flush();
    const file = container.querySelectorAll<HTMLButtonElement>(".vault-explorer-entry")[2]!;
    expect(file.textContent).toContain("SOUL.md");
    await act(async () => file.click());
    await flush();
    expect(container.querySelector(".vault-explorer-document .wb-reading")).not.toBeNull();
    expect(container.querySelector(".vault-explorer-document .markdown-body")).not.toBeNull();
  });
});

describe("S10 Steward Alerts presentation (list/detail/close/resolved behavior unchanged)", () => {
  const openAlert = {
    path: "steward-inbox/alerts/a.md",
    id: "a",
    severity: "urgent" as const,
    status: "open" as const,
    title: "Urgent alert",
    created: "2026-09-01T10:00:00.000Z",
  };
  const lowOpenAlert = {
    path: "steward-inbox/alerts/b.md",
    id: "b",
    severity: "normal" as const,
    status: "open" as const,
    title: "Normal alert",
    created: "2026-09-02T10:00:00.000Z",
  };

  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
    vi.mocked(fetchStewardAlerts).mockResolvedValue({ attentionCount: 2, alerts: [openAlert, lowOpenAlert] });
    vi.mocked(fetchStewardAlert).mockImplementation(async (path: string) => ({
      ...(path === openAlert.path ? openAlert : lowOpenAlert),
      content: "Body.",
    }));
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function renderAlerts(): void {
    root = createRoot(container);
    act(() => {
      root.render(
        createElement(StewardAlerts, {
          token: "t",
          onUnauthorized: () => {},
          onValidated: () => {},
          reloadKey: 0,
          onClosed: () => {},
        }),
      );
    });
  }

  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("uses the shared page-header vocabulary with an icon tile", async () => {
    renderAlerts();
    await flush();
    const header = container.querySelector(".steward-alerts-header.wb-page-header");
    expect(header).not.toBeNull();
    expect(header?.querySelector(".wb-page-icon")).not.toBeNull();
  });

  it("renders inbox-like alert rows with shared row and severity pill vocabulary", async () => {
    renderAlerts();
    await flush();
    const rows = container.querySelectorAll(".steward-alert-list button.wb-row");
    expect(rows.length).toBe(2);
    const urgentPill = rows[0]?.querySelector(".steward-alert-severity");
    expect(urgentPill?.classList.contains("wb-pill-error")).toBe(true);
    const normalPill = rows[1]?.querySelector(".steward-alert-severity");
    expect(normalPill?.classList.contains("wb-pill-muted")).toBe(true);
  });

  it("presents the detail as a shared elevated surface; open state keeps the exact close mutation", async () => {
    renderAlerts();
    await flush();
    const row = container.querySelector<HTMLButtonElement>(".steward-alert-list button");
    await act(async () => row!.click());
    await flush();
    expect(container.querySelector(".steward-alert-detail.wb-surface")).not.toBeNull();
    const close = container.querySelector<HTMLButtonElement>(".steward-alert-detail .button");
    expect(close?.textContent).toContain("Close alert");
    await act(async () => close!.click());
    await flush();
    expect(closeStewardAlert).toHaveBeenCalledWith(openAlert.path, "t");
  });

  it("keeps historical resolved and Workbench closed terminal states visually distinct", async () => {
    const resolvedSummary = { ...openAlert, status: "resolved" as const, resolvedAt: "2026-09-01T11:00:00Z" };
    const closedSummary = { ...lowOpenAlert, status: "closed" as const, closedAt: "2026-09-02T11:00:00Z" };
    vi.mocked(fetchStewardAlerts).mockResolvedValue({ attentionCount: 0, alerts: [resolvedSummary, closedSummary] });
    vi.mocked(fetchStewardAlert).mockImplementation(async (path: string) => ({
      ...(path === resolvedSummary.path ? resolvedSummary : closedSummary),
      content: "Body.",
    }));
    renderAlerts();
    await flush();
    const firstRow = container.querySelector<HTMLButtonElement>(".steward-alert-list button");
    await act(async () => firstRow!.click());
    await flush();
    const resolved = container.querySelector(".steward-alert-terminal-resolved");
    expect(resolved).not.toBeNull();
    expect(resolved?.classList.contains("wb-pill-muted")).toBe(true);
    // Back to the list, open the closed alert, and compare terminal classes.
    const back = container.querySelector<HTMLButtonElement>(".steward-alerts-header button");
    await act(async () => back!.click());
    await flush();
    const secondRow = container.querySelectorAll<HTMLButtonElement>(".steward-alert-list button")[1]!;
    await act(async () => secondRow.click());
    await flush();
    const closed = container.querySelector(".steward-alert-terminal-closed");
    expect(closed).not.toBeNull();
    expect(closed?.classList.contains("wb-pill-accent")).toBe(true);
    expect(closed?.classList.contains("steward-alert-terminal-resolved")).toBe(false);
    expect(resolved?.className).not.toBe(closed?.className);
    // Terminal states never offer a close control.
    expect(container.querySelector(".steward-alert-detail .button")).toBeNull();
  });
});
