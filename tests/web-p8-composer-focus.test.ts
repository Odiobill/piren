// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConversationComposer } from "../web/src/ConversationComposer.js";
import { sendConversationMessage, createConversation } from "../web/src/api.js";
import type { ConversationAgentEntry } from "../web/src/conversation-agents.js";
import type { ConversationRecord } from "../web/src/conversations.js";

/**
 * P8 (accepted `conversation-p8-pilot-correction-contract.md` §1) — composer
 * textarea focus restoration ONLY on accepted sends. An accepted ACTIVE send
 * restores focus to the re-enabled textarea after the busy→false commit with
 * preventScroll; a draft first send is owned by the newly mounted ACTIVE
 * composer via a one-shot `initialFocus` intent; focus is NEVER stolen on
 * validation/API failure, navigation, or a deliberate user focus move.
 */

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    sendConversationMessage: vi.fn(),
    createConversation: vi.fn(),
  };
});

const MESSAGE_EVENT = { id: "e1", conversationId: "c1", kind: "steward_message", created: "2026-08-11T00:00:00.000Z" };
const CONVERSATION: ConversationRecord = {
  id: "c1",
  title: "A conversation",
  path: "collaboration/conversations/c1/index.md",
  createdBy: "steward",
  audience: [],
  status: "open",
  created: "2026-08-11T00:00:00.000Z",
  updated: "2026-08-11T00:00:00.000Z",
};
const AGENTS: ConversationAgentEntry[] = [{ name: "dipu", online: true }];

function Harness(props: {
  mode: "draft" | "active";
  conversationId?: string;
  initialFocus?: boolean;
  onCreated?: (conversation: ConversationRecord) => void;
}): ReactElement {
  return createElement(ConversationComposer, {
    mode: props.mode,
    ...(props.conversationId !== undefined ? { conversationId: props.conversationId } : {}),
    ...(props.initialFocus !== undefined ? { initialFocus: props.initialFocus } : {}),
    token: "test-token",
    agents: AGENTS,
    onUnauthorized: () => {},
    onAnnounce: () => {},
    ...(props.onCreated !== undefined ? { onCreated: props.onCreated } : {}),
  });
}

function typeText(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.setSelectionRange(value.length, value.length);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function key(input: HTMLTextAreaElement, keyValue: string, init: KeyboardEventInit = {}): void {
  input.dispatchEvent(new KeyboardEvent("keydown", { key: keyValue, bubbles: true, ...init }));
}

describe("P8 composer focus restoration", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(element: ReactElement): void {
    root = createRoot(container);
    act(() => {
      root.render(element);
    });
  }

  function textarea(): HTMLTextAreaElement {
    const el = container.querySelector<HTMLTextAreaElement>(".conversation-composer textarea");
    if (el === null) throw new Error("composer textarea missing");
    return el;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.mocked(sendConversationMessage).mockReset();
    vi.mocked(createConversation).mockReset();
    vi.mocked(sendConversationMessage).mockResolvedValue({ event: MESSAGE_EVENT });
    vi.mocked(createConversation).mockResolvedValue({ conversation: CONVERSATION, event: MESSAGE_EVENT });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    document.body.focus();
  });

  it("an accepted ACTIVE send restores focus to the re-enabled textarea after the busy→false commit (RED: no restore today)", async () => {
    render(createElement(Harness, { mode: "active", conversationId: "c1" }));
    const input = textarea();
    // Real browsers blur the focused textarea while busy disables it; jsdom
    // cannot blur a disabled element, so model the post-busy focus loss by
    // leaving focus on the body before the send resolves.
    expect(document.activeElement).not.toBe(input);
    await act(async () => typeText(input, "hello"));

    let resolveSend!: (value: Awaited<ReturnType<typeof sendConversationMessage>>) => void;
    vi.mocked(sendConversationMessage).mockReturnValueOnce(new Promise((resolve) => (resolveSend = resolve)));
    await act(async () => key(input, "Enter"));
    expect(input.disabled).toBe(true);

    await act(async () => {
      resolveSend({ event: MESSAGE_EVENT });
    });
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it("a failed ACTIVE send never restores focus", async () => {
    render(createElement(Harness, { mode: "active", conversationId: "c1" }));
    const input = textarea();
    await act(async () => typeText(input, "hello"));

    let rejectSend!: (reason: Error) => void;
    vi.mocked(sendConversationMessage).mockReturnValueOnce(new Promise((_resolve, reject) => (rejectSend = reject)));
    await act(async () => key(input, "Enter"));
    expect(input.disabled).toBe(true);
    await act(async () => {
      rejectSend(new Error("boom"));
    });
    expect(input.disabled).toBe(false);
    expect(document.activeElement).not.toBe(input);
  });

  it("a deliberate user focus move during the in-flight send wins (never steal focus)", async () => {
    render(createElement(Harness, { mode: "active", conversationId: "c1" }));
    const input = textarea();
    const toggle = container.querySelector<HTMLButtonElement>(".composer-submit-toggle");
    expect(toggle).not.toBeNull();
    await act(async () => typeText(input, "hello"));

    let resolveSend!: (value: Awaited<ReturnType<typeof sendConversationMessage>>) => void;
    vi.mocked(sendConversationMessage).mockReturnValueOnce(new Promise((resolve) => (resolveSend = resolve)));
    await act(async () => key(input, "Enter"));
    await act(() => {
      toggle!.focus();
    });
    await act(async () => {
      resolveSend({ event: MESSAGE_EVENT });
    });
    // The deliberate focus on the toggle is preserved.
    expect(document.activeElement).toBe(toggle);
  });

  it("validation rejection never steals focus from another control", async () => {
    render(createElement(Harness, { mode: "active", conversationId: "c1" }));
    const input = textarea();
    const toggle = container.querySelector<HTMLButtonElement>(".composer-submit-toggle");
    expect(toggle).not.toBeNull();
    await act(async () => typeText(input, "   "));
    toggle!.focus();
    const form = container.querySelector<HTMLFormElement>(".conversation-composer");
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    // Empty/invalid text is rejected: focus stays on the toggle.
    expect(sendConversationMessage).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(toggle);
  });

  it("the ACTIVE composer with initialFocus focuses its textarea exactly once on mount (RED: no such intent today)", async () => {
    render(createElement(Harness, { mode: "active", conversationId: "c1", initialFocus: true }));
    const input = textarea();
    expect(document.activeElement).toBe(input);

    // Consumed exactly once: after blur, a re-render never re-focuses.
    await act(() => {
      input.blur();
    });
    expect(document.activeElement).not.toBe(input);
    await act(async () => {
      root.render(createElement(Harness, { mode: "active", conversationId: "c1", initialFocus: true }));
    });
    expect(document.activeElement).not.toBe(input);
  });

  it("without initialFocus the active composer never auto-focuses", async () => {
    render(createElement(Harness, { mode: "active", conversationId: "c1" }));
    expect(document.activeElement).not.toBe(textarea());
  });

  it("the DRAFT composer never steals focus after a successful first send (the active surface owns first-send focus)", async () => {
    const onCreated = vi.fn();
    render(createElement(Harness, { mode: "draft", onCreated }));
    const input = textarea();
    const toggle = container.querySelector<HTMLButtonElement>(".composer-submit-toggle");
    expect(toggle).not.toBeNull();
    await act(async () => typeText(input, "first message"));
    toggle!.focus();
    await act(async () => key(input, "Enter"));
    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
    // The draft never yanks focus back: the navigator's one-shot initialFocus
    // on the newly mounted ACTIVE composer owns first-send focus.
    expect(document.activeElement).toBe(toggle);
  });
});
