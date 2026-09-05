// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement, createRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConversationNavigator } from "../web/src/ConversationNavigator.js";
import { ConversationDetailsModal, ConversationLifecycleControls } from "../web/src/ConversationDetailsModal.js";
import { DashboardView } from "../web/src/DashboardView.js";
import type { ConversationRecord } from "../web/src/conversations.js";
import type { LifecycleActionError } from "../web/src/conversation-lifecycle.js";
import {
  attachConversation,
  fetchConversation,
  fetchConversationAgents,
  fetchConversationTelemetry,
  fetchServiceStatus,
} from "../web/src/api.js";

/**
 * Workbench action-icon slice: existing action buttons gain DECORATIVE icons
 * only — visible text, accessible names, keyboard/focus/reduced-motion
 * behavior, confirmation/gating/Retry semantics, and no new actions are all
 * preserved. Covers the telemetry Refresh control, generic Retry/error
 * Retry buttons, and the Conversation-details modal actions.
 */

const CONVERSATION: ConversationRecord = {
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
    fetchConversationTelemetry: vi.fn(),
    fetchServiceStatus: vi.fn(),
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
// NOTE: ConversationDetailsModal.js is deliberately NOT mocked here — this
// file renders the real modal/lifecycle controls directly. The navigator
// harness never opens the modal (detailsOpen stays false), so the real
// module is inert in the navigator tests.

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mountNavigator(): Promise<void> {
  root = createRoot(container);
  return act(async () => {
    root.render(
      createElement(ConversationNavigator, {
        token: "t",
        onUnauthorized: () => {},
        onValidated: () => {},
        onConversationsChanged: () => {},
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mountDashboard(): Promise<void> {
  root = createRoot(container);
  return act(async () => {
    root.render(
      createElement(DashboardView, {
        token: "t",
        onUnauthorized: () => {},
        onValidated: () => {},
        onOpenConversation: () => {},
        reloadKey: 0,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mountElement(element: ReactElement): Promise<void> {
  root = createRoot(container);
  return act(async () => {
    root.render(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Assert one button keeps its visible text + accessible name and gains a decorative icon. */
function expectDecoratedButton(button: HTMLButtonElement | null, expectedText: string, expectedName: string): void {
  expect(button).not.toBeNull();
  expect(button?.textContent).toContain(expectedText);
  expect(button?.getAttribute("aria-label")).toBe(expectedName);
  expect(button?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
}

beforeEach(() => {
  (Element.prototype as unknown as Record<string, unknown>).scrollTo = () => {};
  vi.mocked(fetchConversationAgents).mockReset();
  vi.mocked(fetchConversation).mockReset();
  vi.mocked(attachConversation).mockReset();
  vi.mocked(fetchConversationTelemetry).mockReset();
  vi.mocked(fetchServiceStatus).mockReset();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container.remove();
  window.location.hash = "";
});

describe("workbench action icons (decorative only)", () => {
  describe("telemetry Refresh", () => {
    it("keeps the visible Refresh text and accessible name and adds a decorative icon (control lives in the per-agent details popup)", async () => {
      window.location.hash = "#conversation/c1";
      vi.mocked(fetchConversationAgents).mockResolvedValue({ agents: [{ name: "dipu", online: true }] });
      vi.mocked(fetchConversation).mockResolvedValue(CONVERSATION);
      vi.mocked(attachConversation).mockResolvedValue({ conversation: CONVERSATION, attached: true, gate: { ok: true, missing: [], malformed: [] } });
      await mountNavigator();
      // The compact card row holds one card per agent; the decorated Refresh
      // control lives inside the card's details popup.
      const row = container.querySelector<HTMLElement>(".conversation-context-cards");
      expect(row).not.toBeNull();
      const card = row?.querySelector<HTMLButtonElement>('button[aria-label^="Dipu:"]') ?? null;
      expect(card).not.toBeNull();
      await act(async () => {
        card?.click();
      });
      await flush();
      const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog).not.toBeNull();
      const refresh = dialog?.querySelector<HTMLButtonElement>('[aria-label="Refresh context telemetry for Dipu"]') ?? null;
      expectDecoratedButton(refresh, "Refresh", "Refresh context telemetry for Dipu");
    });
  });

  describe("generic Retry / error Retry", () => {
    it("Dashboard load-error Retry keeps text and adds a decorative icon", async () => {
      vi.mocked(fetchConversationAgents).mockRejectedValue(new Error("boom"));
      await mountDashboard();
      const button = container.querySelector<HTMLButtonElement>(".card-error button");
      expect(button?.textContent).toContain("Retry");
      expect(button?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    });

    it("Dashboard observation Retry keeps text and adds a decorative icon", async () => {
      vi.mocked(fetchConversationAgents).mockResolvedValue({ agents: [{ name: "dipu", online: true }] });
      vi.mocked(fetchServiceStatus).mockRejectedValue(new Error("boom"));
      await mountDashboard();
      const button = container.querySelector<HTMLButtonElement>('button:not(.button-primary)');
      const observationRetry = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.includes("Retry service status"));
      expect(observationRetry?.textContent).toContain("Retry service status");
      expect(observationRetry?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    });

    it("navigator load-error Retry keeps text and adds a decorative icon", async () => {
      vi.mocked(fetchConversationAgents).mockRejectedValue(new Error("boom"));
      await mountNavigator();
      const button = container.querySelector<HTMLButtonElement>(".card-error button");
      expect(button?.textContent).toContain("Retry");
      expect(button?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    });
  });

  describe("Conversation-details modal actions", () => {
    function lifecycleError(): LifecycleActionError {
      return { kind: "conflict", message: "busy" };
    }

    it("Archive/Reopen/Confirm/Cancel/Retry keep text and accessible names and add decorative icons", async () => {
      const archiveRef = createRef<HTMLButtonElement | null>();
      const confirmRef = createRef<HTMLButtonElement | null>();
      const common = {
        archiveButtonRef: archiveRef,
        confirmArchiveRef: confirmRef,
        onArchiveRequest: () => {},
        onCancelArchive: () => {},
        onConfirmArchive: () => {},
        onReopen: () => {},
        onRetry: () => {},
      };
      // Open conversation: Archive (+ lifecycle error Retry).
      await mountElement(
        createElement(ConversationLifecycleControls, {
          status: "open",
          phase: "error",
          error: lifecycleError(),
          confirmingArchive: false,
          ...common,
        }),
      );
      const archive = container.querySelector<HTMLButtonElement>(".lifecycle-controls button");
      expect(archive?.textContent).toContain("Archive");
      expect(archive?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
      const retry = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === "Retry");
      expect(retry?.textContent).toContain("Retry");
      expect(retry?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
      // Confirmation card: Confirm archive + Cancel.
      await mountElement(
        createElement(ConversationLifecycleControls, {
          status: "open",
          phase: "idle",
          error: null,
          confirmingArchive: true,
          ...common,
        }),
      );
      const confirm = container.querySelector<HTMLButtonElement>(".confirmation-actions .button-primary");
      expect(confirm?.textContent).toContain("Confirm archive");
      expect(confirm?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
      const cancel = container.querySelector<HTMLButtonElement>(".confirmation-actions .button:not(.button-primary)");
      expect(cancel?.textContent).toContain("Cancel");
      expect(cancel?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
      // Archived: Reopen.
      await mountElement(
        createElement(ConversationLifecycleControls, {
          status: "archived",
          phase: "idle",
          error: null,
          confirmingArchive: false,
          ...common,
        }),
      );
      const reopen = container.querySelector<HTMLButtonElement>(".lifecycle-controls button");
      expect(reopen?.textContent).toContain("Reopen");
      expect(reopen?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    });

    it("modal Save/Cancel keep text and accessible names and add decorative icons", async () => {
      await mountElement(
        createElement(ConversationDetailsModal, {
          conversation: CONVERSATION,
          agents: [],
          lifecyclePhase: "idle",
          lifecycleError: null,
          confirmingArchive: false,
          archiveButtonRef: createRef<HTMLButtonElement | null>(),
          confirmArchiveRef: createRef<HTMLButtonElement | null>(),
          onArchiveRequest: () => {},
          onCancelArchive: () => {},
          onConfirmArchive: () => {},
          onReopen: () => {},
          onLifecycleRetry: () => {},
          onRename: async () => null,
          onClose: () => {},
        }),
      );
      const save = container.querySelector<HTMLButtonElement>(".details-rename-actions .button-primary");
      expect(save?.textContent).toContain("Save");
      expect(save?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
      const cancel = container.querySelector<HTMLButtonElement>(".details-rename-actions .button:not(.button-primary)");
      expect(cancel?.textContent).toContain("Cancel");
      expect(cancel?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    });
  });
});
