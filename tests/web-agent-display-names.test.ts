// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * 0.2.5 S6 — consistent Workbench agent display names (presentation only).
 *
 * Canonical lowercase agent identifiers remain the single source of truth in
 * React keys, input/select values, request bodies, mention insertion, and
 * state; every first-party visible/accessibility surface renders the
 * established conversationMemberTitle display form through the centralized
 * `agentDisplayName` helper. These tests pin BOTH sides: display formatting
 * and canonical interaction identity stay distinct.
 */
import { agentDisplayName } from "../web/src/agent-display.js";
import { conversationMemberTitle } from "../web/src/conversations.js";
import { conversationReactionForEvent } from "../web/src/conversation-reactions.js";
import { conversationStartOriginPresentation } from "../web/src/conversation-transcript.js";
import {
  conversationActivityRunAbortLabel,
  conversationActivityLiveAnnouncement,
} from "../web/src/conversation-activity.js";
import { composeInterlockReason } from "../web/src/composer-interlock.js";
import { workflowStatusIndicator } from "../web/src/conversation-budget-status.js";
import {
  approvalRequestedAnnouncement,
  approvalResponseAnnouncement,
  handoffGateRequestedAnnouncement,
  conversationHandoffGateLabel,
} from "../web/src/conversation-controls.js";
import {
  conversationEventLabel,
  conversationHandoffEventLabel,
} from "../web/src/conversation-timeline.js";
import {
  formatConversationTelemetryEntry,
  applyConversationTelemetryFrame,
  emptyConversationTelemetryState,
} from "../web/src/conversation-telemetry.js";
import {
  contextCardsForSelection,
  telemetryPopupViewModel,
} from "../web/src/conversation-context-cards.js";
import { applyMentionCompletion } from "../web/src/conversation-autocomplete.js";
import { copyMessageAccessibleName } from "../web/src/conversation-copy-message.js";
import { stageFallbackCandidate } from "../web/src/groups-fallback.js";
import {
  fetchConversationAgents,
  fetchConversations,
  fetchServiceStatus,
  startConversation,
} from "../web/src/api.js";
import { DashboardView } from "../web/src/DashboardView.js";
import { ParticipantPicker } from "../web/src/ParticipantPicker.js";

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

describe("agentDisplayName (centralized presentation-only helper)", () => {
  it("title-cases lowercase-kebab agent identifiers", () => {
    expect(agentDisplayName("dipu")).toBe("Dipu");
    expect(agentDisplayName("piren-agent")).toBe("Piren Agent");
    expect(agentDisplayName("a-b-c")).toBe("A B C");
    expect(agentDisplayName("agent0")).toBe("Agent0");
    expect(agentDisplayName("")).toBe("");
  });

  it("keeps the established conversationMemberTitle behavior (single implementation)", () => {
    for (const name of ["dipu", "piren-agent", "a-b-c", "agent0", ""]) {
      expect(agentDisplayName(name)).toBe(conversationMemberTitle(name));
    }
  });

  it("never mutates the canonical identifier it formats", () => {
    const canonical = "dipu";
    agentDisplayName(canonical);
    expect(canonical).toBe("dipu");
  });
});

describe("pure presentation cores render display names while identity stays canonical", () => {
  it("U5 reaction labels display the agent name; the durable attribution field stays canonical", () => {
    const started = conversationReactionForEvent({
      kind: "run_started",
      runAgent: "dipu",
    } as never);
    expect(started).not.toBeNull();
    expect(started?.agent).toBe("dipu");
    expect(started?.label).toBe("Dipu received");

    const finished = conversationReactionForEvent({
      kind: "run_finished",
      runAgent: "piren-agent",
      runStatus: "completed",
    } as never);
    expect(finished?.agent).toBe("piren-agent");
    expect(finished?.label).toBe("Piren Agent completed");
  });

  it("D5 start-origin label displays the agent name over the exact durable shape only", () => {
    const presentation = conversationStartOriginPresentation({
      kind: "conversation_start_requested",
      authorKind: "system",
      author: "system",
      body: "The steward requested starting this conversation with agent 'piren-agent'.",
    } as never);
    expect(presentation).toEqual({ label: "Conversation started with agent Piren Agent" });

    // A non-system lookalike keeps its fail-safe null.
    expect(
      conversationStartOriginPresentation({
        kind: "conversation_start_requested",
        authorKind: "agent",
        author: "dipu",
        body: "The steward requested starting this conversation with agent 'dipu'.",
      } as never),
    ).toBeNull();
  });

  it("activity abort label and live announcements display the agent name", () => {
    expect(conversationActivityRunAbortLabel("dipu")).toBe("Abort Dipu's current work");
    expect(conversationActivityLiveAnnouncement([], [{ runId: "r1", agent: "dipu", phase: "working" }])).toBe(
      "Dipu is working…",
    );
    expect(conversationActivityLiveAnnouncement([{ runId: "r1", agent: "dipu", phase: "typing" }], [])).toBe(
      "Dipu is no longer working",
    );
  });

  it("composer interlock reason displays the agent name", () => {
    expect(composeInterlockReason({ activeRuns: [{ agent: "dipu", phase: "working" }], approvals: [] })).toBe(
      "Dipu is working…",
    );
  });

  it("workflow-budget indicator accessible text displays the agent name", () => {
    const busy = workflowStatusIndicator("dipu", { runActive: true, workflow: null }, true);
    expect(busy.accessibleText).toBe("Dipu is currently running");

    const exhausted = workflowStatusIndicator(
      "piren-agent",
      { runActive: true, workflow: { effectiveEdges: 4, consumedEdges: 4, low: true, exhausted: true } },
      true,
    );
    expect(exhausted.accessibleText).toBe(
      "Workflow budget exhausted for Piren Agent's associated workflow; open Context telemetry to extend",
    );
  });

  it("approval and handoff labels display agent names (source and target)", () => {
    expect(approvalRequestedAnnouncement({ agent: "dipu" } as never)).toBe("Approval requested by Dipu.");
    expect(approvalResponseAnnouncement("dipu")).toBe("Approval response sent to Dipu.");
    expect(handoffGateRequestedAnnouncement({ agent: "dipu" } as never, { to: "piren-agent", text: "x" })).toBe(
      "Handoff gate requested by Dipu to Piren Agent.",
    );
    expect(conversationHandoffGateLabel({ to: "piren-agent", text: "x" }, "dipu")).toBe(
      "handoff from Dipu to Piren Agent",
    );
  });

  it("event evidence labels display the author agent name", () => {
    expect(conversationHandoffEventLabel({ author: "dipu", addressedAgent: "piren-agent" } as never)).toBe(
      "handoff from Dipu to Piren Agent",
    );
    expect(conversationEventLabel({ kind: "agent_message", author: "dipu" } as never)).toBe("Dipu replied");
    expect(conversationEventLabel({ kind: "run_started", author: "dipu", runStatus: undefined } as never)).toBe(
      "run started for Dipu (running)",
    );
  });

  it("telemetry entry lines display the agent name", () => {
    const line = formatConversationTelemetryEntry({ kind: "no-live", agent: "dipu" } as never);
    expect(line.text).toBe("Dipu · no live session");
    expect(line.ariaLabel).toBe("Dipu: no live session");
  });

  it("context cards and telemetry popup display the agent name", () => {
    const frame = {
      conversationId: "c1",
      agent: "dipu",
      runId: "run-0001",
      contextState: "ok",
      context: { tokens: 60000, contextWindow: 200000, percent: 30 },
      model: { provider: "anthropic", id: "claude-sonnet-4" },
      thinkingLevel: "high",
      autoCompactionEnabled: true,
    } as const;
    const state = applyConversationTelemetryFrame(emptyConversationTelemetryState(), frame as never);
    const cards = contextCardsForSelection({ phase: "active", audience: ["dipu"] }, state);
    expect(cards.length).toBe(1);
    // The card's identity key stays canonical; the accessible name displays.
    expect(cards[0]?.agent).toBe("dipu");
    expect(cards[0]?.accessibleName.startsWith("Dipu: ")).toBe(true);

    const popup = telemetryPopupViewModel("dipu", state.get("dipu"));
    expect(popup?.title).toBe("Context telemetry for Dipu");
    const agentLine = popup?.fields.find((field) => field.label === "Agent");
    expect(agentLine?.value).toBe("Dipu");
  });

  it("copy and defensive fallback labels display names while their records stay canonical", () => {
    expect(copyMessageAccessibleName({ authorKind: "agent", author: "piren-agent" } as never)).toBe("Copy message from Piren Agent");
    expect(stageFallbackCandidate([], "piren-agent", "piren-agent")).toEqual({
      kind: "rejected",
      reason: "Piren Agent cannot be its own fallback.",
    });
  });

  it("mention completion keeps the CANONICAL insertion while the visible label may differ", () => {
    const applied = applyMentionCompletion("hi @di ", 7, 3, "dipu");
    expect(applied.text).toBe("hi @dipu ");
    expect(applied.caret).toBe("hi @dipu ".length);
  });
});

describe("DashboardView renders display names with canonical interaction identity", () => {
  const ROSTER = {
    agents: [{ name: "piren-agent", online: true, model: "anthropic/claude-opus-4.6" }],
  };
  const EMPTY = { conversations: [] };

  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.mocked(fetchConversationAgents).mockReset();
    vi.mocked(fetchConversations).mockReset();
    vi.mocked(fetchServiceStatus).mockReset();
    vi.mocked(fetchConversationAgents).mockResolvedValue(ROSTER as never);
    vi.mocked(fetchConversations).mockResolvedValue(EMPTY as never);
    vi.mocked(fetchServiceStatus).mockResolvedValue({
      observedAt: "2026-08-16T12:00:00.000Z",
      manager: "none",
      targets: [],
    } as never);
    vi.mocked(startConversation).mockImplementation(() => new Promise(() => {}));
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root !== null) {
      act(() => {
        root?.unmount();
        root = null;
      });
    }
    container?.remove();
    vi.restoreAllMocks();
  });

  it("renders participant names while preserving canonical checkbox identity", () => {
    root = createRoot(container);
    act(() => {
      root!.render(
        createElement(ParticipantPicker, {
          agents: [{ name: "piren-agent", online: true }],
          selected: new Set<string>(),
          onToggle: () => {},
        }),
      );
    });
    expect(container.querySelector(".agent-name")?.textContent).toBe("Piren Agent");
    expect(container.querySelector("input")?.id).toBe("participant-piren-agent");
  });

  it("renders the display name in the single-agent start progress copy", async () => {
    root = createRoot(container);
    act(() => {
      root!.render(
        createElement(DashboardView, {
          token: "test-token",
          onUnauthorized: () => {},
          onValidated: () => {},
          onOpenConversation: () => {},
          reloadKey: 0,
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const card = container.querySelector<HTMLButtonElement>('[data-agent="piren-agent"]')!;
    const start = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("Start conversation"),
    )!;
    act(() => card.click());
    act(() => start.click());
    expect(container.textContent).toContain("Preparing your conversation with Piren Agent.");
  });

  it("renders the display name while the card identity stays the canonical agent id", async () => {
    root = createRoot(container);
    act(() => {
      root!.render(
        createElement(DashboardView, {
          token: "test-token",
          onUnauthorized: () => {},
          onValidated: () => {},
          onOpenConversation: () => {},
          reloadKey: 0,
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const card = container.querySelector<HTMLButtonElement>('[data-agent="piren-agent"]');
    expect(card).not.toBeNull();
    const name = card?.querySelector(".agent-name");
    expect(name?.textContent).toBe("Piren Agent");
    // Canonical identity is untouched: the data attribute remains the id.
    expect(card?.getAttribute("data-agent")).toBe("piren-agent");
  });
});
