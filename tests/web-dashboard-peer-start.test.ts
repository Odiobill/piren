// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DashboardView } from "../web/src/DashboardView.js";
import {
  PeerStartAmbiguousError,
  UnauthorizedError,
  fetchConversationAgents,
  fetchServiceStatus,
  startPeerConversation,
} from "../web/src/api.js";

/**
 * P3.3 (workbench-ux-follow-up-design §1.5; accepted P2) — Dashboard peer-mode
 * integration: component-local labelled toggle; aria-pressed membership
 * cards; Start peer conversation gated to 2–8 distinct selections with one
 * in-flight request; truthful busy/error/success (no attention/run claims);
 * definitive 4xx = explicit fresh retry only; ambiguous failure = refresh-
 * only recovery through the narrow shell callback; single-agent + T1 controls
 * hidden in peer mode and restored exactly when it is off.
 */

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchConversationAgents: vi.fn(),
    fetchServiceStatus: vi.fn(),
    startPeerConversation: vi.fn(),
  };
});

const ROSTER = {
  agents: [
    { name: "dipu", online: true, model: "anthropic/claude-opus-4.6" },
    { name: "kimi", online: true, model: "moonshotai/kimi-k2:high" },
    { name: "zora", online: true },
    { name: "offline-agent", online: false },
  ],
};

const SERVICE_SNAPSHOT: import("../web/src/service-observation.js").ServiceStatusSnapshot = {
  observedAt: "2026-08-22T12:00:00.000Z",
  manager: "systemd-user",
  targets: [
    { target: "telegram", state: "inactive" },
    { target: "discord", state: "inactive" },
    { target: "scheduler", state: "not-installed" },
  ],
};

const PEER_CREATED = {
  conversation: {
    id: "c9",
    title: "Conversation with 2 agents",
    audience: ["dipu", "kimi"],
    status: "open",
    path: "collaboration/conversations/c9/index.md",
    createdBy: "steward",
    created: "2026-08-22T13:00:00.000Z",
    updated: "2026-08-22T13:00:00.000Z",
  },
  event: { id: "e1", conversationId: "c9", kind: "conversation_start_requested", created: "2026-08-22T13:00:01.000Z" },
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

function renderDashboard(overrides?: { onOpenConversation?: (id: string) => void }): { unauthorized: () => number; refreshed: () => number; opened: string[] } {
  let unauthorizedCalls = 0;
  let refreshCalls = 0;
  const opened: string[] = [];
  render(
    createElement(DashboardView, {
      token: "test-token",
      onUnauthorized: () => void unauthorizedCalls++,
      onValidated: () => {},
      onOpenConversation: overrides?.onOpenConversation ?? ((id: string) => opened.push(id)),
      onRefreshConversations: () => void refreshCalls++,
      reloadKey: 0,
    }),
  );
  return { unauthorized: () => unauthorizedCalls, refreshed: () => refreshCalls, opened };
}

function agentButton(name: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(`[data-agent="${name}"]`);
  if (el === null) throw new Error(`agent button missing: ${name}`);
  return el;
}

function peerToggle(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(".dashboard-peer-mode-toggle");
  if (el === null) throw new Error("peer mode toggle missing");
  return el;
}

function peerStartButton(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(".dashboard-peer-start");
  if (el === null) throw new Error("peer start button missing");
  return el;
}

async function enterPeerMode(): Promise<void> {
  await flush();
  act(() => {
    peerToggle().click();
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.mocked(fetchConversationAgents).mockReset();
  vi.mocked(fetchServiceStatus).mockReset();
  vi.mocked(startPeerConversation).mockReset();
  vi.mocked(fetchConversationAgents).mockResolvedValue(ROSTER);
  vi.mocked(fetchServiceStatus).mockResolvedValue(SERVICE_SNAPSHOT);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
});

describe("DashboardView peer mode (P3.3)", () => {
  it("toggles an explicitly labelled peer mode that hides single-agent and T1 controls and restores them when off", async () => {
    renderDashboard();
    await flush();
    // Default: single-agent controls present, peer toggle present and off.
    expect(container.querySelector(".dashboard-start")).not.toBeNull();
    expect(container.querySelector(".dashboard-assign")).not.toBeNull();
    expect(peerToggle().getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".dashboard-peer-start")).toBeNull();

    await enterPeerMode();
    expect(peerToggle().getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".dashboard-start")).toBeNull();
    expect(container.querySelector(".dashboard-assign")).toBeNull();
    expect(container.querySelector(".dashboard-peer-start")).not.toBeNull();

    act(() => {
      peerToggle().click();
    });
    expect(peerToggle().getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".dashboard-start")).not.toBeNull();
    expect(container.querySelector(".dashboard-assign")).not.toBeNull();
    expect(container.querySelector(".dashboard-peer-start")).toBeNull();
  });

  it("gates Start peer conversation to 2-8 distinct selections with accessible aria-pressed membership", async () => {
    renderDashboard();
    await enterPeerMode();
    expect(peerStartButton().disabled).toBe(true);
    act(() => {
      agentButton("dipu").click();
    });
    expect(peerStartButton().disabled).toBe(true);
    expect(agentButton("dipu").getAttribute("aria-pressed")).toBe("true");
    act(() => {
      agentButton("kimi").click();
    });
    expect(peerStartButton().disabled).toBe(false);
    act(() => {
      agentButton("kimi").click();
    });
    expect(agentButton("kimi").getAttribute("aria-pressed")).toBe("false");
    expect(peerStartButton().disabled).toBe(true);
    // Offline agents remain unselectable.
    expect(agentButton("offline-agent").disabled).toBe(true);
  });

  it("submits exactly {peers} once per request and opens the created Conversation with truthful success", async () => {
    const { opened } = renderDashboard();
    vi.mocked(startPeerConversation).mockResolvedValue(PEER_CREATED);
    await enterPeerMode();
    act(() => {
      agentButton("kimi").click();
      agentButton("dipu").click();
    });
    await act(async () => {
      peerStartButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(vi.mocked(startPeerConversation)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startPeerConversation)).toHaveBeenCalledWith(["dipu", "kimi"], "test-token");
    expect(opened).toEqual(["c9"]);
    // Success claims nothing about attention/runs; mode resets to single.
    const text = container.textContent ?? "";
    expect(text).not.toContain("contacted");
    expect(text).not.toContain("notified");
    expect(text).not.toContain("is running");
    expect(container.querySelector(".dashboard-start")).not.toBeNull();
    expect(container.querySelector(".dashboard-peer-start")).toBeNull();
  });

  it("allows only one in-flight peer start request", async () => {
    let release!: (value: typeof PEER_CREATED) => void;
    vi.mocked(startPeerConversation).mockImplementation(
      () =>
        new Promise<typeof PEER_CREATED>((resolve) => {
          release = resolve;
        }),
    );
    renderDashboard();
    await enterPeerMode();
    act(() => {
      agentButton("dipu").click();
      agentButton("kimi").click();
    });
    await act(async () => {
      peerStartButton().click();
    });
    expect(peerStartButton().disabled).toBe(true);
    act(() => {
      peerStartButton().click();
    });
    expect(vi.mocked(startPeerConversation)).toHaveBeenCalledTimes(1);
    await act(async () => {
      release(PEER_CREATED);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(vi.mocked(startPeerConversation)).toHaveBeenCalledTimes(1);
  });

  it("shows a definitive 4xx as a bounded error with explicit fresh retry only", async () => {
    vi.mocked(startPeerConversation).mockRejectedValueOnce(new Error("1 requested peer(s) are not in the local runnable set."));
    renderDashboard();
    await enterPeerMode();
    act(() => {
      agentButton("dipu").click();
      agentButton("kimi").click();
    });
    await act(async () => {
      peerStartButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("not in the local runnable set");
    await flush();
    expect(vi.mocked(startPeerConversation)).toHaveBeenCalledTimes(1);
    // A fresh explicit click retries with the same selection.
    vi.mocked(startPeerConversation).mockResolvedValueOnce(PEER_CREATED);
    await act(async () => {
      peerStartButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(vi.mocked(startPeerConversation)).toHaveBeenCalledTimes(2);
  });

  it("treats an ambiguous failure as refresh-only recovery through the narrow shell callback (no retry, no success claim)", async () => {
    const { refreshed } = renderDashboard();
    vi.mocked(startPeerConversation).mockRejectedValueOnce(new PeerStartAmbiguousError());
    await enterPeerMode();
    act(() => {
      agentButton("dipu").click();
      agentButton("kimi").click();
    });
    await act(async () => {
      peerStartButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(vi.mocked(startPeerConversation)).toHaveBeenCalledTimes(1);
    const refresh = container.querySelector<HTMLButtonElement>(".dashboard-peer-refresh");
    expect(refresh).not.toBeNull();
    expect(refresh?.textContent).toMatch(/refresh/i);
    act(() => {
      refresh?.click();
    });
    await flush();
    expect(refreshed()).toBe(1);
    expect(vi.mocked(startPeerConversation)).toHaveBeenCalledTimes(1);
  });

  it("routes a 401 to the shell auth-recovery callback", async () => {
    const { unauthorized } = renderDashboard();
    vi.mocked(startPeerConversation).mockRejectedValueOnce(new UnauthorizedError());
    await enterPeerMode();
    act(() => {
      agentButton("dipu").click();
      agentButton("kimi").click();
    });
    await act(async () => {
      peerStartButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(unauthorized()).toBe(1);
  });
});
