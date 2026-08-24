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
  it("renders exactly two accessible authority sections with user-facing headings and supporting copy", async () => {
    await renderSettings();
    const heading = container.querySelector("h2");
    expect(heading?.textContent).toBe("Settings");
    const sections = container.querySelectorAll("section[aria-labelledby]");
    expect(sections.length).toBe(2);
    const headings = [...container.querySelectorAll("section h3")].map((h) => h.textContent ?? "");
    expect(headings).toEqual(["This installation", "Agents in this vault"]);
    expect(container.querySelector("#settings-installation-heading")).not.toBeNull();
    expect(container.querySelector("#settings-agents-heading")).not.toBeNull();
  });

  it("keeps the existing typed workflows in their correct authority section", async () => {
    vi.mocked(fetchTelegramSettings).mockResolvedValue({ available: true, value: { configured: false, allowedChatIds: 0, allowedChatIdValues: [], defaultAgent: null, feedbackEnabled: null } });
    vi.mocked(fetchDiscordSettings).mockResolvedValue({ available: true, value: { configured: false, allowedGuildIds: 0, allowedGuildIdValues: [], allowedChannelIds: 0, allowedChannelIdValues: [], allowedThreadIds: null, allowedThreadIdValues: null, allowedDmUserIds: null, allowedDmUserIdValues: null, defaultAgent: null, feedbackEnabled: null } });
    vi.mocked(fetchSchedulerSettings).mockResolvedValue({ available: true, value: { present: false, legacyMasterGate: "absent", automation: { inboxTasks: false, agentCron: false, scriptCron: false }, deviceIdConfigured: false, pollIntervalSeconds: null, staleAfterSeconds: null, maxConcurrentAgents: null, deviceId: null } });
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
    expect(agents?.querySelector(".settings-agent-select")).not.toBeNull();
    // No cross-placement.
    expect(installation?.querySelector(".settings-agent-select")).toBeNull();
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
