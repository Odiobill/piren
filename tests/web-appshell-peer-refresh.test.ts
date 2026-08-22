// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AppShell } from "../web/src/AppShell.js";
import { fetchConversationAgents, fetchConversations } from "../web/src/api.js";

/**
 * P3.3 — targeted shell coverage: the Dashboard's ambiguous-failure refresh
 * recovery travels through exactly the narrow AppShell callback that bumps
 * the sidebar's durable conversation-list read. Nothing else is refreshed.
 */

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchConversationAgents: vi.fn(),
    fetchConversations: vi.fn(),
  };
});

let dashboardProps: Record<string, unknown> = {};
vi.mock("../web/src/DashboardView.js", () => ({
  DashboardView: (props: Record<string, unknown>) => {
    dashboardProps = props;
    return createElement("div", { className: "mock-dashboard" });
  },
}));
vi.mock("../web/src/ConversationNavigator.js", () => ({
  ConversationNavigator: () => createElement("div", { className: "mock-navigator" }),
}));

vi.mocked(fetchConversationAgents).mockResolvedValue({ agents: [] });
vi.mocked(fetchConversations).mockResolvedValue({ conversations: [] });

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dashboardProps = {};
  vi.mocked(fetchConversationAgents).mockResolvedValue({ agents: [] });
  vi.mocked(fetchConversations).mockResolvedValue({ conversations: [] });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

describe("AppShell peer-start refresh callback (P3.3)", () => {
  it("wires onRefreshConversations so it re-reads the durable sidebar list exactly once", async () => {
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
    await flush();
    const initialReads = vi.mocked(fetchConversations).mock.calls.length;
    expect(typeof dashboardProps.onRefreshConversations).toBe("function");
    await act(async () => {
      (dashboardProps.onRefreshConversations as () => void)();
    });
    await flush();
    expect(vi.mocked(fetchConversations).mock.calls.length).toBe(initialReads + 1);
  });
});
