// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for one component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DashboardView } from "../web/src/DashboardView.js";
import {
  fetchConversationAgents,
  fetchServiceStatus,
  startConversation,
  startPeerConversation,
} from "../web/src/api.js";

/**
 * WUX-A: the Dashboard has ONE selection model by default. Agent cards are
 * membership toggles (aria-pressed). One visible Start conversation control
 * routes by cardinality: disabled for none, the exact existing single-agent
 * start path for exactly one, and the exact existing peer-start path for
 * 2-8. Assign task stays visible and is enabled only for exactly one
 * selected runnable agent. The separate "Start with multiple agents" mode
 * toggle is removed.
 */

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchConversationAgents: vi.fn(),
    fetchServiceStatus: vi.fn(),
    startConversation: vi.fn(),
    startPeerConversation: vi.fn(),
  };
});

const ROSTER = {
  agents: [
    { name: "dipu", online: true },
    { name: "kimi", online: true },
    { name: "zora", online: true },
    { name: "offline-agent", online: false },
  ],
};

const SINGLE_STARTED = {
  conversation: {
    id: "c1",
    title: "Conversation with dipu",
    audience: ["dipu"],
    status: "open",
    path: "collaboration/conversations/c1/index.md",
    createdBy: "steward",
    created: "2026-08-23T10:00:00.000Z",
    updated: "2026-08-23T10:00:00.000Z",
  },
  event: { id: "e1", conversationId: "c1", kind: "conversation_start_requested", created: "2026-08-23T10:00:01.000Z" },
};

const PEER_CREATED = {
  conversation: {
    id: "c9",
    title: "Conversation with 2 agents",
    audience: ["dipu", "kimi"],
    status: "open",
    path: "collaboration/conversations/c9/index.md",
    createdBy: "steward",
    created: "2026-08-23T10:00:00.000Z",
    updated: "2026-08-23T10:00:00.000Z",
  },
  event: { id: "e2", conversationId: "c9", kind: "conversation_start_requested", created: "2026-08-23T10:00:01.000Z" },
};

let container: HTMLDivElement;
let root: Root;

function render(element: ReactElement): void {
  root = createRoot(container);
  act(() => {
    root.render(element);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderDashboard(): { opened: string[] } {
  const opened: string[] = [];
  render(
    createElement(DashboardView, {
      token: "test-token",
      onUnauthorized: () => {},
      onValidated: () => {},
      onOpenConversation: (id: string) => opened.push(id),
      reloadKey: 0,
    }),
  );
  return { opened };
}

function agentButton(name: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(`[data-agent="${name}"]`);
  if (el === null) throw new Error(`agent button missing: ${name}`);
  return el;
}

function startButton(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(".dashboard-start");
  if (el === null) throw new Error("start button missing");
  return el;
}

function assignButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(".dashboard-assign");
}

function clickAgent(...names: string[]): void {
  act(() => {
    for (const name of names) agentButton(name).click();
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.mocked(fetchConversationAgents).mockReset();
  vi.mocked(fetchServiceStatus).mockReset();
  vi.mocked(startConversation).mockReset();
  vi.mocked(startPeerConversation).mockReset();
  vi.mocked(fetchConversationAgents).mockResolvedValue(ROSTER);
  vi.mocked(fetchServiceStatus).mockResolvedValue({
    observedAt: "2026-08-23T10:00:00.000Z",
    manager: "systemd-user",
    targets: [
      { target: "telegram", state: "inactive" },
      { target: "discord", state: "inactive" },
      { target: "scheduler", state: "not-installed" },
    ],
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
});

describe("DashboardView default multi-selection model (WUX-A)", () => {
  it("has no separate multi-selection mode toggle; cards are always membership toggles", async () => {
    renderDashboard();
    await flush();
    expect(container.querySelector(".dashboard-peer-mode-toggle")).toBeNull();
    clickAgent("dipu");
    expect(agentButton("dipu").getAttribute("aria-pressed")).toBe("true");
    clickAgent("kimi");
    expect(agentButton("dipu").getAttribute("aria-pressed")).toBe("true");
    expect(agentButton("kimi").getAttribute("aria-pressed")).toBe("true");
    clickAgent("dipu");
    expect(agentButton("dipu").getAttribute("aria-pressed")).toBe("false");
    expect(agentButton("kimi").getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps one visible Start conversation control, disabled until at least one runnable agent is selected", async () => {
    renderDashboard();
    await flush();
    expect(container.querySelector(".dashboard-peer-start")).toBeNull();
    expect(startButton().disabled).toBe(true);
    clickAgent("dipu");
    expect(startButton().disabled).toBe(false);
  });

  it("routes exactly one selection through the existing single-agent start path", async () => {
    const { opened } = renderDashboard();
    vi.mocked(startConversation).mockResolvedValue(SINGLE_STARTED);
    await flush();
    clickAgent("kimi");
    await act(async () => {
      startButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(vi.mocked(startConversation)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startConversation)).toHaveBeenCalledWith("test-token", "kimi");
    expect(vi.mocked(startPeerConversation)).not.toHaveBeenCalled();
    expect(opened).toEqual(["c1"]);
  });

  it("routes two selections through the existing peer-start path with sorted peers", async () => {
    const { opened } = renderDashboard();
    vi.mocked(startPeerConversation).mockResolvedValue(PEER_CREATED);
    await flush();
    clickAgent("kimi", "dipu");
    await act(async () => {
      startButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(vi.mocked(startPeerConversation)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startPeerConversation)).toHaveBeenCalledWith(["dipu", "kimi"], "test-token");
    expect(vi.mocked(startConversation)).not.toHaveBeenCalled();
    expect(opened).toEqual(["c9"]);
  });

  it("keeps Assign task visible with exact-one gating: disabled for none and for two selections", async () => {
    renderDashboard();
    await flush();
    const assign = assignButton();
    expect(assign).not.toBeNull();
    expect(assign?.disabled).toBe(true);
    clickAgent("dipu");
    expect(assignButton()?.disabled).toBe(false);
    clickAgent("kimi");
    expect(assignButton()?.disabled).toBe(true);
    // Back to exactly one via toggling membership off.
    clickAgent("kimi");
    expect(assignButton()?.disabled).toBe(false);
  });

  it("clears the selection after either successful start path", async () => {
    renderDashboard();
    vi.mocked(startConversation).mockResolvedValue(SINGLE_STARTED);
    await flush();
    clickAgent("dipu");
    await act(async () => {
      startButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(startButton().disabled).toBe(true);
    expect(agentButton("dipu").getAttribute("aria-pressed")).toBe("false");

    vi.mocked(startPeerConversation).mockResolvedValue(PEER_CREATED);
    clickAgent("dipu", "kimi");
    await act(async () => {
      startButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(startButton().disabled).toBe(true);
    expect(agentButton("dipu").getAttribute("aria-pressed")).toBe("false");
    expect(agentButton("kimi").getAttribute("aria-pressed")).toBe("false");
  });

  it("renders concise action-oriented Dashboard copy without obsolete one-agent-only or probe explanations", async () => {
    renderDashboard();
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("assign");
    expect(text.toLowerCase()).toContain("sidebar");
    expect(text).not.toContain("Choose one local agent below");
    expect(text).not.toContain("Online means runnable on this installation");
    expect(text).not.toContain("live presence or provider probe");
    expect(text).not.toContain("Start with multiple agents");
  });
});
