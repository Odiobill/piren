// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DashboardView } from "../web/src/DashboardView.js";
import { fetchConversationAgents, fetchConversations, fetchServiceStatus, startConversation } from "../web/src/api.js";

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
    fetchServiceStatus: vi.fn(),
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

// D2.3: the Dashboard's managed service observation read is mocked so these
// D1 tests stay hermetic; D2.3 behavior is pinned in
// tests/web-dashboard-service-observation.test.ts.
const SERVICE_SNAPSHOT: import("../web/src/service-observation.js").ServiceStatusSnapshot = {
  observedAt: "2026-08-16T12:00:00.000Z",
  manager: "systemd-user",
  targets: [
    { target: "telegram", state: "active" },
    { target: "discord", state: "inactive" },
    { target: "scheduler", state: "not-installed" },
  ],
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
  vi.mocked(fetchServiceStatus).mockReset();
  vi.mocked(startConversation).mockReset();
  vi.mocked(fetchConversationAgents).mockResolvedValue(ROSTER);
  vi.mocked(fetchConversations).mockResolvedValue(CONVERSATIONS);
  vi.mocked(fetchServiceStatus).mockResolvedValue(SERVICE_SNAPSHOT);
  vi.mocked(startConversation).mockResolvedValue(STARTED as never);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
});

describe("DashboardView (ADR-0044)", () => {
  it("shows a truthful loading state and then the roster from the existing roster read", async () => {
    renderDashboard();
    expect(container.textContent).toContain("Loading your agents");
    expect(container.textContent).not.toContain("conversations");
    await flush();
    expect(vi.mocked(fetchConversationAgents)).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("dipu");
    expect(container.textContent).toContain("kimi");
    expect(container.textContent).toContain("zora");
  });

  it("renders a welcoming header with the transparent Piren mark and a truthful sidebar pointer (D1)", async () => {
    renderDashboard();
    await flush();
    const welcome = container.querySelector(".dashboard-welcome");
    expect(welcome).not.toBeNull();
    const mark = welcome?.querySelector<HTMLImageElement>("img.dashboard-mark");
    expect(mark?.getAttribute("src") ?? "").toContain("piren-logo");
    // The pointer to the sidebar is truthful: it is the sole Conversation navigator.
    expect(container.textContent).toContain("sidebar");
  });

  it("renders the roster as reusable agent cards with bounded avatar/description slots (D1)", async () => {
    renderDashboard();
    await flush();
    expect(container.querySelector(".agent-card-grid")).not.toBeNull();
    expect(container.querySelectorAll(".agent-card").length).toBe(3);
    // Each card carries the bounded presentation slots while the selection
    // control keeps its accessible text name.
    const dipu = agentButton("dipu");
    const avatar = dipu.querySelector(".agent-card-avatar");
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");
    expect(avatar?.textContent).toBe("D");
    expect(dipu.querySelector(".agent-card-description")?.textContent).toContain("Runnable on this installation");
    const zora = agentButton("zora");
    expect(zora.querySelector(".agent-card-description")?.textContent).toContain("Not runnable on this installation");
  });

  it("has no duplicate Conversation navigation — the sidebar is the sole navigator (D1)", async () => {
    renderDashboard();
    await flush();
    // The Dashboard never issues its own conversation-list read anymore.
    expect(vi.mocked(fetchConversations)).not.toHaveBeenCalled();
    // No Dashboard conversation entries, list, or heading survive.
    expect(container.querySelector("[data-conversation]")).toBeNull();
    expect(container.querySelector(".dashboard-conversation-list")).toBeNull();
    expect(container.querySelector("#dashboard-conversations-heading")).toBeNull();
    expect(container.querySelector(".dashboard-conversation-entry")).toBeNull();
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

  it("labels the primary start action with a leading decorative icon and a stable text name (D1)", async () => {
    renderDashboard();
    await flush();
    const button = startButton();
    const icon = button.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(button.textContent).toBe("Start conversation");
  });

  it("shows a truthful pending busy line and never claims the agent is live (D1)", async () => {
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
    const busy = container.querySelector(".dashboard-start-busy");
    expect(busy).not.toBeNull();
    expect(busy?.getAttribute("role")).toBe("status");
    expect(busy?.textContent).toContain("Preparing your conversation with kimi");
    // Truthfulness: the pending line describes the submitted browser/gateway
    // operation only — never invented agent liveness.
    expect(busy?.textContent?.toLowerCase() ?? "").not.toMatch(/running|thinking|responding|working|online/);
    const dots = busy?.querySelector(".dashboard-busy-dots");
    expect(dots?.getAttribute("aria-hidden")).toBe("true");
    // The primary action keeps its stable accessible name and stays disabled.
    expect(startButton().textContent).toBe("Start conversation");
    expect(startButton().disabled).toBe(true);
    await act(async () => {
      release?.();
    });
    await flush();
    expect(container.querySelector(".dashboard-start-busy")).toBeNull();
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

  it("reports only truthful service facts from the successful authenticated read (D1)", async () => {
    renderDashboard();
    // Loading phase: no service claims yet.
    expect(container.querySelector(".dashboard-services")).toBeNull();
    await flush();
    const service = container.querySelector(".dashboard-services");
    expect(service).not.toBeNull();
    expect(service?.textContent).toContain("Gateway");
    expect(service?.textContent).toContain("Connected");
    // "Connected" means this Dashboard's authenticated read just succeeded —
    // configured/recorded service state is never presented as a live
    // process-health assertion.
    expect(service?.textContent?.toLowerCase() ?? "").not.toMatch(/running|healthy/);
  });

  it("shows a truthful load error with an explicit Retry and steals no focus", async () => {
    vi.mocked(fetchConversationAgents).mockRejectedValueOnce(new Error("gateway unavailable"));
    renderDashboard();
    await flush();
    expect(container.textContent).toContain("gateway unavailable");
    expect(document.activeElement).toBe(document.body);

    vi.mocked(fetchConversationAgents).mockResolvedValue(ROSTER);
    const retry = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Retry");
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.click();
    });
    await flush();
    expect(container.textContent).toContain("dipu");
  });

  it("shows a truthful empty state for an empty roster", async () => {
    vi.mocked(fetchConversationAgents).mockResolvedValue({ agents: [] });
    renderDashboard();
    await flush();
    expect(container.textContent).toContain("No agents");
    expect(container.querySelector(".dashboard-start")).toBeNull();
  });
});
