// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DashboardView } from "../web/src/DashboardView.js";
import { Sidebar } from "../web/src/Sidebar.js";
import { SplitWorkspaceShell } from "../web/src/SplitWorkspaceShell.js";
import { ConversationComposer } from "../web/src/ConversationComposer.js";
import { AssignTaskModal } from "../web/src/AssignTaskModal.js";
import { ConversationTimeline } from "../web/src/ConversationTimeline.js";
import { VaultExplorer } from "../web/src/VaultExplorer.js";
import { SettingsView } from "../web/src/SettingsView.js";
import { TelegramSettingsForm } from "../web/src/TelegramSettingsForm.js";
import { DiscordSettingsForm } from "../web/src/DiscordSettingsForm.js";
import { SchedulerSettingsForm } from "../web/src/SchedulerSettingsForm.js";
import { AgentPreferencesForm } from "../web/src/AgentPreferencesForm.js";
import type { ConversationRecord } from "../web/src/conversations.js";
import {
  fetchConversationAgents,
  fetchConversationEvents,
  fetchConversations,
  fetchServiceStatus,
  fetchTelegramSettings,
  fetchDiscordSettings,
  fetchSchedulerSettings,
  fetchAgentPreferences,
  fetchVaultList,
  fetchVaultRead,
} from "../web/src/api.js";

/**
 * WUX-A visible-UI correction: every rendered Workbench button carries a
 * suitable decorative local SVG icon (established avatar/glyph controls may
 * count only when they visibly provide the glyph), and no user-visible
 * surface renders an em dash. Text/accessible names and behavior are
 * unchanged; no external icon library and no new actions are introduced.
 */

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchConversationAgents: vi.fn(),
    fetchConversations: vi.fn(),
    fetchServiceStatus: vi.fn(),
    fetchConversationEvents: vi.fn(),
    fetchVaultList: vi.fn(),
    fetchVaultRead: vi.fn(),
    fetchTelegramSettings: vi.fn(),
    fetchDiscordSettings: vi.fn(),
    fetchSchedulerSettings: vi.fn(),
    fetchAgentPreferences: vi.fn(),
  };
});

beforeEach(() => {
  // SettingsView mounts all typed forms; give them bounded reads.
  vi.mocked(fetchTelegramSettings).mockResolvedValue({ available: false, reason: "Local config is not present." });
  vi.mocked(fetchDiscordSettings).mockResolvedValue({ available: false, reason: "Local config is not present." });
  vi.mocked(fetchSchedulerSettings).mockResolvedValue({ available: false, reason: "Local config is not present." });
  vi.mocked(fetchAgentPreferences).mockResolvedValue({
    available: true,
    value: {
      model: { id: null, thinking: null },
      modelFallback: { declared: false, autoSwitch: null, modelCount: 0, models: [] },
      contextInjection: { mode: null },
      selfImprovement: { autoNudge: null, reviewLoopEnabled: null, reviewLoop: { intervalTurns: null, recentMessages: null, timeoutMs: null } },
    },
  } as never);
});

const ROSTER = {
  agents: [
    { name: "dipu", online: true },
    { name: "kimi", online: true },
  ],
};

const CONVERSATION: ConversationRecord = {
  id: "c1",
  title: "Conversation with dipu",
  audience: ["dipu"],
  status: "open",
  path: "collaboration/conversations/c1/index.md",
  createdBy: "steward",
  created: "2026-08-23T10:00:00.000Z",
  updated: "2026-08-23T10:00:00.000Z",
};

/**
 * Buttons whose visible glyph is an established non-SVG presentation:
 * the Dashboard agent-card letter avatar and the shell hamburger glyph.
 */
const ESTABLISHED_GLYPH_CLASSES = [".agent-card-avatar", ".hamburger"];

function buttonHasVisibleIcon(button: HTMLButtonElement): boolean {
  if (button.querySelector("svg[aria-hidden='true']") !== null) return true;
  return ESTABLISHED_GLYPH_CLASSES.some((cls) => button.querySelector(cls) !== null);
}

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(element: ReactElement): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root.render(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function expectEveryButtonHasIcon(surface: string): void {
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  expect(buttons.length, `${surface}: expected rendered buttons`).toBeGreaterThan(0);
  const unadorned = buttons.filter((button) => !buttonHasVisibleIcon(button));
  const described = unadorned.map((button) => `${surface}: <${button.tagName.toLowerCase()} class="${button.className}">${button.textContent?.slice(0, 40) ?? ""}</>`);
  expect(described, `buttons without a decorative icon`).toEqual([]);
}

function expectNoEmDash(surface: string): void {
  const text = container.textContent ?? "";
  expect(text.includes("\u2014"), `${surface} renders an em dash: ${JSON.stringify(text.slice(0, 200))}`).toBe(false);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  (Element.prototype as unknown as Record<string, unknown>).scrollTo = () => {};
  const mocks = [
    fetchConversationAgents,
    fetchConversations,
    fetchServiceStatus,
    fetchConversationEvents,
    fetchVaultList,
    fetchVaultRead,
    fetchTelegramSettings,
    fetchDiscordSettings,
    fetchSchedulerSettings,
    fetchAgentPreferences,
  ];
  for (const mock of mocks) vi.mocked(mock).mockReset();
  vi.mocked(fetchConversationAgents).mockResolvedValue(ROSTER);
  vi.mocked(fetchConversations).mockResolvedValue({
    conversations: [CONVERSATION],
  });
  vi.mocked(fetchServiceStatus).mockResolvedValue({
    observedAt: "2026-08-23T10:00:00.000Z",
    manager: "systemd-user",
    targets: [
      { target: "telegram", state: "inactive" },
      { target: "discord", state: "inactive" },
      { target: "scheduler", state: "not-installed" },
    ],
  });
  vi.mocked(fetchVaultList).mockResolvedValue({
    path: "",
    entries: [{ name: "notes.md", type: "file", path: "notes.md", bytes: 20, mtimeMs: 0 }],
    capped: false,
  });
  vi.mocked(fetchVaultRead).mockResolvedValue({
    path: "notes.md",
    content: "# Notes\n\nBody text.",
    bytes: 20,
    mtimeMs: 0,
    capped: false,
  });
  vi.mocked(fetchTelegramSettings).mockResolvedValue({
    available: true,
    value: { configured: false, allowedChatIds: 0, allowedChatIdValues: [], defaultAgent: null, feedbackEnabled: null },
  });
  vi.mocked(fetchDiscordSettings).mockResolvedValue({
    available: true,
    value: {
      configured: false,
      allowedGuildIds: 0,
      allowedGuildIdValues: [],
      allowedChannelIds: 0,
      allowedChannelIdValues: [],
      allowedThreadIds: null,
      allowedThreadIdValues: null,
      allowedDmUserIds: null,
      allowedDmUserIdValues: null,
      defaultAgent: null,
      feedbackEnabled: null,
    },
  });
  vi.mocked(fetchSchedulerSettings).mockResolvedValue({
    available: true,
    value: {
      present: true,
      legacyMasterGate: "absent",
      automation: { inboxTasks: false, agentCron: false, scriptCron: false },
      deviceIdConfigured: false,
      pollIntervalSeconds: null,
      staleAfterSeconds: null,
      maxConcurrentAgents: null,
      deviceId: null,
      agentScope: { inboxTasks: null, agentCron: null, scriptCron: null },
    },
    runnableAgents: ["kimi", "dipu"],
    agentScopeWarnings: [],
  });
  vi.mocked(fetchAgentPreferences).mockResolvedValue({
    available: true,
    value: {
      model: { id: "anthropic/claude-sonnet-4-6", thinking: "high" },
      modelFallback: { declared: false, autoSwitch: true, modelCount: 0, models: [] },
      contextInjection: { mode: "per_turn" },
      selfImprovement: { autoNudge: false, reviewLoopEnabled: false, reviewLoop: { intervalTurns: null, recentMessages: null, timeoutMs: null } },
    },
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
});

describe("every rendered Workbench button has a decorative SVG icon (WUX-A)", () => {
  it("SettingsView tabs and help triggers (ST-2A correction)", async () => {
    const props = { token: "t", onUnauthorized: () => {}, onValidated: () => {} };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await mount(createElement(SettingsView, props));
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons.length).toBeGreaterThan(0);
    // The three tabs are among the rendered buttons.
    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.length).toBe(3);
    const unadorned = buttons.filter((button) => !buttonHasVisibleIcon(button));
    const described = unadorned.map((button) => `<${button.className}>${button.textContent?.slice(0, 40) ?? ""}</>`);
    expect(described, "buttons without a decorative icon").toEqual([]);
  });


  it("DashboardView ready surface", async () => {
    await mount(
      createElement(DashboardView, {
        token: "t",
        onUnauthorized: () => {},
        onValidated: () => {},
        onOpenConversation: () => {},
        reloadKey: 0,
      }),
    );
    await flush();
    // Open the assign-task modal too so its inner buttons are covered here.
    await act(async () => {
      agentCard().click();
    });
    await act(async () => {
      assignButton().click();
    });
    await flush();
    expectEveryButtonHasIcon("DashboardView");
    expectNoEmDash("DashboardView");
  });

  it("Sidebar navigation and conversation entries", async () => {
    await mount(sidebarElement());
    await flush();
    expectEveryButtonHasIcon("Sidebar");
    expectNoEmDash("Sidebar");
  });

  it("SplitWorkspaceShell mobile pane toggles", async () => {
    await mount(
      createElement(SplitWorkspaceShell, {
        state: { open: true, mobilePane: "chat", chatHeightPx: null },
        onStateChange: () => {},
        chat: createElement("div"),
        companion: createElement("div"),
        resizerLabel: "Resize chat pane",
        chatLabel: "Chat",
        companionLabel: "Vault Explorer",
        onReAnchor: () => {},
      }),
    );
    expectEveryButtonHasIcon("SplitWorkspaceShell");
    expectNoEmDash("SplitWorkspaceShell");
  });

  it("ConversationComposer upload and submit-policy controls", async () => {
    await mount(composerElement());
    await flush();
    expectEveryButtonHasIcon("ConversationComposer");
    expectNoEmDash("ConversationComposer");
  });

  it("AssignTaskModal dialog controls", async () => {
    await mount(
      createElement(AssignTaskModal, {
        agent: "dipu",
        onAssign: async () => {},
        onClose: () => {},
      }),
    );
    expectEveryButtonHasIcon("AssignTaskModal");
    expectNoEmDash("AssignTaskModal");
  });

  it("ConversationTimeline error Retry control", async () => {
    vi.mocked(fetchConversationEvents).mockRejectedValue(new Error("history unavailable"));
    await mount(timelineElement());
    await flush();
    expectEveryButtonHasIcon("ConversationTimeline");
    expectNoEmDash("ConversationTimeline");
  });

  it("VaultExplorer listing and document views", async () => {
    await mount(explorerElement());
    await flush();
    expectEveryButtonHasIcon("VaultExplorer listing");
    expectNoEmDash("VaultExplorer listing");
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".vault-explorer-entry")?.click();
    });
    await flush();
    expect(container.querySelector(".vault-explorer-back")).not.toBeNull();
    expectEveryButtonHasIcon("VaultExplorer document");
    expectNoEmDash("VaultExplorer document");
  });

  it("typed Settings forms save controls", async () => {
    const props = { token: "t", onUnauthorized: () => {}, onValidated: () => {} };
    const surfaces: Array<[string, ReactElement]> = [
      ["TelegramSettingsForm", createElement(TelegramSettingsForm, props)],
      ["DiscordSettingsForm", createElement(DiscordSettingsForm, props)],
      ["SchedulerSettingsForm", createElement(SchedulerSettingsForm, props)],
      ["AgentPreferencesForm", createElement(AgentPreferencesForm, props)],
    ];
    for (const [name, element] of surfaces) {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      await mount(element);
      if (name === "AgentPreferencesForm") {
        // ST-3: save controls appear only after a roster radio card is chosen.
        await act(async () => {
          const radio = container.querySelector<HTMLInputElement>('input[name="settings-agent-roster"]');
          if (radio === null) throw new Error("agent radio missing");
          radio.click();
        });
        await flush();
      }
      expectEveryButtonHasIcon(name);
      expectNoEmDash(name);
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });
});

function agentCard(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('[data-agent="dipu"]');
  if (el === null) throw new Error("agent card missing");
  return el;
}

function assignButton(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(".dashboard-assign");
  if (el === null) throw new Error("assign button missing");
  return el;
}

function sidebarElement(): ReactElement {
  return createElement(Sidebar, {
    page: "conversations",
    token: "t",
    onSelect: () => {},
    onValidated: () => {},
    onUnauthorized: () => {},
    conversationsReloadKey: 0,
    explorerOpen: false,
    onToggleExplorer: () => {},
    explorerToggleRef: { current: null },
    onOpenExplorerFullPage: () => {},
  });
}

function composerElement(): ReactElement {
  return createElement(ConversationComposer, {
    conversationId: "c1",
    token: "t",
    agents: ROSTER.agents,
    onUnauthorized: () => {},
    onAnnounce: () => {},
  });
}

function timelineElement(): ReactElement {
  return createElement(ConversationTimeline, {
    conversationId: "c1",
    token: "t",
    live: false,
    onUnauthorized: () => {},
  });
}

function explorerElement(): ReactElement {
  return createElement(VaultExplorer, {
    token: "t",
    onUnauthorized: () => {},
    onValidated: () => {},
  });
}
