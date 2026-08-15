// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConversationNavigator } from "../web/src/ConversationNavigator.js";
import { approveConversationApproval, attachConversation, fetchConversation, fetchConversationAgents } from "../web/src/api.js";

/**
 * ADR-0044 Tracer B correction — the bounded accessible approval pager. With
 * multiple pending approvals the tray renders EXACTLY ONE selected card plus
 * an accessible ordinal navigator; every pending approval stays in memory
 * and keyboard-reachable; a new arrival becomes selected with the existing
 * focus-on-arrival; manual navigation keeps focus on the pager button; an
 * answered card is removed via the existing exact route behavior and a
 * deterministic remaining card is selected. Nothing is dropped, persisted,
 * auto-responded, or reordered.
 */

const CONVERSATION = {
  id: "c1",
  title: "Conversation with dipu",
  audience: ["dipu"],
  status: "open",
  path: "collaboration/conversations/c1/index.md",
  createdBy: "steward",
  created: "2026-08-15T13:00:00.000Z",
  updated: "2026-08-15T13:00:00.000Z",
};

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchConversationAgents: vi.fn(),
    fetchConversation: vi.fn(),
    attachConversation: vi.fn(),
    approveConversationApproval: vi.fn(),
  };
});

let timelineProps: Record<string, unknown> = {};
vi.mock("../web/src/ConversationTimeline.js", () => ({
  ConversationTimeline: (props: Record<string, unknown>) => {
    timelineProps = props;
    return createElement("div", { className: "mock-timeline" });
  },
}));
vi.mock("../web/src/ConversationComposer.js", () => ({
  ConversationComposer: () => createElement("div", { className: "mock-composer" }),
}));
vi.mock("../web/src/ConversationDetailsModal.js", () => ({
  ConversationDetailsModal: () => null,
  ConversationLifecycleControls: () => null,
}));

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function deliverApproval(requestId: string): void {
  const onApproval = timelineProps.onApproval as (approval: unknown) => void;
  onApproval({ conversationId: "c1", agent: "dipu", requestId, method: "confirm", payload: { title: "Proceed?" } });
}

function cards(): NodeListOf<HTMLElement> {
  return container.querySelectorAll<HTMLElement>(".approval-card");
}

function pagerStatus(): string {
  return container.querySelector(".approval-pager-status")?.textContent ?? "";
}

function pagerButton(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>(".approval-pager button")).find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  if (button === undefined) throw new Error(`pager button missing: ${label}`);
  return button;
}

function selectedConfirmButton(): HTMLElement | null {
  return container.querySelector<HTMLElement>(".approval-card .button-primary");
}

beforeEach(() => {
  vi.mocked(fetchConversationAgents).mockReset().mockResolvedValue({ agents: [{ name: "dipu", online: true }] });
  vi.mocked(fetchConversation).mockReset().mockResolvedValue(CONVERSATION);
  vi.mocked(attachConversation)
    .mockReset()
    .mockResolvedValue({ conversation: CONVERSATION, attached: true, gate: { ok: true, missing: [], malformed: [] } });
  vi.mocked(approveConversationApproval).mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  window.location.hash = "#conversation/c1";
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container.remove();
  window.location.hash = "";
});

async function mountActiveNavigator(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(ConversationNavigator, {
        token: "t",
        onUnauthorized: () => {},
        onValidated: () => {},
        onConversationsChanged: () => {},
      }),
    );
  });
  await flush();
}

describe("approval pager (ADR-0044 Tracer B correction)", () => {
  it("eight pending approvals render exactly ONE selected card with an ordinal navigator; the newest arrival is selected and focused", async () => {
    await mountActiveNavigator();
    for (let i = 1; i <= 8; i += 1) {
      await act(async () => deliverApproval(`req-${i}`));
    }
    // Exactly one card in the DOM (no hidden off-page cards), inside the tray.
    expect(cards()).toHaveLength(1);
    expect(container.querySelector(".interaction-tray .approval-card")).not.toBeNull();
    // The bounded ordinal navigator tells the truth about all eight.
    expect(pagerStatus()).toBe("Approval 8 of 8");
    // The selected (newest) card keeps focus-on-arrival.
    expect(document.activeElement).toBe(selectedConfirmButton());
    // Boundaries: Next is disabled at the last card, Previous is enabled.
    expect(pagerButton("Next approval").disabled).toBe(true);
    expect(pagerButton("Previous approval").disabled).toBe(false);
    // The navigator is a clearly labeled group.
    expect(container.querySelector(".approval-pager")?.getAttribute("aria-label")).toBe("Pending approval navigator");
  });

  it("all eight are keyboard-reachable via the pager; manual navigation keeps focus on the invoked button and respects boundaries", async () => {
    await mountActiveNavigator();
    for (let i = 1; i <= 8; i += 1) {
      await act(async () => deliverApproval(`req-${i}`));
    }
    const previous = pagerButton("Previous approval");
    // Keyboard operation: tab to the button (jsdom models this via focus()),
    // then activate it; focus must stay on the invoked control.
    for (let expected = 7; expected >= 1; expected -= 1) {
      previous.focus();
      await act(async () => {
        previous.click();
      });
      expect(pagerStatus()).toBe(`Approval ${expected} of 8`);
      expect(document.activeElement).toBe(previous);
      expect(cards()).toHaveLength(1);
    }
    // First card: Previous is disabled, Next is enabled.
    expect(pagerButton("Previous approval").disabled).toBe(true);
    const next = pagerButton("Next approval");
    expect(next.disabled).toBe(false);
    next.focus();
    await act(async () => {
      next.click();
    });
    expect(pagerStatus()).toBe("Approval 2 of 8");
    expect(document.activeElement).toBe(next);
    // The card never stole focus during manual navigation.
    expect(container.querySelectorAll(".approval-card")).toHaveLength(1);
  });

  it("a new arrival while reviewing an earlier card becomes selected and focused", async () => {
    await mountActiveNavigator();
    for (let i = 1; i <= 3; i += 1) {
      await act(async () => deliverApproval(`req-${i}`));
    }
    const previous = pagerButton("Previous approval");
    previous.focus();
    await act(async () => {
      previous.click();
    });
    expect(pagerStatus()).toBe("Approval 2 of 3");
    await act(async () => deliverApproval("req-4"));
    expect(pagerStatus()).toBe("Approval 4 of 4");
    expect(document.activeElement).toBe(selectedConfirmButton());
  });

  it("answering the selected card removes only it, selects a deterministic remaining card, and never duplicates a response", async () => {
    await mountActiveNavigator();
    for (let i = 1; i <= 8; i += 1) {
      await act(async () => deliverApproval(`req-${i}`));
    }
    expect(pagerStatus()).toBe("Approval 8 of 8");
    const confirm = selectedConfirmButton();
    expect(confirm).not.toBeNull();
    await act(async () => {
      confirm!.click();
    });
    await flush();
    // The exact route was called once for the selected card only.
    expect(vi.mocked(approveConversationApproval)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(approveConversationApproval)).toHaveBeenCalledWith("c1", "dipu", "req-8", { confirmed: true }, "t");
    // The deterministic remaining card (clamped: the new last) is selected.
    expect(pagerStatus()).toBe("Approval 7 of 7");
    expect(cards()).toHaveLength(1);
    // No duplicate response was issued for the replacement.
    expect(vi.mocked(approveConversationApproval)).toHaveBeenCalledTimes(1);
  });

  it("a single pending approval renders one card with NO pager (existing one-card behavior)", async () => {
    await mountActiveNavigator();
    await act(async () => deliverApproval("req-1"));
    expect(cards()).toHaveLength(1);
    expect(container.querySelector(".approval-pager")).toBeNull();
    expect(document.activeElement).toBe(selectedConfirmButton());
  });
});
