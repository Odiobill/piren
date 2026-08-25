// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConversationTimeline } from "../web/src/ConversationTimeline.js";
import { fetchConversationEvents, streamConversationEvents } from "../web/src/api.js";
import type { ConversationWorkCard } from "../web/src/conversation-activity.js";
import type { SseFrame } from "../web/src/timeline.js";

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return { ...actual, fetchConversationEvents: vi.fn(), streamConversationEvents: vi.fn() };
});

describe("ConversationTimeline VR-3 work-card projection clearing", () => {
  const CID = "20260825T000000000Z-vr3";
  let timelineContainer: HTMLDivElement;
  let timelineRoot: Root | null = null;
  let handlers: { onFrame: (frame: SseFrame) => void; onOpen?: () => void } | null = null;
  let streamEnd: (() => void) | null = null;
  const onWorkCards = vi.fn<(cards: ConversationWorkCard[]) => void>();

  beforeEach(() => {
    timelineContainer = document.createElement("div");
    document.body.appendChild(timelineContainer);
    handlers = null;
    streamEnd = null;
    onWorkCards.mockClear();
    vi.mocked(fetchConversationEvents).mockResolvedValue([]);
    vi.mocked(streamConversationEvents).mockImplementation(
      (_id: string, _token: string, h: { onFrame: (frame: SseFrame) => void; onOpen?: () => void }, _signal: AbortSignal): Promise<void> => {
        handlers = h;
        h.onOpen?.();
        return new Promise<void>((resolve) => {
          streamEnd = () => resolve();
        });
      },
    );
  });

  afterEach(() => {
    act(() => timelineRoot?.unmount());
    timelineRoot = null;
    timelineContainer.remove();
  });

  it("projects tail/tools on live frames and clears to empty on stream end", async () => {
    timelineRoot = createRoot(timelineContainer);
    await act(async () => {
      timelineRoot!.render(createElement(ConversationTimeline, { conversationId: CID, token: "t", live: true, onUnauthorized: () => {}, onWorkCards }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    if (handlers === null) throw new Error("stream handlers not captured");
    await act(async () => {
      handlers!.onFrame({ event: "conversation_activity", data: JSON.stringify({ conversationId: CID, runId: "r1", agent: "dipu", kind: "working" }) });
      handlers!.onFrame({ event: "conversation_activity", data: JSON.stringify({ conversationId: CID, runId: "r1", agent: "dipu", kind: "text_delta", delta: "live tail" }) });
      handlers!.onFrame({ event: "conversation_activity", data: JSON.stringify({ conversationId: CID, runId: "r1", agent: "dipu", kind: "tool", toolName: "vault_read", status: "started" }) });
    });
    expect(onWorkCards.mock.calls.at(-1)?.[0]).toEqual([
      { runId: "r1", agent: "dipu", phase: "typing", textTail: "live tail", tools: [{ name: "vault_read", status: "started" }] },
    ]);
    // Stream end (loss/reconnect) clears the transient projection.
    await act(async () => {
      streamEnd?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onWorkCards.mock.calls.at(-1)?.[0]).toEqual([]);
  });
});

// --- Static boundary pins (VR-3): no new surface, no persistence, no raw payloads ---
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("VR-3 static boundaries", () => {
  const webSrc = join(process.cwd(), "web", "src");

  it("no new route/SSE event kind, storage API, polling/timer, or generic event bus in the changed work-card surface", async () => {
    const files = ["conversation-activity.ts", "ConversationTimeline.tsx", "ConversationNavigator.tsx"];
    for (const name of files) {
      const content = await readFile(join(webSrc, name), "utf8");
      for (const forbidden of [
        "localStorage",
        "sessionStorage",
        "indexedDB",
        "document.cookie",
        "setInterval",
        "setTimeout",
        "new EventSource",
        "WebSocket",
        "dangerouslySetInnerHTML",
        "EventTarget",
      ]) {
        expect(content, `${name} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
    // The render projection carries only name + status: the closed
    // ConversationToolLine/ConversationWorkCard interfaces declare no raw
    // tool payload fields (args/result/output/environment are rejected at the
    // parser boundary, never retained in renderable state).
    const activity = await readFile(join(webSrc, "conversation-activity.ts"), "utf8");
    expect(activity).toMatch(/export interface ConversationToolLine \{[\s\S]*?name: string;[\s\S]*?status: ConversationToolStatus;[\s\S]*?\}/);
  });
});
