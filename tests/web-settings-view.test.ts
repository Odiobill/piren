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
 * W3+W5+W6 (0.2.0 amendment §5) — jsdom tests for the full-page Settings
 * shell: W3 semantic structure + non-action language for the static families,
 * W5 typed Telegram/Discord transport workflows, and W6 typed scheduler and
 * agent-preference workflows.
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

describe("SettingsView (W5 typed transport forms + static families)", () => {
  it("renders an accessible page heading and tier sections", async () => {
    await renderSettings();
    const heading = container.querySelector("h2");
    expect(heading?.textContent).toBe("Settings");
    const sections = container.querySelectorAll("section[aria-labelledby]");
    expect(sections.length).toBeGreaterThanOrEqual(3);
    const headings = [...container.querySelectorAll("section h3")].map((h) => h.textContent ?? "");
    expect(headings.some((h) => /typed configuration workflows/i.test(h))).toBe(true);
    expect(headings.some((h) => /read-only inspection/i.test(h))).toBe(true);
    expect(headings.some((h) => /service actions/i.test(h))).toBe(true);
  });

  it("names the Tier A workflow families and accurately labels delivered model fallback", async () => {
    await renderSettings();
    const text = container.textContent ?? "";
    expect(text).toContain("Telegram transport");
    expect(text).toContain("Discord transport");
    expect(text).toContain("Scheduler automation");
    expect(text).toMatch(/agent preferences/i);
    expect(text).toMatch(/same agent/i);
    expect(text).toMatch(/same live session|same session/i);
    expect(text).not.toMatch(/inert groundwork/i);
  });

  it("the static (non-transport) families keep non-action availability language", async () => {
    await renderSettings();
    const text = container.textContent ?? "";
    expect(text).toMatch(/separately gated/i);
    expect(text).toMatch(/not available in this shell/i);
  });

  it("Telegram/Discord/scheduler/agent families gain typed forms while Tier B/C stay static", async () => {
    vi.mocked(fetchTelegramSettings).mockResolvedValue({ available: true, value: { configured: false, allowedChatIds: 0, defaultAgent: null, feedbackEnabled: null } });
    vi.mocked(fetchDiscordSettings).mockResolvedValue({ available: true, value: { configured: false, allowedGuildIds: 0, allowedChannelIds: 0, allowedThreadIds: null, allowedDmUserIds: null, defaultAgent: null, feedbackEnabled: null } });
    vi.mocked(fetchSchedulerSettings).mockResolvedValue({ available: true, value: { present: false, enabled: false, automation: { inboxTasks: false, agentCron: false, scriptCron: false }, deviceIdConfigured: false, pollIntervalSeconds: null, staleAfterSeconds: null, maxConcurrentAgents: null, deviceId: null } });
    vi.mocked(fetchConversationAgents).mockResolvedValue({ agents: [{ name: "kimi", online: true }] });
    await renderSettings();
    // The two transport workflows expose the write-only token input; the
    // scheduler form exposes its master-gate checkbox; the agent form exposes
    // the runnable-agent selector.
    expect(container.querySelectorAll(".settings-form-token").length).toBe(2);
    expect(container.querySelector(".settings-scheduler-enabled")).not.toBeNull();
    expect(container.querySelector(".settings-agent-select")).not.toBeNull();
    // Tier B/C stay read-only/action descriptions (no inputs).
    const tierB = container.querySelector("#settings-tier-b-heading")?.closest("section");
    expect(tierB?.querySelectorAll("input, select, button").length).toBe(0);
  });

  it("lists the boundaries Settings will never cross", async () => {
    await renderSettings();
    const text = container.textContent ?? "";
    expect(text).toMatch(/never/i);
    expect(text).toMatch(/generic/i);
    expect(text).toMatch(/provider credential/i);
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
