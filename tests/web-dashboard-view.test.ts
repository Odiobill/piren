// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DashboardView } from "../web/src/DashboardView.js";
import { fetchConversationAgents, fetchConversations, startConversation } from "../web/src/api.js";

/**
 * ADR-0044 — Dashboard component behavior (jsdom): the default Workbench
 * surface. Roster only from GET /api/conversation-agents; conversations only
 * from GET /api/conversations; the steward explicitly selects one runnable
 * agent and submits exactly one `{agent}` start request. Offline means
 * local-policy non-runnable (never presence). Start controls are disabled
 * while that exact request is busy; errors remain visible and retry is only
 * an explicit fresh steward action. No storage, no polling, no focus theft.
 */

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchConversationAgents: vi.fn(),
    fetchConversations: vi.fn(),
    startConversation: vi.fn(),
  };
});

const ROSTER = {
  agents: [
    { name: "dipu", online: true },
    { name: "kimi", online: true },
    { name: "zora", online: false },
  ],
};

const CONVERSATIONS = {
  conversations: [
    {
      id: "c1",
      title: "Conversation with dipu",
      audience: ["dipu"],
      status: "open",
      path: "collaboration/conversations/c1/index.md",
      createdBy: "steward",
      created: "2026-08-15T13:00:00.000Z",
      updated: "2026-08-15T13:00:00.000Z",
    },
  ],
};

const STARTED = {
  conversation: CONVERSATIONS.conversations[0],
  event: { id: "e1", conversationId: "c1", kind: "conversation_start_requested", created: "2026-08-15T13:00:00.000Z" },
  dispatch: [{ agent: "dipu", status: "completed" }],
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

function renderDashboard(overrides?: { onOpenConversation?: (id: string) => void }): { opens: string[] } {
  const opens: string[] = [];
  render(
    createElement(DashboardView, {
      token: "test-token",
      onUnauthorized: () => {},
      onValidated: () => {},
      onOpenConversation: overrides?.onOpenConversation ?? ((id: string) => opens.push(id)),
      reloadKey: 0,
    }),
  );
  return { opens };
}

function startButton(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(".dashboard-start");
  if (el === null) throw new Error("start button missing");
  return el;
}

function agentButton(name: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(`[data-agent="${name}"]`);
  if (el === null) throw new Error(`agent button missing: ${name}`);
  return el;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.mocked(fetchConversationAgents).mockReset();
  vi.mocked(fetchConversations).mockReset();
  vi.mocked(startConversation).mockReset();
  vi.mocked(fetchConversationAgents).mockResolvedValue(ROSTER);
  vi.mocked(fetchConversations).mockResolvedValue(CONVERSATIONS);
  vi.mocked(startConversation).mockResolvedValue(STARTED as never);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
});

describe("DashboardView (ADR-0044)", () => {
  it("shows a truthful loading state and then the roster and conversations from the two existing reads", async () => {
    renderDashboard();
    expect(container.textContent).toContain("Loading");
    await flush();
    expect(vi.mocked(fetchConversationAgents)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchConversations)).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("dipu");
    expect(container.textContent).toContain("kimi");
    expect(container.textContent).toContain("zora");
    expect(container.textContent).toContain("Conversation with dipu");
  });

  it("marks offline agents as not runnable (local policy, never presence) and blocks their selection", async () => {
    renderDashboard();
    await flush();
    const offline = agentButton("zora");
    expect(offline.disabled).toBe(true);
    expect(container.textContent).toContain("Not runnable on this installation");
    // The offline agent cannot be selected, so no start can target it.
    await act(async () => {
      offline.click();
    });
    expect(vi.mocked(startConversation)).not.toHaveBeenCalled();
  });

  it("requires an explicit selection before start, then submits exactly one start for the selected agent", async () => {
    const { opens } = renderDashboard();
    await flush();
    // Nothing selected yet: the start control is disabled.
    expect(startButton().disabled).toBe(true);

    await act(async () => {
      agentButton("dipu").click();
    });
    expect(startButton().disabled).toBe(false);
    expect(agentButton("dipu").getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      startButton().click();
    });
    expect(vi.mocked(startConversation)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startConversation)).toHaveBeenCalledWith("test-token", "dipu");
    // Successful start navigates through the existing conversation route.
    expect(opens).toEqual(["c1"]);
  });

  it("disables the start control while that exact request is busy", async () => {
    let release: (() => void) | undefined;
    vi.mocked(startConversation).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(STARTED as never);
        }),
    );
    renderDashboard();
    await flush();
    await act(async () => {
      agentButton("kimi").click();
    });
    act(() => {
      startButton().click();
    });
    // Busy: the start control is disabled and no second request can fire.
    expect(startButton().disabled).toBe(true);
    act(() => {
      startButton().click();
    });
    expect(vi.mocked(startConversation)).toHaveBeenCalledTimes(1);
    await act(async () => {
      release?.();
    });
    await flush();
  });

  it("keeps a start error visible and retries only on an explicit fresh action", async () => {
    vi.mocked(startConversation).mockRejectedValueOnce(new Error("Agent 'dipu' is not in the local runnable set."));
    renderDashboard();
    await flush();
    await act(async () => {
      agentButton("dipu").click();
    });
    await act(async () => {
      startButton().click();
    });
    const error = container.querySelector("[role='alert']");
    expect(error?.textContent).toContain("not in the local runnable set");
    // No automatic retry happened.
    expect(vi.mocked(startConversation)).toHaveBeenCalledTimes(1);

    // An explicit fresh click retries.
    vi.mocked(startConversation).mockResolvedValue(STARTED as never);
    await act(async () => {
      startButton().click();
    });
    expect(vi.mocked(startConversation)).toHaveBeenCalledTimes(2);
  });

  it("shows a truthful load error with an explicit Retry and steals no focus", async () => {
    vi.mocked(fetchConversations).mockRejectedValueOnce(new Error("gateway unavailable"));
    renderDashboard();
    await flush();
    expect(container.textContent).toContain("gateway unavailable");
    expect(document.activeElement).toBe(document.body);

    vi.mocked(fetchConversations).mockResolvedValue(CONVERSATIONS);
    const retry = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Retry");
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.click();
    });
    await flush();
    expect(container.textContent).toContain("dipu");
  });

  it("shows truthful empty states for no roster and no conversations", async () => {
    vi.mocked(fetchConversationAgents).mockResolvedValue({ agents: [] });
    vi.mocked(fetchConversations).mockResolvedValue({ conversations: [] });
    renderDashboard();
    await flush();
    expect(container.textContent).toContain("No agents");
    expect(container.textContent).toContain("No conversations yet");
    expect(container.querySelector(".dashboard-start")).toBeNull();
  });

  it("opens an existing conversation through the existing route flow", async () => {
    const { opens } = renderDashboard();
    await flush();
    const entry = container.querySelector<HTMLButtonElement>("[data-conversation='c1']");
    expect(entry).not.toBeNull();
    await act(async () => {
      entry?.click();
    });
    expect(opens).toEqual(["c1"]);
    expect(vi.mocked(startConversation)).not.toHaveBeenCalled();
  });
});
