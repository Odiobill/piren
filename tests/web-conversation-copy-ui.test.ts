// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConversationTimeline } from "../web/src/ConversationTimeline.js";
import { fetchConversationEvents, streamConversationEvents } from "../web/src/api.js";
import type { SseFrame } from "../web/src/timeline.js";

/**
 * W4 — copy canonical durable Conversation message text (accepted
 * workbench-copy-conversation-message-contract.md): exactly one labelled
 * control on ordinary durable message cards; payload is the byte-identical
 * stored body; native Clipboard API only; bounded per-card feedback
 * (success exactly 2 s; failure until next gesture/cleanup); stale async
 * completions are inert; no fallback/storage/fetch/polling/durable effect.
 */

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchConversationEvents: vi.fn(),
    streamConversationEvents: vi.fn(),
  };
});

let container: HTMLDivElement;
let root: Root | null = null;
let capturedHandlers: { onFrame: (frame: SseFrame) => void } | null = null;

function eventRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "e1",
    conversationId: "c1",
    kind: "agent_message",
    authorKind: "agent",
    author: "dipu",
    created: "2026-08-30T10:00:00.000Z",
    sequence: 1,
    mentions: [],
    body: "hello **world**",
    path: "collaboration/conversations/c1/e1.md",
    ...overrides,
  };
}

const STEWARD = eventRecord({
  id: "e0",
  sequence: 2,
  kind: "steward_message",
  authorKind: "steward",
  author: "steward",
  body: "steward said hi",
  created: "2026-08-30T10:01:00.000Z",
});

const MARKDOWN = "# Plan\n\n- item **bold** `code`\n\n```js\nconst x = 1;\n```";
const AGENT_MARKDOWN = eventRecord({ id: "e2", sequence: 3, body: MARKDOWN, created: "2026-08-30T10:02:00.000Z" });
const HANDOFF = eventRecord({
  id: "e3",
  sequence: 4,
  kind: "agent_message",
  body: "handoff directive text",
  addressedAgent: "zai",
  created: "2026-08-30T10:03:00.000Z",
});
const SYSTEM = eventRecord({
  id: "e4",
  sequence: 5,
  kind: "system",
  authorKind: "system",
  author: "system",
  body: "system evidence text",
  created: "2026-08-30T10:04:00.000Z",
});

function renderTimeline(live = true, conversationId = "c1"): void {
  if (root === null) root = createRoot(container);
  act(() => {
    root!.render(
      createElement(ConversationTimeline, {
        conversationId,
        token: "t",
        live,
        onUnauthorized: () => {},
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

function copyButton(author: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="Copy message from ${author}"]`);
}

function feedback(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".transcript-copy-feedback"));
}

type ClipboardStub = { writeText: ReturnType<typeof vi.fn> } | undefined;

function stubClipboard(stub: ClipboardStub): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    get: () => stub,
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  capturedHandlers = null;
  vi.mocked(fetchConversationEvents).mockResolvedValue([AGENT_MARKDOWN, STEWARD, HANDOFF, SYSTEM] as unknown as Awaited<ReturnType<typeof fetchConversationEvents>>);
  vi.mocked(streamConversationEvents).mockImplementation(
    (_id: string, _token: string, handlers: { onFrame: (frame: SseFrame) => void }): Promise<void> => {
      capturedHandlers = handlers;
      return new Promise(() => {});
    },
  );
  stubClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("W4 copy control — rendering and eligibility", () => {
  it("renders exactly one labelled type=button per ordinary message card and none elsewhere", async () => {
    renderTimeline();
    await settleHistory();
    const agentButton = copyButton("dipu");
    const stewardButton = copyButton("steward");
    expect(agentButton).not.toBeNull();
    expect(stewardButton).not.toBeNull();
    expect(agentButton?.getAttribute("type")).toBe("button");
    expect(stewardButton?.getAttribute("type")).toBe("button");
    // Exactly one control per card: 2 eligible message cards → 2 controls.
    expect(container.querySelectorAll("button[aria-label^='Copy message from']")).toHaveLength(2);
    // C5 handoff row: durable agent_message but transcript-handoff card → no control.
    expect(container.textContent).toContain("handoff from dipu to zai");
    expect(container.textContent).toContain("handoff directive text");
    expect(copyButton("dipu")).toBe(agentButton); // sanity: only one dipu card
    expect(container.querySelectorAll("button")).toHaveLength(2); // only the two copy controls exist
  });

  it("renders identically on the read-only inspection surface", async () => {
    renderTimeline(false);
    await settleHistory();
    expect(copyButton("dipu")).not.toBeNull();
    expect(copyButton("steward")).not.toBeNull();
  });
});

describe("W4 copy control — payload and feedback", () => {
  it("click copies the byte-identical canonical stored body including Markdown source", async () => {
    renderTimeline();
    await settleHistory();
    const stub = navigator.clipboard as unknown as { writeText: ReturnType<typeof vi.fn> };
    await act(async () => {
      copyButton("dipu")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(stub.writeText).toHaveBeenCalledTimes(1);
    expect(stub.writeText).toHaveBeenCalledWith(MARKDOWN);
    await act(async () => {
      copyButton("steward")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(stub.writeText).toHaveBeenLastCalledWith("steward said hi");
  });

  it("success feedback is announced, visible exactly 2 seconds, then idle; failure stays until the next gesture", async () => {
    vi.useFakeTimers();
    renderTimeline();
    await settleHistory();
    await act(async () => {
      copyButton("dipu")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    let feedbackEls = feedback();
    expect(feedbackEls).toHaveLength(1);
    expect(feedbackEls[0]?.getAttribute("role")).toBe("status");
    expect(feedbackEls[0]?.textContent).toContain("Copied");
    // Exactly 2 seconds later: idle (feedback gone).
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(feedback()).toHaveLength(0);
    // A failure appears and STAYS visible well beyond 2 seconds.
    stubClipboard({ writeText: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")) });
    await act(async () => {
      copyButton("dipu")?.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    feedbackEls = feedback();
    expect(feedbackEls).toHaveLength(1);
    expect(feedbackEls[0]?.getAttribute("role")).toBe("alert");
    expect(feedbackEls[0]?.textContent).toContain("clipboard rejected");
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(feedback()).toHaveLength(1); // failure persists until the next gesture
    // A new successful gesture replaces the failure (latest gesture wins).
    stubClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    await act(async () => {
      copyButton("dipu")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    feedbackEls = feedback();
    expect(feedbackEls).toHaveLength(1);
    expect(feedbackEls[0]?.textContent).toContain("Copied");
  });

  it("clipboard API absent: bounded failure feedback 'clipboard unavailable', no fallback mechanism", async () => {
    const execCommand = vi.fn();
    document.execCommand = execCommand as unknown as typeof document.execCommand;
    stubClipboard(undefined);
    renderTimeline();
    await settleHistory();
    await act(async () => {
      copyButton("dipu")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const feedbackEls = feedback();
    expect(feedbackEls).toHaveLength(1);
    expect(feedbackEls[0]?.getAttribute("role")).toBe("alert");
    expect(feedbackEls[0]?.textContent).toContain("clipboard unavailable");
    // No fallback clipboard mechanism was attempted.
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("writeText rejection: bounded 'clipboard rejected' feedback, never raw exception text", async () => {
    stubClipboard({ writeText: vi.fn().mockRejectedValue(new DOMException("The document is focused... secret internals", "NotAllowedError")) });
    renderTimeline();
    await settleHistory();
    await act(async () => {
      copyButton("dipu")?.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const feedbackEls = feedback();
    expect(feedbackEls).toHaveLength(1);
    expect(feedbackEls[0]?.textContent).toContain("clipboard rejected");
    expect(feedbackEls[0]?.textContent).not.toContain("secret internals");
    // No automatic retry happened.
    const stub = navigator.clipboard as unknown as { writeText: ReturnType<typeof vi.fn> };
    expect(stub.writeText).toHaveBeenCalledTimes(1);
  });

  it("keyboard activation (Enter on the focused button) copies; there is no auto-copy on render", async () => {
    renderTimeline();
    await settleHistory();
    const stub = navigator.clipboard as unknown as { writeText: ReturnType<typeof vi.fn> };
    expect(stub.writeText).not.toHaveBeenCalled();
    const button = copyButton("dipu");
    button?.focus();
    await act(async () => {
      button?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      button?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(stub.writeText).toHaveBeenCalledTimes(1);
    expect(stub.writeText).toHaveBeenCalledWith(MARKDOWN);
  });

  it("a copy promise settling after unmount/selection change is inert: no feedback, no unhandled rejection, no cross-conversation state", async () => {
    let releaseWrite: ((value: PromiseLike<void>) => void) | undefined;
    stubClipboard({ writeText: vi.fn().mockReturnValue(new Promise<void>((resolve) => {
      releaseWrite = resolve;
    })) });
    renderTimeline();
    await settleHistory();
    await act(async () => {
      copyButton("dipu")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    // Selection change: unmount (rows leave the rendered set) BEFORE the
    // promise resolves, then let the stale write settle.
    act(() => {
      root?.unmount();
    });
    root = null;
    await act(async () => {
      releaseWrite?.(Promise.resolve());
      await Promise.resolve();
      await Promise.resolve();
    });
    // Reaching here with no unhandled rejection and no crash is the proof;
    // a fresh mount renders a clean, feedback-free card.
    renderTimeline(true, "c2");
    await settleHistory();
    expect(feedback()).toHaveLength(0);
  });
});

describe("W4 source boundary pins — no fallback, storage, fetch, polling, routes, or durable mutation", () => {
  it("introduces no execCommand fallback, browser storage, fetch, interval polling, or event append in the copy modules", async () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const sources = await Promise.all(
      [
        "web/src/conversation-copy-message.ts",
        "web/src/ConversationTimeline.tsx",
      ].map((p) => readFile(join(repoRoot, p), "utf8")),
    );
    for (const source of sources) {
      // Call-syntax pin: prose mentions of the banned API stay allowed.
      expect(source).not.toMatch(/execCommand\s*\(/);
      expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/);
      expect(source).not.toMatch(/setInterval\s*\(/);
      expect(source).not.toMatch(/fetch\(/);
      expect(source).not.toMatch(/appendConversationEvent|postConversationEvent/);
    }
  });
});
