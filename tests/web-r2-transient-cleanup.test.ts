// @vitest-environment jsdom
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConversationTimeline } from "../web/src/ConversationTimeline.js";
import type { ConversationCompactActivityRun } from "../web/src/conversation-activity.js";
import type { SseFrame } from "../web/src/timeline.js";
import type { ConversationEventRecord } from "../web/src/conversations.js";

/**
 * R2 (accepted `workbench-transient-content-cleanup-contract.md`) — remove
 * the P8 retained in-memory run-summary feature and transient streamed
 * partial work content; keep only compact truthful live run state in the
 * stable R1 bottom dock.
 *
 * - No run-summary source/render/import/style path may remain.
 * - The transcript renders no transient activity panel and no partial/delta/
 *   truncation content: valid working/text_delta activity yields compact
 *   source-named dock state only (`<agent> is working…` / `is typing…`).
 * - Every live-state cleanup path stays fail-closed and history never
 *   reconstructs it; the scoped abort affordance moves with the dock.
 *
 * These surfaces do not exist yet: RED.
 */

const webSrc = join(process.cwd(), "web", "src");

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchConversationEvents: vi.fn(),
    streamConversationEvents: vi.fn(),
  };
});

import { fetchConversationEvents, streamConversationEvents } from "../web/src/api.js";

describe("R2 run-summary removal and partial-content removal (static)", () => {
  it("no run-summary source, render, import, or style path remains in the Workbench", async () => {
    const files = await readdir(webSrc);
    expect(files).not.toContain("conversation-summary.ts");
    expect(files).not.toContain("conversation-summary-disclosure.tsx");
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    for (const content of [timeline, navigator]) {
      expect(content).not.toMatch(/runSummary|run-summary|RunSummaries|conversation-summary/i);
    }
    expect(styles).not.toMatch(/\.run-summary/);
  });

  it("the transcript renders NO transient activity panel and no partial/delta/truncation work content", async () => {
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    expect(timeline).not.toContain("ConversationActivityDisplay");
    expect(timeline).not.toContain("transient-run-panel");
    expect(timeline).not.toContain("transient-run-partial");
    expect(timeline).not.toContain("run.partial");
    expect(timeline).not.toContain("truncated");
    // The abort affordance no longer lives in the timeline (it moved to the dock).
    expect(timeline).not.toContain("onAbortRun");
    expect(timeline).not.toContain("abortState");
  });

  it("compact source-truthful live run state renders in the stable bottom dock, not the transcript", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    // The dock carries the compact per-run state (exact agent + working/typing
    // labels sourced from the pure activity core).
    expect(navigator).toContain("composer-action-row");
    expect(navigator).toContain("dock-run-status");
    expect(navigator).toContain("conversationActivityRunStateLabel(run.phase)");
    expect(navigator).toContain("transient-run-abort");
    // The live-state flows from the subscribed timeline to the navigator dock.
    expect(navigator).toContain("onActivityChange");
    expect(timeline).toContain("onActivityChange");
  });

  it("the truthful working/typing labels live in the pure activity core", async () => {
    const activity = await readFile(join(webSrc, "conversation-activity.ts"), "utf8");
    expect(activity).toContain('"is working…"');
    expect(activity).toContain('"is typing…"');
  });

  it("the dock abort preserves the exact existing agent-scoped route/request and adds no new surface", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    expect(navigator).toContain("abortConversationRun(");
    expect(navigator).toContain("handleAbort(run.agent)");
    for (const name of ["ConversationNavigator.tsx", "ConversationTimeline.tsx", "conversation-activity.ts"]) {
      const content = await readFile(join(webSrc, name), "utf8");
      for (const forbidden of [
        "localStorage",
        "sessionStorage",
        "setInterval",
        "new EventSource",
        "/api/chat",
        "/api/vault",
        "WebSocket",
        "dangerouslySetInnerHTML",
      ]) {
        expect(content, `${name} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe("R2 compact dock state through the subscribed live-frame path (jsdom)", () => {
  const CID = "20260814T000000000Z-r2";
  const TOKEN = "test-token";
  let container: HTMLDivElement;
  let root: Root | null = null;
  let capturedHandlers: { onFrame: (frame: SseFrame) => void; onOpen?: () => void } | null;
  let streamResolve: (() => void) | null;
  const onUnauthorized = vi.fn();
  const onAppend = vi.fn();
  const onHistoryLoaded = vi.fn();
  const onActivityChange = vi.fn<(runs: ConversationCompactActivityRun[]) => void>();

  function activityFrame(kind: "working" | "text_delta" | "settled", overrides: Record<string, unknown> = {}): SseFrame {
    return {
      event: "conversation_activity",
      data: JSON.stringify({
        conversationId: CID,
        runId: "run-0001",
        agent: "dipu",
        kind,
        ...overrides,
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
      created: "2026-08-14T00:00:01.000Z",
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

  function agentMessageFrame(text: string): SseFrame {
    const record: ConversationEventRecord = {
      id: "evt-agent",
      conversationId: CID,
      kind: "agent_message",
      authorKind: "agent",
      author: "dipu",
      created: "2026-08-14T00:00:00.500Z",
      sequence: 8,
      mentions: [],
      body: text,
      path: "p",
    };
    return { event: "conversation_event", data: JSON.stringify(record) };
  }

  function renderTimeline(conversationId = CID): void {
    if (root === null) root = createRoot(container);
    act(() => {
      root!.render(
        createElement(ConversationTimeline, {
          conversationId,
          token: TOKEN,
          live: true,
          onUnauthorized,
          onAppend,
          onHistoryLoaded,
          onActivityChange,
        }),
      );
    });
  }

  async function deliver(frames: SseFrame[]): Promise<void> {
    await act(async () => {
      for (const frame of frames) {
        capturedHandlers?.onFrame(frame);
      }
    });
  }

  async function settleHistory(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    capturedHandlers = null;
    streamResolve = null;
    onUnauthorized.mockClear();
    onAppend.mockClear();
    onHistoryLoaded.mockClear();
    onActivityChange.mockClear();
    vi.mocked(fetchConversationEvents).mockResolvedValue([]);
    // The mock stream captures the subscribed handlers; the caller resolves
    // it to exercise the stream-end cleanup path.
    vi.mocked(streamConversationEvents).mockImplementation(
      (
        _id: string,
        _token: string,
        handlers: { onFrame: (frame: SseFrame) => void; onOpen?: () => void },
        _signal: AbortSignal,
      ): Promise<void> => {
        capturedHandlers = handlers;
        handlers.onOpen?.();
        return new Promise<void>((resolve) => {
          streamResolve = () => resolve();
        });
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

  function compactRuns(): ConversationCompactActivityRun[] {
    return onActivityChange.mock.calls.at(-1)?.[0] ?? [];
  }

  it("valid working/text_delta activity reports ONLY compact source-named dock state (no partial/truncation) and no transcript panel", async () => {
    renderTimeline();
    await settleHistory();
    expect(onHistoryLoaded).toHaveBeenCalledTimes(1);

    await deliver([activityFrame("working"), activityFrame("text_delta", { delta: "Hel" }), activityFrame("text_delta", { delta: "lo" })]);

    // Compact, source-named, phase-only: the delta/partial/truncation never leaves the state machine.
    expect(compactRuns()).toEqual([{ runId: "run-0001", agent: "dipu", phase: "typing" }]);
    for (const call of onActivityChange.mock.calls) {
      for (const run of call[0] as ConversationCompactActivityRun[]) {
        expect(run).not.toHaveProperty("partial");
        expect(run).not.toHaveProperty("truncated");
      }
    }
    // The transcript DOM has no transient panel and no partial work text.
    expect(container.querySelector(".transient-run-panel")).toBeNull();
    expect(container.textContent).not.toContain("Hel");
    expect(container.textContent).not.toContain("Hello");
    expect(container.textContent).not.toContain("…");
  });

  it("multiple live runs stay source-named in the dock report", async () => {
    renderTimeline();
    await settleHistory();
    await deliver([
      activityFrame("working"),
      activityFrame("working", { runId: "run-0002", agent: "zai" }),
    ]);
    expect(compactRuns()).toEqual([
      { runId: "run-0001", agent: "dipu", phase: "working" },
      { runId: "run-0002", agent: "zai", phase: "working" },
    ]);
  });

  it("every defined cleanup path clears the dock state (settled, malformed/foreign, durable terminal, agent_message)", async () => {
    renderTimeline();
    await settleHistory();

    // settled frame clears.
    await deliver([activityFrame("working"), activityFrame("settled", { outcome: "completed" })]);
    expect(compactRuns()).toEqual([]);

    // malformed/foreign frame clears.
    await deliver([activityFrame("working"), activityFrame("text_delta", { delta: "x", conversationId: "foreign" })]);
    expect(compactRuns()).toEqual([]);

    // durable terminal clears.
    await deliver([activityFrame("working"), durableEvent({})]);
    expect(compactRuns()).toEqual([]);

    // durable agent_message clears.
    await deliver([activityFrame("working"), agentMessageFrame("Durable final.")]);
    expect(compactRuns()).toEqual([]);
  });

  it("selection change (fresh conversation) and stream end clear the dock state; history never reconstructs it", async () => {
    renderTimeline();
    await settleHistory();
    await deliver([activityFrame("working")]);
    expect(compactRuns().length).toBeGreaterThan(0);

    // Selection change: a fresh conversation id re-runs the whole-history read.
    renderTimeline("20260814T000000000Z-r2-other");
    await settleHistory();
    expect(compactRuns()).toEqual([]);

    // A live run again (framed for the NEW conversation), then the stream
    // ends: cleared, never reconstructed.
    await deliver([activityFrame("working", { conversationId: "20260814T000000000Z-r2-other" })]);
    expect(compactRuns().length).toBeGreaterThan(0);
    await act(async () => {
      streamResolve?.();
    });
    await settleHistory();
    expect(compactRuns()).toEqual([]);
  });

  it("unmount leaves no stale dock state behind (tree unmount)", async () => {
    renderTimeline();
    await settleHistory();
    await deliver([activityFrame("working")]);
    expect(compactRuns().length).toBeGreaterThan(0);
    act(() => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    // A fresh render reports nothing (no hidden reconstruction).
    container = document.createElement("div");
    document.body.appendChild(container);
    renderTimeline();
    await settleHistory();
    expect(compactRuns()).toEqual([]);
  });
});
