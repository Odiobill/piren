// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConversationNavigator } from "../web/src/ConversationNavigator.js";
import {
  abortConversationRun,
  approveConversationApproval,
  attachConversation,
  fetchConversation,
  fetchConversationAgents,
} from "../web/src/api.js";

/**
 * U1 — status-only live activity cards (0.2.0 amendment §6.1). The transient
 * broker-authoritative activity cards render as the FINAL transient content of
 * the selected active Conversation's existing `.conversation-history`,
 * immediately after the durable `ConversationTimeline`; they use the existing
 * scroll owner and REPLACE (never duplicate) the D4 tray activity row. Each
 * card carries exactly the agent label, the truthful `working…`/`typing…`
 * state, and the exact scoped conversation×agent abort action. Status-only:
 * no raw partial text, no tools/reasoning/reasons, no summary, no red badge,
 * no new polling/WebSocket/transport, no altered broker authority.
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
    abortConversationRun: vi.fn(),
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
  // The real composer owns a textarea with id conversation-message-<id>, which
  // is the focus-restore target when a focused activity abort disappears.
  ConversationComposer: (props: Record<string, unknown>) =>
    createElement("div", { className: "mock-composer" }, createElement("textarea", { id: `conversation-message-${props.conversationId as string}` })),
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

function deliverActivity(runs: Array<{ runId: string; agent: string; phase: "working" | "typing" }>): void {
  const onActivityChange = timelineProps.onActivityChange as ((runs: unknown) => void) | undefined;
  if (onActivityChange === undefined) throw new Error("onActivityChange not wired");
  onActivityChange(runs);
}

function cardsContainer(): HTMLElement | null {
  return container.querySelector<HTMLElement>(".conversation-activity-cards");
}

function historyRegion(): HTMLElement | null {
  return container.querySelector<HTMLElement>(".conversation-history");
}

function activityAnnouncement(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-activity-announcement="true"]');
}

beforeEach(() => {
  (Element.prototype as unknown as Record<string, unknown>).scrollTo = () => {};
  vi.mocked(fetchConversationAgents).mockReset().mockResolvedValue({ agents: [{ name: "dipu", online: true }, { name: "zai", online: true }] });
  vi.mocked(fetchConversation).mockReset().mockResolvedValue(CONVERSATION);
  vi.mocked(attachConversation)
    .mockReset()
    .mockResolvedValue({ conversation: CONVERSATION, attached: true, gate: { ok: true, missing: [], malformed: [] } });
  vi.mocked(approveConversationApproval).mockReset().mockResolvedValue(undefined);
  vi.mocked(abortConversationRun).mockReset().mockResolvedValue({ status: "cancelled" });
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

async function mountNavigator(): Promise<void> {
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

describe("U1 status-only activity cards", () => {
  it("renders cards as the final transient content of .conversation-history after the durable timeline, and removes the D4 tray row", async () => {
    await mountNavigator();
    await act(async () =>
      deliverActivity([
        { runId: "r1", agent: "dipu", phase: "working" },
        { runId: "r2", agent: "zai", phase: "typing" },
      ]),
    );
    await flush();

    const history = historyRegion();
    const cards = cardsContainer();
    expect(history).not.toBeNull();
    expect(cards).not.toBeNull();
    // Inside the history region, immediately after the durable timeline.
    expect(cards?.parentElement).toBe(history);
    const children = history !== null ? Array.from(history.children) : [];
    expect(children.findIndex((child) => child.className === "mock-timeline")).toBeGreaterThanOrEqual(0);
    expect(children.findIndex((child) => child.className.includes("conversation-activity-cards"))).toBeGreaterThan(
      children.findIndex((child) => child.className === "mock-timeline"),
    );
    // The card container directly follows the durable timeline and is the
    // final transient history child; the polite live region cannot interpose.
    expect(cards?.previousElementSibling?.className).toBe("mock-timeline");
    expect(history?.lastElementChild).toBe(cards);
    // The D4 tray activity row is removed (never duplicated in the tray).
    expect(container.querySelector(".interaction-tray .conversation-activity-row")).toBeNull();
    expect(container.querySelector(".interaction-tray .dock-run-status")).toBeNull();
    // Exactly one cards container for all runs.
    expect(container.querySelectorAll(".conversation-activity-cards")).toHaveLength(1);
  });

  it("each card is status-only: agent label, truthful working/typing state, and the exact scoped abort action (no partial/delta/tools/reasons)", async () => {
    await mountNavigator();
    await act(async () =>
      deliverActivity([
        { runId: "r1", agent: "dipu", phase: "working" },
        { runId: "r2", agent: "zai", phase: "typing" },
      ]),
    );
    await flush();

    const cards = cardsContainer();
    expect(cards?.textContent).toContain("Dipu");
    expect(cards?.textContent).toContain("is working…");
    expect(cards?.textContent).toContain("Zai");
    expect(cards?.textContent).toContain("is typing…");
    // The exact scoped abort action, with the U1 pinned label.
    expect(cards?.querySelector('[aria-label="Abort Dipu\'s current work"]')).not.toBeNull();
    expect(cards?.querySelector('[aria-label="Abort Zai\'s current work"]')).not.toBeNull();
    // Status-only: no raw partial text, no tool/reasoning/thinking labels.
    expect(cards?.textContent).not.toContain("Hel");
    expect(cards?.textContent).not.toContain("tool");
    expect(cards?.textContent).not.toContain("reasoning");
  });

  it("preserves the exact abort busy/error/manual-retry semantics in the card", async () => {
    let release: (() => void) | undefined;
    vi.mocked(abortConversationRun).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: "cancelled" });
        }),
    );
    await mountNavigator();
    await act(async () => deliverActivity([{ runId: "r1", agent: "dipu", phase: "working" }]));
    await flush();
    const abort = cardsContainer()?.querySelector<HTMLButtonElement>('[aria-label="Abort Dipu\'s current work"]');
    expect(abort).toBeDefined();
    act(() => {
      abort?.click();
    });
    expect(vi.mocked(abortConversationRun)).toHaveBeenCalledWith("c1", "dipu", "t");
    expect(cardsContainer()?.querySelector<HTMLButtonElement>('[aria-label="Abort Dipu\'s current work"]')?.disabled).toBe(true);
    await act(async () => {
      release?.();
    });
    await flush();

    vi.mocked(abortConversationRun).mockRejectedValueOnce(new Error("abort HTTP 500"));
    await act(async () => {
      cardsContainer()?.querySelector<HTMLButtonElement>('[aria-label="Abort Dipu\'s current work"]')?.click();
    });
    await flush();
    const error = cardsContainer()?.querySelector("[role='alert']");
    expect(error?.textContent).toContain("abort HTTP 500");
    expect(vi.mocked(abortConversationRun)).toHaveBeenCalledTimes(2);
  });

  it("renders no cards with no runs, after cleanup, and never on read-only inspection", async () => {
    await mountNavigator();
    await flush();
    expect(cardsContainer()).toBeNull();

    await act(async () => deliverActivity([{ runId: "r1", agent: "dipu", phase: "working" }]));
    await flush();
    expect(cardsContainer()).not.toBeNull();

    await act(async () => deliverActivity([]));
    await flush();
    expect(cardsContainer()).toBeNull();
    expect(container.textContent).not.toContain("is working");
  });

  it("read-only inspection has no cards and no activity wiring", async () => {
    vi.mocked(attachConversation).mockResolvedValue({
      attached: false,
      error: "agent 'dipu' is not runnable",
      gate: { ok: false, missing: ["dipu"], malformed: [] },
    });
    await mountNavigator();
    await flush();
    expect(container.querySelector(".attach-banner")).not.toBeNull();
    expect(container.querySelector(".interaction-tray")).toBeNull();
    expect(cardsContainer()).toBeNull();
    expect(timelineProps.onActivityChange).toBeUndefined();
  });

  it("announces each card appearance/transition/removal once through a polite live region (never per token)", async () => {
    await mountNavigator();
    await flush();

    // Appearance.
    await act(async () => deliverActivity([{ runId: "r1", agent: "dipu", phase: "working" }]));
    await flush();
    expect(activityAnnouncement()?.textContent).toBe("Dipu is working…");

    // working -> typing transition (one announcement, no delta content).
    await act(async () => deliverActivity([{ runId: "r1", agent: "dipu", phase: "typing" }]));
    await flush();
    expect(activityAnnouncement()?.textContent).toBe("Dipu is typing…");

    // Removal (neutral, never a completion/failure claim).
    await act(async () => deliverActivity([]));
    await flush();
    expect(activityAnnouncement()?.textContent).toBe("Dipu is no longer working");
  });

  it("restores focus to the composer when the focused abort's card disappears", async () => {
    await mountNavigator();
    await act(async () => deliverActivity([{ runId: "r1", agent: "dipu", phase: "working" }]));
    await flush();
    const abort = cardsContainer()?.querySelector<HTMLButtonElement>('[aria-label="Abort Dipu\'s current work"]');
    expect(abort).toBeDefined();
    abort?.focus();
    expect(document.activeElement).toBe(abort);

    await act(async () => deliverActivity([]));
    await flush();
    // Focus returned to the composer textarea (the card abort disappeared).
    expect(document.activeElement?.id).toBe("conversation-message-c1");
  });

  it("activity changes never fetch or mutate (SSE-driven, display-only)", async () => {
    await mountNavigator();
    const callsBefore = {
      conversation: vi.mocked(fetchConversation).mock.calls.length,
      attach: vi.mocked(attachConversation).mock.calls.length,
      agents: vi.mocked(fetchConversationAgents).mock.calls.length,
      abort: vi.mocked(abortConversationRun).mock.calls.length,
      approve: vi.mocked(approveConversationApproval).mock.calls.length,
    };
    await act(async () =>
      deliverActivity([
        { runId: "r1", agent: "dipu", phase: "working" },
        { runId: "r2", agent: "zai", phase: "typing" },
      ]),
    );
    await act(async () => deliverActivity([{ runId: "r1", agent: "dipu", phase: "typing" }]));
    await act(async () => deliverActivity([]));
    await flush();
    expect(vi.mocked(fetchConversation).mock.calls.length).toBe(callsBefore.conversation);
    expect(vi.mocked(attachConversation).mock.calls.length).toBe(callsBefore.attach);
    expect(vi.mocked(fetchConversationAgents).mock.calls.length).toBe(callsBefore.agents);
    expect(vi.mocked(abortConversationRun).mock.calls.length).toBe(callsBefore.abort);
    expect(vi.mocked(approveConversationApproval).mock.calls.length).toBe(callsBefore.approve);
  });
});

describe("U1 static contract pins", () => {
  it("the cards render inside the history region and the tray no longer carries the activity row", async () => {
    const navigator = await readFile(join(process.cwd(), "web", "src", "ConversationNavigator.tsx"), "utf8");
    expect(navigator).toContain("conversation-activity-cards");
    expect(navigator).not.toContain("dock-run-status");
    expect(navigator).not.toContain("conversation-activity-row");
    // The exact pinned abort label comes from the pure activity core (never
    // the old "Abort X run" wording).
    expect(navigator).toContain("conversationActivityRunAbortLabel(run.agent)");
    expect(navigator).not.toContain("Abort ${run.agent} run");
    // No new transport/polling/storage surface.
    for (const forbidden of ["localStorage", "sessionStorage", "setInterval", "new EventSource", "WebSocket"]) {
      expect(navigator).not.toContain(forbidden);
    }
  });

  it("the activity card styles live in the shared stylesheet with no animation and no second scroll region", async () => {
    const styles = await readFile(join(process.cwd(), "web", "src", "styles.css"), "utf8");
    expect(styles).toContain(".conversation-activity-cards");
    expect(styles).not.toContain(".dock-run-status");
    // The cards never introduce their own overflow/scroll region.
    const cardsRule = styles.match(/\.conversation-activity-cards\s*\{[^}]*\}/g) ?? [];
    expect(cardsRule.length).toBeGreaterThan(0);
    for (const rule of cardsRule) {
      expect(rule).not.toMatch(/overflow(-y|-x)?:\s*(auto|scroll)/);
      expect(rule).not.toContain("animation");
    }
  });
});
