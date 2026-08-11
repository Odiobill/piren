// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConversationComposer } from "../web/src/ConversationComposer.js";
import { createConversation, sendConversationMessage } from "../web/src/api.js";
import type { RoomAgentEntry } from "../web/src/rooms.js";
import type { ConversationRecord } from "../web/src/conversations.js";

/**
 * U3 — Discord-like composer component behavior (jsdom): auto-grow, Enter vs
 * Shift+Enter, IME composition guard, disabled labelled `+` upload
 * affordance with no file capability, runnable-only @ autocomplete with
 * keyboard navigation/selection/dismissal, and the draft persistence
 * boundary (nothing is sent until the first existing raw-text send).
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
const AGENTS: RoomAgentEntry[] = [
  { name: "dipu", online: true },
  { name: "zora", online: false },
];

function Harness(props: {
  mode: "draft" | "active";
  conversationId?: string;
  agents?: RoomAgentEntry[];
  onAnnounce?: (message: string) => void;
  onCreated?: (conversation: ConversationRecord) => void;
}): ReactElement {
  return createElement(ConversationComposer, {
    mode: props.mode,
    ...(props.conversationId !== undefined ? { conversationId: props.conversationId } : {}),
    token: "test-token",
    agents: props.agents ?? AGENTS,
    onUnauthorized: () => {},
    onAnnounce: props.onAnnounce ?? (() => {}),
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

describe("ConversationComposer (U3)", () => {
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
  });

  describe("keyboard semantics", () => {
    it("plain Enter submits the raw {text} to the active message route", async () => {
      render(createElement(Harness, { mode: "active", conversationId: "c1" }));
      await act(async () => typeText(textarea(), "hello everyone"));
      await act(async () => key(textarea(), "Enter"));
      expect(sendConversationMessage).toHaveBeenCalledTimes(1);
      expect(sendConversationMessage).toHaveBeenCalledWith("c1", "hello everyone", "test-token");
    });

    it("Shift+Enter inserts a newline and never submits", async () => {
      render(createElement(Harness, { mode: "active", conversationId: "c1" }));
      await act(async () => typeText(textarea(), "line one"));
      await act(async () => key(textarea(), "Enter", { shiftKey: true }));
      expect(sendConversationMessage).not.toHaveBeenCalled();
    });

    it("IME composition prevents premature submit and a plain Enter submits only after composition ends", async () => {
      render(createElement(Harness, { mode: "active", conversationId: "c1" }));
      await act(async () => typeText(textarea(), "漢字"));
      // Composition active: native isComposing + compositionstart lock.
      await act(async () => {
        textarea().dispatchEvent(new Event("compositionstart", { bubbles: true }));
      });
      await act(async () => key(textarea(), "Enter", { isComposing: true }));
      expect(sendConversationMessage).not.toHaveBeenCalled();
      // Composition ended: a plain Enter now submits.
      await act(async () => {
        textarea().dispatchEvent(new Event("compositionend", { bubbles: true }));
      });
      await act(async () => key(textarea(), "Enter"));
      expect(sendConversationMessage).toHaveBeenCalledTimes(1);
      expect(sendConversationMessage).toHaveBeenCalledWith("c1", "漢字", "test-token");
    });
  });

  describe("auto-grow", () => {
    it("grows the textarea height to the bounded content height and switches to scroll at the cap", async () => {
      render(createElement(Harness, { mode: "active", conversationId: "c1" }));
      const input = textarea();
      Object.defineProperty(input, "scrollHeight", { value: 96, configurable: true });
      await act(async () => typeText(input, "two\nlines"));
      expect(input.style.height).toBe("96px");
      expect(input.style.overflowY).toBe("hidden");

      Object.defineProperty(input, "scrollHeight", { value: 500, configurable: true });
      await act(async () => typeText(input, "many\nlines\nof\ntext\nhere\nagain\nand\nagain"));
      expect(input.style.height).toBe("200px");
      expect(input.style.overflowY).toBe("auto");
    });
  });

  describe("disabled + upload affordance", () => {
    it("is a genuinely disabled labelled button with no file capability", async () => {
      render(createElement(Harness, { mode: "active", conversationId: "c1" }));
      const plus = container.querySelector<HTMLButtonElement>(".composer-upload-placeholder");
      expect(plus).not.toBeNull();
      expect(plus!.disabled).toBe(true);
      expect(plus!.getAttribute("aria-label")).not.toBeNull();
      // No file picker/capability anywhere in the composer surface.
      expect(container.querySelector('input[type="file"]')).toBeNull();
      await act(async () => plus!.click());
      expect(sendConversationMessage).not.toHaveBeenCalled();
    });
  });

  describe("@ autocomplete (runnable-only, keyboard navigable)", () => {
    it("offers only the locally runnable roster, navigates, and inserts text on Enter", async () => {
      render(createElement(Harness, { mode: "active", conversationId: "c1" }));
      const input = textarea();

      // "@d" matches only runnable dipu; offline zora never appears.
      await act(async () => typeText(input, "please @d"));
      const popup = container.querySelector<HTMLElement>('[role="listbox"]');
      expect(popup).not.toBeNull();
      expect(popup!.textContent).toContain("@dipu");
      expect(popup!.textContent).not.toContain("@zora");

      // ArrowDown then Enter selects the active option and edits text only.
      await act(async () => key(input, "ArrowDown"));
      await act(async () => key(input, "Enter"));
      expect(input.value).toBe("please @dipu ");
      expect(container.querySelector('[role="listbox"]')).toBeNull();
      // No dispatch/recipient derivation happened: only the raw text was sent.
      expect(sendConversationMessage).not.toHaveBeenCalled();
    });

    it("Escape dismisses the popup without inserting and without submitting", async () => {
      render(createElement(Harness, { mode: "active", conversationId: "c1" }));
      const input = textarea();
      await act(async () => typeText(input, "@d"));
      expect(container.querySelector('[role="listbox"]')).not.toBeNull();
      await act(async () => key(input, "Escape"));
      expect(container.querySelector('[role="listbox"]')).toBeNull();
      expect(input.value).toBe("@d");
      expect(sendConversationMessage).not.toHaveBeenCalled();
    });

    it("typing past the token (after a space) closes the popup", async () => {
      render(createElement(Harness, { mode: "active", conversationId: "c1" }));
      const input = textarea();
      await act(async () => typeText(input, "@dipu "));
      expect(container.querySelector('[role="listbox"]')).toBeNull();
    });

    it("after an Escape dismissal, editing the token resynchronizes the picker even when the match count is unchanged", async () => {
      // Two runnable agents match both "@d" and "@di": the match COUNT is
      // identical before and after the token edit, so the picker must resync
      // on the text/caret change (U3 correction).
      const roster: RoomAgentEntry[] = [
        { name: "dipu", online: true },
        { name: "dima", online: true },
        { name: "zora", online: false },
      ];
      render(createElement(Harness, { mode: "active", conversationId: "c1", agents: roster }));
      const input = textarea();

      await act(async () => typeText(input, "@d"));
      const popup = container.querySelector<HTMLElement>('[role="listbox"]');
      expect(popup).not.toBeNull();
      expect(popup!.textContent).toContain("@dipu");
      expect(popup!.textContent).toContain("@dima");

      await act(async () => key(input, "Escape"));
      expect(container.querySelector('[role="listbox"]')).toBeNull();

      // Edit the token @d -> @di: the SAME two runnable matches (dipu and
      // dima both start with "di"), but the picker must reopen on the edit.
      await act(async () => typeText(input, "@di"));
      const reopened = container.querySelector<HTMLElement>('[role="listbox"]');
      expect(reopened).not.toBeNull();
      expect(reopened!.textContent).toContain("@dipu");
      expect(reopened!.textContent).toContain("@dima");
      // The offline agent is never offered.
      expect(reopened!.textContent).not.toContain("@zora");
    });
  });

  describe("draft persistence boundary", () => {
    it("the draft composer sends nothing until its first existing raw-text send succeeds", async () => {
      const onCreated = vi.fn();
      render(createElement(Harness, { mode: "draft", onCreated }));
      const input = textarea();
      await act(async () => typeText(input, "draft first message"));
      // Typing a draft persists nothing and sends nothing.
      expect(createConversation).not.toHaveBeenCalled();
      expect(onCreated).not.toHaveBeenCalled();
      // Enter (or the Send button) performs the existing first-message
      // activation with the raw text only.
      await act(async () => key(input, "Enter"));
      expect(createConversation).toHaveBeenCalledTimes(1);
      expect(createConversation).toHaveBeenCalledWith("test-token", "draft first message");
      expect(onCreated).toHaveBeenCalledWith(CONVERSATION);
    });

    it("an empty draft does not create anything", async () => {
      render(createElement(Harness, { mode: "draft" }));
      const input = textarea();
      await act(async () => typeText(input, "   "));
      await act(async () => key(input, "Enter"));
      expect(createConversation).not.toHaveBeenCalled();
    });
  });
});
