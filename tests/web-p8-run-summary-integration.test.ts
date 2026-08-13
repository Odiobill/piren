// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConversationTimeline } from "../web/src/ConversationTimeline.js";
import type { SseFrame } from "../web/src/timeline.js";
import type { ConversationEventRecord } from "../web/src/conversations.js";

/**
 * P8 acceptance-blocker regression (Sam review, 2026-08-13): the durable-
 * terminal handler captured the RENDER-closure `activity`, which stays stale
 * for a live run (the stream effect does not depend on `activity`), so every
 * retained summary got `partial: ""` even after real U4 text_delta frames.
 * This integration test drives the SUBSCRIBED live-frame path (not the pure
 * helper): working + text_delta then a correlated durable terminal must
 * retain the exact already-displayed partial; an agent_message that replaced
 * the partial before the terminal must yield NO fabricated partial.
 */

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchConversationEvents: vi.fn(),
    streamConversationEvents: vi.fn(),
  };
});

import { fetchConversationEvents, streamConversationEvents } from "../web/src/api.js";

const CID = "20260813T000000000Z-p8int";
const TOKEN = "test-token";

function activityFrame(kind: "working" | "text_delta", delta?: string): SseFrame {
  return {
    event: "conversation_activity",
    data: JSON.stringify({
      conversationId: CID,
      runId: "run-0001",
      agent: "dipu",
      kind,
      ...(delta !== undefined ? { delta } : {}),
    }),
  };
}

function durableEvent(overrides: Partial<ConversationEventRecord> = {}): SseFrame {
  const record: ConversationEventRecord = {
    id: "evt-terminal",
    conversationId: CID,
    kind: "run_finished",
    authorKind: "system",
    author: "system",
    created: "2026-08-13T00:00:01.000Z",
    sequence: 9,
    mentions: [],
    body: "Run ended.",
    path: "p",
    runStatus: "failed",
    failureKind: "provider_error",
    runAgent: "dipu",
    ...overrides,
  };
  return { event: "conversation_event", data: JSON.stringify(record) };
}

/** A durable terminal WITHOUT runAgent (legacy evidence — never summarized). */
function terminalWithoutRunAgent(): SseFrame {
  const frame = durableEvent();
  const record = JSON.parse(frame.data) as Record<string, unknown>;
  delete record.runAgent;
  return { event: "conversation_event", data: JSON.stringify(record) };
}

function agentMessageFrame(text: string): SseFrame {
  const record: ConversationEventRecord = {
    id: "evt-agent",
    conversationId: CID,
    kind: "agent_message",
    authorKind: "agent",
    author: "dipu",
    created: "2026-08-13T00:00:00.500Z",
    sequence: 8,
    mentions: [],
    body: text,
    path: "p",
  };
  return { event: "conversation_event", data: JSON.stringify(record) };
}

describe("P8 run-summary integration through the subscribed live-frame path", () => {
  let container: HTMLDivElement;
  let root: Root;
  let capturedHandlers: { onFrame: (frame: SseFrame) => void; onOpen?: () => void } | null;
  const onUnauthorized = vi.fn();
  const onAppend = vi.fn();
  const onHistoryLoaded = vi.fn();

  function renderTimeline(): void {
    root = createRoot(container);
    act(() => {
      root.render(
        createElement(ConversationTimeline, {
          conversationId: CID,
          token: TOKEN,
          live: true,
          onUnauthorized,
          onAppend,
          onHistoryLoaded,
        }),
      );
    });
  }

  /** Deliver frames through the REAL subscribed onFrame path. */
  async function deliver(frames: SseFrame[]): Promise<void> {
    await act(async () => {
      for (const frame of frames) {
        capturedHandlers?.onFrame(frame);
      }
    });
  }

  function summaryButtons(): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label^="Run summary —"]'));
  }

  function expandedPanelText(button: HTMLButtonElement): string {
    const panelId = button.getAttribute("aria-controls");
    const panel = panelId === null ? null : container.querySelector<HTMLElement>(`#${panelId}`);
    return panel?.textContent ?? "";
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    capturedHandlers = null;
    onUnauthorized.mockClear();
    onAppend.mockClear();
    onHistoryLoaded.mockClear();
    vi.mocked(fetchConversationEvents).mockResolvedValue([]);
    // The mock stream captures the subscribed handlers and NEVER resolves, so
    // the summary state survives for assertion (stream-end clears are covered
    // by the pure/static tests and the reread paths).
    vi.mocked(streamConversationEvents).mockImplementation(
      (_id: string, _token: string, handlers: { onFrame: (frame: SseFrame) => void; onOpen?: () => void }, _signal: AbortSignal) => {
        capturedHandlers = handlers;
        handlers.onOpen?.();
        return new Promise<void>(() => {});
      },
    );
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
  });

  it("a live run's retained summary keeps the exact already-displayed partial (RED: stale closure drops it)", async () => {
    renderTimeline();
    // History loaded + stream subscribed (fetch resolves; onHistoryLoaded).
    await act(async () => {
      await Promise.resolve();
    });
    expect(onHistoryLoaded).toHaveBeenCalledTimes(1);

    await deliver([
      activityFrame("working"),
      activityFrame("text_delta", "Hel"),
      activityFrame("text_delta", "lo"),
      durableEvent({}),
    ]);

    const buttons = summaryButtons();
    expect(buttons).toHaveLength(1);
    await act(async () => {
      buttons[0]!.click();
    });
    const panelText = expandedPanelText(buttons[0]!);
    // P8 §4: the summary must retain the actual already-permitted streamed
    // reply text ("Hello") plus the truthful terminal state.
    expect(panelText).toContain("Hello");
    expect(panelText).toContain("dipu");
    expect(panelText).toContain("provider_error");
    // The summary update participated in the content-version anchor behavior.
    expect(onAppend.mock.calls.length).toBeGreaterThan(0);
  });

  it("an agent_message that replaced the partial before the terminal yields NO fabricated partial", async () => {
    renderTimeline();
    await act(async () => {
      await Promise.resolve();
    });

    await deliver([
      activityFrame("working"),
      activityFrame("text_delta", "Hel"),
      agentMessageFrame("Durable final."),
      durableEvent({}),
    ]);

    const buttons = summaryButtons();
    expect(buttons).toHaveLength(1);
    await act(async () => {
      buttons[0]!.click();
    });
    const panelText = expandedPanelText(buttons[0]!);
    // The durable agent_message is the authority: the transient partial was
    // replaced, so the summary shows terminal state and NO fabricated text.
    expect(panelText).not.toContain("Hel");
    expect(panelText).toContain("dipu");
    expect(panelText).toContain("provider_error");
  });

  it("a terminal without runAgent never creates a summary through the live path", async () => {
    renderTimeline();
    await act(async () => {
      await Promise.resolve();
    });
    await deliver([activityFrame("working"), activityFrame("text_delta", "Hel"), terminalWithoutRunAgent()]);
    expect(summaryButtons()).toHaveLength(0);
  });
});
