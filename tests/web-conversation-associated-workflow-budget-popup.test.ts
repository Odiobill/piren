// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return { ...actual, updateConversationWorkflowBudget: vi.fn() };
});
import { ConversationTelemetryPopup } from "../web/src/ConversationTelemetryPopup.js";
import { updateConversationWorkflowBudget, WorkflowBudgetHttpError } from "../web/src/api.js";
import type { ConversationWorkflowStatusSnapshot } from "../web/src/api.js";
import type { TelemetryPopupViewModel } from "../web/src/conversation-context-cards.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const VIEW: TelemetryPopupViewModel = {
  title: "Context telemetry for dipu",
  closeLabel: "Close context telemetry for dipu",
  refreshLabel: "Refresh context telemetry for dipu",
  stateKey: "not_sampled",
  stateText: "No context telemetry yet",
  bar: { kind: "neutral" },
  fields: [{ label: "Agent", value: "dipu" }],
};

const SNAPSHOT: ConversationWorkflowStatusSnapshot = {
  runActive: true,
  workflow: {
    rootEventId: "root-1",
    association: "active-run",
    base: { edges: 8, reworkRounds: 2 },
    effective: { edges: 10, reworkRounds: 3 },
    consumed: { edges: 8 },
    worstPairOccurrences: 3,
    low: true,
    exhausted: false,
    warnings: ["one ignored update"],
    omittedWarnings: 2,
  },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.mocked(updateConversationWorkflowBudget).mockReset().mockResolvedValue({
    status: "updated",
    effective: { edges: 12, reworkRounds: 3 },
  });
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("W5b associated workflow budget in Context telemetry popup", () => {
  it("renders only the gateway-associated workflow root, distinct from Context telemetry", async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(ConversationTelemetryPopup, {
          viewModel: VIEW,
          busy: false,
          error: null,
          onRefresh: vi.fn(),
          onClose: vi.fn(),
          workflowBudget: {
            conversationId: "c1",
            token: "t",
            snapshot: SNAPSHOT,
            onStatusReread: async () => true,
          },
        }),
      );
    });

    const section = container.querySelector<HTMLElement>(".associated-workflow-budget");
    expect(section?.querySelector("h3")?.textContent).toBe("Associated handoff workflow");
    expect(section?.textContent).toContain("Context telemetry is separate from this workflow-root budget.");
    expect(section?.textContent).toContain("Root");
    expect(section?.textContent).toContain("root-1");
    expect(section?.textContent).toContain("consumed 8 of 10 effective");
    expect(section?.textContent).toContain("Depth: 3 (fixed)");
    expect(section?.textContent).toContain("one ignored update");
  });

  it("posts the existing root-scoped CAS request then re-reads status without fetching on popup open", async () => {
    const onStatusReread = vi.fn(async () => true);
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(ConversationTelemetryPopup, {
          viewModel: VIEW,
          busy: false,
          error: null,
          onRefresh: vi.fn(),
          onClose: vi.fn(),
          workflowBudget: { conversationId: "c1", token: "t", snapshot: SNAPSHOT, onStatusReread },
        }),
      );
    });
    const input = container.querySelector<HTMLInputElement>('input[id^="associated-workflow-budget-edges-"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "12");
    input?.dispatchEvent(new Event("input", { bubbles: true }));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Save workflow budget for associated root root-1"]')?.click();
    });
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));

    expect(updateConversationWorkflowBudget).toHaveBeenCalledWith(
      "c1",
      { root_event_id: "root-1", edges: 12, expected_effective: { edges: 10, reworkRounds: 3 } },
      "t",
    );
    expect(onStatusReread).toHaveBeenCalledTimes(1);
  });

  it("never replays an accepted mutation when the status reread fails", async () => {
    const onStatusReread = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(ConversationTelemetryPopup, {
          viewModel: VIEW,
          busy: false,
          error: null,
          onRefresh: vi.fn(),
          onClose: vi.fn(),
          workflowBudget: { conversationId: "c1", token: "t", snapshot: SNAPSHOT, onStatusReread },
        }),
      );
    });
    const input = container.querySelector<HTMLInputElement>('input[id^="associated-workflow-budget-edges-"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "12");
    input?.dispatchEvent(new Event("input", { bubbles: true }));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Save workflow budget for associated root root-1"]')?.click();
    });
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));

    expect(updateConversationWorkflowBudget).toHaveBeenCalledTimes(1);
    const alert = container.querySelector<HTMLElement>(".associated-workflow-budget-reload-error[role='alert']");
    expect(alert?.textContent).toContain("could not be re-read");
    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click();
    });
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    expect(updateConversationWorkflowBudget).toHaveBeenCalledTimes(1);
    expect(onStatusReread).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".associated-workflow-budget-reload-error")).toBeNull();
  });

  it("surfaces a bounded server rejection and retries only after an explicit gesture", async () => {
    vi.mocked(updateConversationWorkflowBudget).mockRejectedValueOnce(
      new WorkflowBudgetHttpError(400, "budget edges exceed the fixed cap"),
    );
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(ConversationTelemetryPopup, {
          viewModel: VIEW,
          busy: false,
          error: null,
          onRefresh: vi.fn(),
          onClose: vi.fn(),
          workflowBudget: { conversationId: "c1", token: "t", snapshot: SNAPSHOT, onStatusReread: async () => true },
        }),
      );
    });
    const input = container.querySelector<HTMLInputElement>('input[id^="associated-workflow-budget-edges-"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "99");
    input?.dispatchEvent(new Event("input", { bubbles: true }));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Save workflow budget for associated root root-1"]')?.click();
    });
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    const alert = container.querySelector<HTMLElement>(".associated-workflow-budget-error[role='alert']");
    expect(alert?.textContent).toContain("fixed cap");
    expect(updateConversationWorkflowBudget).toHaveBeenCalledTimes(1);
    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click();
    });
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    expect(updateConversationWorkflowBudget).toHaveBeenCalledTimes(2);
  });

  it("renders no workflow budget capability for a null exact-pair association", async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(ConversationTelemetryPopup, {
          viewModel: VIEW,
          busy: false,
          error: null,
          onRefresh: vi.fn(),
          onClose: vi.fn(),
          workflowBudget: { conversationId: "c1", token: "t", snapshot: { runActive: true, workflow: null }, onStatusReread: async () => true },
        }),
      );
    });
    expect(container.querySelector(".associated-workflow-budget")).toBeNull();
  });
});
