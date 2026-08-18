// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConversationTimeline } from "../web/src/ConversationTimeline.js";
import { fetchConversationEvents, streamConversationEvents } from "../web/src/api.js";
import type { SseFrame } from "../web/src/timeline.js";

/**
 * T6 — ConversationTimeline wiring of the additive `conversation_telemetry`
 * SSE frame: a validated selected-conversation frame is forwarded to
 * onTelemetry and never becomes a timeline item; foreign, malformed, or
 * leaking frames are ignored (no state mutation, no error row, no crash).
 * The durable timeline stays telemetry-free.
 */

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchConversationEvents: vi.fn(),
    streamConversationEvents: vi.fn(),
  };
});

const CID = "c1";
const TOKEN = "t";

let container: HTMLDivElement;
let root: Root | null = null;
let capturedHandlers: { onFrame: (frame: SseFrame) => void; onOpen?: () => void } | null = null;
const onUnauthorized = vi.fn();
const onTelemetry = vi.fn();

function renderTimeline(): void {
  if (root === null) root = createRoot(container);
  act(() => {
    root!.render(
      createElement(ConversationTimeline, {
        conversationId: CID,
        token: TOKEN,
        live: true,
        onUnauthorized,
        onTelemetry,
      }),
    );
  });
}

async function settleHistory(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function deliver(frames: SseFrame[]): Promise<void> {
  await act(async () => {
    for (const frame of frames) {
      capturedHandlers?.onFrame(frame);
    }
  });
}

function telemetryFrame(data: Record<string, unknown>): SseFrame {
  return { event: "conversation_telemetry", data: JSON.stringify(data) };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  capturedHandlers = null;
  onUnauthorized.mockClear();
  onTelemetry.mockClear();
  vi.mocked(fetchConversationEvents).mockResolvedValue([]);
  vi.mocked(streamConversationEvents).mockImplementation(
    (_id: string, _token: string, handlers: { onFrame: (frame: SseFrame) => void; onOpen?: () => void }): Promise<void> => {
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
  root = null;
  container?.remove();
});

describe("T6 timeline telemetry frame wiring", () => {
  it("forwards a valid selected-conversation frame to onTelemetry and never appends a timeline item", async () => {
    renderTimeline();
    await settleHistory();
    await deliver([
      telemetryFrame({ conversationId: CID, agent: "dipu", runId: "run-0001", contextState: "ok", context: { tokens: 60000, contextWindow: 200000, percent: 30 } }),
    ]);
    expect(onTelemetry).toHaveBeenCalledTimes(1);
    expect(onTelemetry).toHaveBeenCalledWith({
      conversationId: CID,
      agent: "dipu",
      runId: "run-0001",
      contextState: "ok",
      context: { tokens: 60000, contextWindow: 200000, percent: 30 },
    });
    // The durable timeline stays telemetry-free: no rows, no error items.
    expect(container.querySelectorAll(".transcript-row")).toHaveLength(0);
  });

  it("ignores foreign, malformed, and leaking frames without state mutation or an error row", async () => {
    renderTimeline();
    await settleHistory();
    await deliver([
      telemetryFrame({ conversationId: "other", agent: "dipu", runId: "run-1", contextState: "ok", context: { tokens: 1, contextWindow: 2, percent: 3 } }),
      telemetryFrame({ conversationId: CID, agent: "dipu", runId: "run-1", contextState: "ok", context: { tokens: 1, contextWindow: 2, percent: 3 }, sessionId: "secret" }),
      telemetryFrame({ conversationId: CID, agent: "", runId: "run-1", contextState: "ok", context: { tokens: 1, contextWindow: 2, percent: 3 } }),
      { event: "conversation_telemetry", data: "{not json" },
    ]);
    expect(onTelemetry).not.toHaveBeenCalled();
    expect(container.querySelectorAll(".transcript-error")).toHaveLength(0);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
