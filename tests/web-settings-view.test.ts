// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsView } from "../web/src/SettingsView.js";
import { Sidebar } from "../web/src/Sidebar.js";
import { fetchConversations, fetchTelegramSettings, fetchDiscordSettings, fetchSchedulerSettings, fetchConversationAgents } from "../web/src/api.js";

/**
 * S1 (workbench-ux-follow-up-design §4.1) — jsdom tests for the
 * authority-first full-page Settings page: exactly two accessible authority
 * sections (This installation / Agents in this vault), the existing typed
 * workflows in their correct section, and absence of the retired tier/
 * roadmap/never-do copy. Form/auth/error behavior keeps its own suites.
 */

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchConversations: vi.fn(),
    fetchTelegramSettings: vi.fn(),
    fetchDiscordSettings: vi.fn(),
    fetchSchedulerSettings: vi.fn(),
    fetchConversationAgents: vi.fn(),
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(fetchTelegramSettings).mockResolvedValue({ available: false, reason: "Local config is not present." });
  vi.mocked(fetchDiscordSettings).mockResolvedValue({ available: false, reason: "Local config is not present." });
  vi.mocked(fetchSchedulerSettings).mockResolvedValue({ available: false, reason: "Local config is not present." });
  vi.mocked(fetchConversationAgents).mockResolvedValue({ agents: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderSettings(): Promise<void> {
  await act(async () => {
    root.render(createElement(SettingsView, { token: "t", onUnauthorized: vi.fn(), onValidated: vi.fn() }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("SettingsView (S1 authority-first page)", () => {
  it("renders exactly three accessible tabs in fixed order with This installation active by default", async () => {
    await renderSettings();
    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist).not.toBeNull();
    const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(["This installation", "Agent settings", "Agent groups"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");
    expect(tabs[2]?.getAttribute("aria-selected")).toBe("false");
  });

  it("keeps the two authority sections reachable for the typed workflows (ST-2A)", async () => {
    await renderSettings();
    const heading = container.querySelector("h2");
    expect(heading?.textContent).toBe("Settings");
    const sections = container.querySelectorAll("section[role='tabpanel'], section[aria-labelledby]");
    expect(sections.length).toBe(3);
    const headings = [...container.querySelectorAll("section h3")].map((h) => h.textContent ?? "");
    expect(headings).toEqual(["This installation", "Agent settings", "Agent groups"]);
    expect(container.querySelector("#settings-installation-heading")).not.toBeNull();
    expect(container.querySelector("#settings-agents-heading")).not.toBeNull();
  });

  it("keeps the existing typed workflows in their correct authority section", async () => {
    vi.mocked(fetchTelegramSettings).mockResolvedValue({ available: true, value: { configured: false, allowedChatIds: 0, allowedChatIdValues: [], defaultAgent: null, feedbackEnabled: null } });
    vi.mocked(fetchDiscordSettings).mockResolvedValue({ available: true, value: { configured: false, allowedGuildIds: 0, allowedGuildIdValues: [], allowedChannelIds: 0, allowedChannelIdValues: [], allowedThreadIds: null, allowedThreadIdValues: null, allowedDmUserIds: null, allowedDmUserIdValues: null, defaultAgent: null, feedbackEnabled: null } });
    vi.mocked(fetchSchedulerSettings).mockResolvedValue({ available: true, value: { present: false, legacyMasterGate: "absent", automation: { inboxTasks: false, agentCron: false, scriptCron: false }, deviceIdConfigured: false, pollIntervalSeconds: null, staleAfterSeconds: null, maxConcurrentAgents: null, deviceId: null, agentScope: { inboxTasks: null, agentCron: null, scriptCron: null } }, runnableAgents: ["kimi"], agentScopeWarnings: [] });
    vi.mocked(fetchConversationAgents).mockResolvedValue({ agents: [{ name: "kimi", online: true }] });
    await renderSettings();
    const installation = container.querySelector("#settings-installation-heading")?.closest("section");
    const agents = container.querySelector("#settings-agents-heading")?.closest("section");
    // Machine-local typed workflows live under This installation.
    expect(installation?.querySelectorAll(".settings-form-token").length).toBe(2);
    // The retired master gate is gone from the form (ST-1A).
    expect(installation?.querySelector(".settings-scheduler-enabled")).toBeNull();
    expect(installation?.querySelector(".settings-scheduler-inbox")).not.toBeNull();
    // The vault-owned agent preferences workflow lives under Agents.
    // ST-3: the agent picker is now a radio-card group, not a select.
    expect(agents?.querySelector(".settings-agent-cards")).not.toBeNull();
    expect(installation?.querySelector(".settings-agent-cards")).toBeNull();
    expect(agents?.querySelector(".settings-agent-select")).toBeNull();
    expect(agents?.querySelectorAll(".settings-form-token").length).toBe(0);
    expect(agents?.querySelector(".settings-scheduler-enabled")).toBeNull();
  });

  it("keeps each authority list flat: form cards are direct list children with no nested .settings-family", async () => {
    vi.mocked(fetchConversationAgents).mockResolvedValue({ agents: [{ name: "kimi", online: true }] });
    await renderSettings();
    const lists = container.querySelectorAll("section ul.settings-family-list");
    expect(lists.length).toBe(2);
    const installation = lists[0] as HTMLUListElement;
    const agents = lists[1] as HTMLUListElement;
    // Direct children only, one card per existing form.
    expect(installation.children.length).toBe(3);
    expect(agents.children.length).toBe(1);
    for (const list of [installation, agents]) {
      for (const child of Array.from(list.children)) {
        expect(child.classList.contains("settings-family")).toBe(true);
        expect(child.querySelector(".settings-family")).toBeNull();
      }
    }
    expect(container.querySelectorAll(".settings-family .settings-family").length).toBe(0);
  });

  it("removes the internal tier/roadmap/process copy and the never-do section from the rendered page", async () => {
    await renderSettings();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/tier/i);
    expect(text).not.toMatch(/gated/i);
    expect(text).not.toMatch(/What Settings will never do/i);
    expect(text).not.toMatch(/read-only inspection/i);
    expect(text).not.toMatch(/will arrive/i);
    expect(text).not.toMatch(/later slices?/i);
    expect(text).not.toMatch(/availability/i);
  });

  it("keeps truthful user-facing supporting copy for both authorities without live/contact/restart claims", async () => {
    await renderSettings();
    const text = container.textContent ?? "";
    expect(text).toContain("~/.config/piren/");
    expect(text).toContain("config.yml");
    expect(text).toMatch(/future-launch|future launches/i);
    expect(text).not.toMatch(/restarted|contacted|is running|wakes? the agent/i);
  });
});

describe("Settings page static style contract (S1)", () => {
  it("styles the authority-first page without reintroducing roadmap-only classes", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const styles = await readFile(join(process.cwd(), "web", "src", "styles.css"), "utf8");
    expect(styles).toContain(".settings-lede {");
    // Retired roadmap presentation class stays gone.
    expect(styles).not.toContain(".settings-availability");
    // No new scroll region: the page keeps the document-flow layout.
    const start = styles.indexOf(".settings-page {");
    const rule = styles.slice(start, styles.indexOf("}", start));
    expect(rule).not.toMatch(/overflow/);
  });
});

describe("Sidebar Settings nav item (W3)", () => {
  beforeEach(() => {
    vi.mocked(fetchConversations).mockResolvedValue({ conversations: [] });
  });

  it("renders a Settings nav item with aria-current only when selected", async () => {
    const onSelect = vi.fn();
    await act(async () => {
      root.render(
        createElement(Sidebar, {
          page: "settings",
          token: "t",
          onSelect,
          onValidated: () => {},
          onUnauthorized: () => {},
          conversationsReloadKey: 0,
          explorerOpen: false,
          onToggleExplorer: () => {},
        }),
      );
    });
    const buttons = [...container.querySelectorAll("button")];
    const settingsButton = buttons.find((b) => b.textContent === "Settings");
    expect(settingsButton).toBeDefined();
    expect(settingsButton?.getAttribute("aria-current")).toBe("page");
    const dashboardButton = buttons.find((b) => b.textContent === "Dashboard");
    expect(dashboardButton?.getAttribute("aria-current")).toBeNull();
  });

  it("selecting Settings calls onSelect('settings')", async () => {
    const onSelect = vi.fn();
    await act(async () => {
      root.render(
        createElement(Sidebar, {
          page: "dashboard",
          token: "t",
          onSelect,
          onValidated: () => {},
          onUnauthorized: () => {},
          conversationsReloadKey: 0,
          explorerOpen: false,
          onToggleExplorer: () => {},
        }),
      );
    });
    const settingsButton = [...container.querySelectorAll("button")].find((b) => b.textContent === "Settings");
    expect(settingsButton).toBeDefined();
    await act(async () => {
      settingsButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith("settings");
  });
});

// ---------------------------------------------------------------------------
// ST-2A: welcoming Settings tab shell, installation cards, static help
// ---------------------------------------------------------------------------

/** Flush pending act work (shared with the tab tests). */
async function flush2(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function settingsTabs(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
}

function pressTab(tab: Element, key: string): void {
  act(() => {
    tab.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    if (key === "Enter" || key === " ") {
      tab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });
}

describe("ST-2A: accessible tab semantics", () => {
  it("arrow/Home/End keys move TAB FOCUS only; Enter activates; focus stays on the active tab", async () => {
    await renderSettings();
    const tabs = settingsTabs();
    tabs[0]!.focus();
    pressTab(tabs[0]!, "ArrowRight");
    expect(document.activeElement).toBe(tabs[1]);
    // Focus moved without activation.
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");
    pressTab(tabs[1]!, "Enter");
    await flush2();
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("false");
    expect(document.activeElement).toBe(tabs[1]);
    // Home/End move focus only.
    pressTab(tabs[1]!, "End");
    expect(document.activeElement).toBe(tabs[2]);
    pressTab(tabs[2]!, "Home");
    expect(document.activeElement).toBe(tabs[0]);
  });

  it("each tab controls a real panel; exactly the active panel is exposed (no nested scroll trap)", async () => {
    await renderSettings();
    for (const tab of settingsTabs()) {
      const panel = container.querySelector(`#${tab.getAttribute("aria-controls")}`);
      expect(panel?.getAttribute("role")).toBe("tabpanel");
      expect(panel?.hasAttribute("hidden")).toBe(tab.getAttribute("aria-selected") !== "true");
      // One scroll owner: panels never set their own overflow.
      const styles = getComputedStyle(panel as HTMLElement);
      expect(["visible", "none"]).toContain(styles.overflowY);
    }
  });

  it("view state is component-local: no browser persistence in the Settings view or help control", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const view = await readFile(join(process.cwd(), "web", "src", "SettingsView.tsx"), "utf8");
    const help = await readFile(join(process.cwd(), "web", "src", "SettingsHelpControl.tsx"), "utf8");
    for (const source of [view, help]) {
      expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    }
  });

  it("the Agent groups panel renders bounded loading then its typed workflows (ST-4)", async () => {
    await renderSettings();
    const tabs = settingsTabs();
    pressTab(tabs[2]!, "ArrowRight"); // focus moves only
    pressTab(tabs[2]!, "Enter");
    await flush2();
    const panel = container.querySelector(`#${tabs[2]!.getAttribute("aria-controls")}`);
    expect(panel?.textContent?.toLowerCase()).toContain("agent groups");
  });
});

describe("ST-2A: static first-party transport help modals", () => {
  it("offers How to set up a bot controls for Telegram and Discord, each with a decorative icon", async () => {
    await renderSettings();
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".settings-help-trigger"));
    const labels = buttons.map((b) => b.textContent ?? "");
    expect(labels.some((l) => l.includes("Telegram"))).toBe(true);
    expect(labels.some((l) => l.includes("Discord"))).toBe(true);
    expect(buttons.every((b) => b.querySelector("svg") !== null)).toBe(true);
  });

  it("opens a labelled modal dialog; Escape closes and returns focus to the trigger; explicit close works", async () => {
    await renderSettings();
    const trigger = container.querySelectorAll<HTMLButtonElement>(".settings-help-trigger")[0]!;
    trigger.focus();
    act(() => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush2();

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    const labelledBy = dialog?.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(labelledBy)?.textContent?.toLowerCase().includes("set up a")).toBe(true);
    // Focus moved inside the dialog.
    expect(dialog!.contains(document.activeElement)).toBe(true);

    // Escape closes and returns focus to the trigger.
    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await flush2();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    // Explicit close button also dismisses.
    act(() => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush2();
    const close = container.querySelector<HTMLButtonElement>(".settings-help-close")!;
    expect(close).not.toBeNull();
    act(() => close.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush2();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("the help control is fully static and first-party: no fetch, storage, remote content, or token handling", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const source = await readFile(join(process.cwd(), "web", "src", "SettingsHelpControl.tsx"), "utf8");
    expect(source).not.toMatch(/fetch\(|XMLHttpRequest|localStorage|sessionStorage|document\.cookie|window\.open/);
    // No token handling surface (prose may mention that tokens stay private).
    expect(source).not.toMatch(/botToken|\.token\b|token=|type="password"/);
    expect(source).not.toMatch(/https?:\/\//); // no remote content
  });
});

describe("ST-2A: welcoming cards and copy discipline", () => {
  it("styles the installation families as cards, the tabs with visible active state, and a narrow responsive layout", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const styles = await readFile(join(process.cwd(), "web", "src", "styles.css"), "utf8");
    // Cards: bordered, rounded family surfaces inside the settings list.
    expect(styles).toMatch(/\.settings-family-list\s+\.settings-family\s*\{[^}]*border/);
    expect(styles).toMatch(/\.settings-family-list\s+\.settings-family\s*\{[^}]*border-radius/);
    // Tabs styling exists with an active state.
    expect(styles).toMatch(/\.settings-tab\[aria-selected="true"\]/);
    // Narrow responsive layout keeps tabs reachable without horizontal overflow.
    expect(styles).toMatch(/@media[^{]*max-width[^{]*\{[^@]*\.settings-tabs/s);
  });

  it("user-facing copy avoids em dashes", async () => {
    await renderSettings();
    expect(container.textContent).not.toContain("\u2014");
  });
});
