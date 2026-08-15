// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConversationComposer } from "../web/src/ConversationComposer.js";
import { sendConversationMessage } from "../web/src/api.js";
import type { ConversationAgentEntry } from "../web/src/conversation-agents.js";

/**
 * P8 (accepted `conversation-p8-pilot-correction-contract.md` §1) — composer
 * textarea focus restoration ONLY on accepted sends. An accepted send
 * restores focus to the re-enabled textarea after the busy→false commit with
 * preventScroll; focus is NEVER stolen on validation/API failure, navigation,
 * or a deliberate user focus move. ADR-0044 removed the draft first-message
 * mode and its one-shot `initialFocus` intent.
 */

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    sendConversationMessage: vi.fn(),
  };
});

const MESSAGE_EVENT = { id: "e1", conversationId: "c1", kind: "steward_message", created: "2026-08-11T00:00:00.000Z" };
const AGENTS: ConversationAgentEntry[] = [{ name: "dipu", online: true }];

function Harness(props: { conversationId: string }): ReactElement {
  return createElement(ConversationComposer, {
    conversationId: props.conversationId,
    token: "test-token",
    agents: AGENTS,
    onUnauthorized: () => {},
    onAnnounce: () => {},
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
    vi.mocked(sendConversationMessage).mockResolvedValue({ event: MESSAGE_EVENT });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    document.body.focus();
  });

  it("an accepted ACTIVE send restores focus to the re-enabled textarea after the busy→false commit (RED: no restore today)", async () => {
    render(createElement(Harness, { conversationId: "c1" }));
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
    render(createElement(Harness, { conversationId: "c1" }));
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
    render(createElement(Harness, { conversationId: "c1" }));
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
    render(createElement(Harness, { conversationId: "c1" }));
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

  it("the active composer never auto-focuses on mount (ADR-0044: no initialFocus intent remains)", async () => {
    render(createElement(Harness, { conversationId: "c1" }));
    expect(document.activeElement).not.toBe(textarea());
  });


});
