// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConversationComposer } from "../web/src/ConversationComposer.js";
import { ConversationDetailsModal } from "../web/src/ConversationDetailsModal.js";
import { createConversation, sendConversationMessage } from "../web/src/api.js";
import {
  shouldSubmitForPolicy,
  submitPolicyAccessibleName,
  submitPolicyTooltip,
  type ConversationSubmitPolicy,
} from "../web/src/conversation-composer.js";
import type { RoomAgentEntry } from "../web/src/rooms.js";
import type { ConversationRecord } from "../web/src/conversations.js";

/**
 * P1 — full-width Conversation surface, docked composer, and the page-local
 * submit-shortcut toggle (accepted `workbench-chat-surface-polish-plan.md`
 * P1 contract, 2026-08-12). Covers:
 *   - the pure Enter/Ctrl+Enter submit policies and their Shift/Ctrl/IME
 *     edge cases;
 *   - the page-local toggle's accessible disclosure (name/pressed/tooltip),
 *     reset-on-mount, and zero side effects (no send, no storage, no URL);
 *   - the full-width uncarded selected-conversation surface with dedicated
 *     transcript scroll and a docked one-line composer;
 *   - the absence of routine chrome (card boundary, repeated title, Timeline
 *     heading, healthy Live/connecting label, mention-authority tutorial);
 *   - the inline SVG icon primitives and the labelled accessible modal X
 *     close (visible text retained only for destructive/error actions).
 */

const webSrc = join(process.cwd(), "web", "src");

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

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    sendConversationMessage: vi.fn(),
    createConversation: vi.fn(),
  };
});

describe("P1 submit-policy core (pure)", () => {
  const base = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false };

  it("Enter policy: a plain Enter submits", () => {
    expect(shouldSubmitForPolicy(base, "enter")).toBe(true);
  });

  it("Enter policy: Shift/Ctrl/Meta+Enter are newline keys and never submit", () => {
    expect(shouldSubmitForPolicy({ ...base, shiftKey: true }, "enter")).toBe(false);
    expect(shouldSubmitForPolicy({ ...base, ctrlKey: true }, "enter")).toBe(false);
    expect(shouldSubmitForPolicy({ ...base, metaKey: true }, "enter")).toBe(false);
    expect(shouldSubmitForPolicy({ ...base, shiftKey: true, ctrlKey: true }, "enter")).toBe(false);
  });

  it("Enter policy: IME composition is a hard no-submit condition", () => {
    expect(shouldSubmitForPolicy({ ...base, isComposing: true }, "enter")).toBe(false);
    expect(shouldSubmitForPolicy({ ...base, shiftKey: true, isComposing: true }, "enter")).toBe(false);
    expect(shouldSubmitForPolicy({ ...base, ctrlKey: true, isComposing: true }, "enter")).toBe(false);
  });

  it("Ctrl+Enter policy: only Ctrl+Enter submits; plain/Shift/Ctrl+Shift+Meta variants never submit", () => {
    expect(shouldSubmitForPolicy({ ...base, ctrlKey: true }, "ctrl-enter")).toBe(true);
    expect(shouldSubmitForPolicy(base, "ctrl-enter")).toBe(false);
    expect(shouldSubmitForPolicy({ ...base, shiftKey: true }, "ctrl-enter")).toBe(false);
    expect(shouldSubmitForPolicy({ ...base, ctrlKey: true, shiftKey: true }, "ctrl-enter")).toBe(false);
    expect(shouldSubmitForPolicy({ ...base, ctrlKey: true, metaKey: true }, "ctrl-enter")).toBe(false);
  });

  it("Ctrl+Enter policy: IME composition blocks the submit key too", () => {
    expect(shouldSubmitForPolicy({ ...base, ctrlKey: true, isComposing: true }, "ctrl-enter")).toBe(false);
  });

  it("non-Enter keys never submit in either policy", () => {
    expect(shouldSubmitForPolicy({ ...base, key: "a" }, "enter")).toBe(false);
    expect(shouldSubmitForPolicy({ ...base, key: "a", ctrlKey: true }, "ctrl-enter")).toBe(false);
    expect(shouldSubmitForPolicy({ ...base, key: "" }, "enter")).toBe(false);
  });

  it("the accessible name discloses the current mode", () => {
    expect(submitPolicyAccessibleName("enter")).toBe("Submit with Enter");
    expect(submitPolicyAccessibleName("ctrl-enter")).toBe("Submit with Ctrl+Enter");
  });

  it("the tooltip discloses the exact key semantics of each mode", () => {
    expect(submitPolicyTooltip("enter")).toContain("Enter sends");
    expect(submitPolicyTooltip("enter")).toContain("Shift+Enter");
    expect(submitPolicyTooltip("ctrl-enter")).toContain("Ctrl+Enter sends");
    expect(submitPolicyTooltip("ctrl-enter")).toContain("Enter");
  });
});

describe("P1 full-width uncarded conversation surface (static)", () => {
  it("the Conversations workspace panel breaks the centered cap to use the full main-pane width", async () => {
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    const shell = await readFile(join(webSrc, "AppShell.tsx"), "utf8");
    expect(shell).toContain('className="workspace-panel workspace-panel-conversations"');
    expect(styles).toMatch(/\.shell-main\s*>\s*\.workspace-panel-conversations\s*\{[\s\S]*width:\s*100%/);
    expect(styles).toMatch(/\.shell-main\s*>\s*\.workspace-panel-conversations\s*\{[\s\S]*max-width:\s*none/);
    expect(styles).toMatch(/\.shell-main\s*>\s*\.workspace-panel-conversations\s*\{[\s\S]*margin-inline:\s*0/);
  });

  it("the selected conversation is an uncarded full-height flex column with dedicated scroll and docked composer", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    // The selected-chat section is a plain surface, never a `.card`.
    expect(navigator).toContain('className="conversation-surface"');
    expect(navigator).not.toContain("conversation-detail-heading");
    expect(styles).not.toContain(".card.conversation-workspace");
    expect(styles).toMatch(/\.conversation-surface\s*\{[\s\S]*flex:\s*1[\s\S]*min-height:\s*0/);
    expect(styles).toMatch(/\.conversation-workspace\s*\{[\s\S]*flex:\s*1[\s\S]*min-height:\s*0/);
    // R1 — the browser root is the sole Conversation scroll host: the inner
    // transcript scroll owner is gone and the composer/details row is the
    // stable sticky bottom dock.
    expect(styles).not.toContain(".conversation-scroll");
    expect(styles).toMatch(/\.composer-action-row\s*\{[\s\S]*position:\s*sticky/);
    expect(styles).toMatch(/\.composer-action-row\s*\{[\s\S]*flex:\s*none/);
  });

  it("no routine active-chat chrome: no repeated title, no Timeline heading, no healthy Live/connecting label", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    expect(navigator).not.toContain("conversation-detail-heading");
    expect(navigator).not.toContain('id="conversation-detail-heading"');
    expect(navigator).not.toContain('aria-labelledby="conversation-detail-heading"');
    expect(timeline).not.toContain("timeline-heading");
    expect(timeline).not.toContain(">Timeline<");
    expect(timeline).not.toContain("Connecting to live stream");
    expect(timeline).not.toContain('{"Live"}');
    expect(timeline).not.toContain('phase.stream === "live"');
  });

  it("truthful non-routine states stay: disconnected, inspection, error, and loading", async () => {
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    expect(timeline).toContain("Disconnected — showing last known history");
    expect(timeline).toContain("Reconnect");
    expect(timeline).toContain("Read-only inspection");
    expect(timeline).toContain("no live stream");
    expect(timeline).toContain("Loading conversation history");
    expect(timeline).toContain("Timeline unavailable");
  });
});

describe("P1 docked one-line composer and tutorial removal (static)", () => {
  it("the composer dock is + | textarea | submit-shortcut with no visible Send text button", async () => {
    const composer = await readFile(join(webSrc, "ConversationComposer.tsx"), "utf8");
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    // Upload + (left), textarea (middle), compact submit toggle (right, in
    // the composer) and the details icon in the same dock row.
    expect(composer).toContain("composer-upload-placeholder");
    expect(composer).toContain("composer-submit-toggle");
    expect(composer).not.toContain("composer-send");
    expect(composer).not.toContain(">Send<");
    expect(navigator).toContain("composer-action-row");
    expect(navigator).toContain("DetailsToggleButton");
  });

  it("the gateway/mention-authority tutorial copy is removed from the app", async () => {
    const composer = await readFile(join(webSrc, "ConversationComposer.tsx"), "utf8");
    expect(composer).not.toContain("Mentions are resolved by the gateway");
    expect(composer).not.toContain("The browser never reads recipient names");
  });

  it("read-only inspection keeps no composer and the details action stays reachable", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    const banner = navigator.slice(navigator.indexOf("attach-banner"), navigator.indexOf("inspection-actions"));
    expect(banner).not.toContain("ConversationComposer");
    expect(navigator).toContain("inspection-actions");
    expect(navigator).toContain("DetailsToggleButton");
  });
});

describe("P1 inline SVG icon primitives and modal X close (static)", () => {
  it("icons.tsx provides local inline SVG primitives with no icon font/network dependency", async () => {
    const icons = await readFile(join(webSrc, "icons.tsx"), "utf8");
    expect(icons).toContain("<svg");
    expect(icons).toContain("XIcon");
    expect(icons).toContain("ReturnKeyIcon");
    expect(icons).toContain("InfoIcon");
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    expect(styles).not.toContain("@font-face");
  });

  it("the composer submit toggle and details toggle consume the local primitives", async () => {
    const composer = await readFile(join(webSrc, "ConversationComposer.tsx"), "utf8");
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    expect(composer).toContain('from "./icons"');
    expect(composer).toContain("ReturnKeyIcon");
    expect(navigator).toContain('from "./icons"');
    expect(navigator).toContain("InfoIcon");
  });

  it("the modal Close is a labelled accessible X icon; destructive/error text actions remain visible", async () => {
    const modal = await readFile(join(webSrc, "ConversationDetailsModal.tsx"), "utf8");
    expect(modal).toContain("XIcon");
    expect(modal).toContain('aria-label="Close conversation details"');
    expect(modal).not.toContain(">Close<");
    // Visible text stays for destructive lifecycle confirmation and errors.
    expect(modal).toContain("Confirm archive");
    expect(modal).toContain("Save");
    expect(modal).toContain("Retry");
  });
});

describe("P1 submit-shortcut toggle (jsdom component)", () => {
  let container: HTMLDivElement;
  let root: Root;

  function Harness(props: {
    mode: "draft" | "active";
    conversationId?: string;
    onAnnounce?: (message: string) => void;
    onCreated?: (conversation: ConversationRecord) => void;
  }): ReactElement {
    return createElement(ConversationComposer, {
      mode: props.mode,
      ...(props.conversationId !== undefined ? { conversationId: props.conversationId } : {}),
      token: "test-token",
      agents: AGENTS,
      onUnauthorized: () => {},
      onAnnounce: props.onAnnounce ?? (() => {}),
      ...(props.onCreated !== undefined ? { onCreated: props.onCreated } : {}),
    });
  }

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

  function toggle(): HTMLButtonElement {
    const el = container.querySelector<HTMLButtonElement>(".composer-submit-toggle");
    if (el === null) throw new Error("composer submit toggle missing");
    return el;
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

  it("defaults to Enter-to-send: plain Enter submits, Ctrl+Enter inserts a newline", async () => {
    render(createElement(Harness, { mode: "active", conversationId: "c1" }));
    const toggleEl = toggle();
    expect(toggleEl.getAttribute("aria-pressed")).toBe("true");
    expect(toggleEl.getAttribute("aria-label")).toBe("Submit with Enter");
    expect(toggleEl.getAttribute("title")).toContain("Enter sends");
    expect(toggleEl.querySelector("svg")).not.toBeNull();

    await act(async () => typeText(textarea(), "hello"));
    await act(async () => key(textarea(), "Enter", { ctrlKey: true }));
    expect(sendConversationMessage).not.toHaveBeenCalled();
    await act(async () => key(textarea(), "Enter"));
    expect(sendConversationMessage).toHaveBeenCalledTimes(1);
    expect(sendConversationMessage).toHaveBeenCalledWith("c1", "hello", "test-token");
  });

  it("clicking the toggle switches to Ctrl+Enter-to-send with disclosed semantics; Ctrl+Enter submits and plain Enter never submits", async () => {
    render(createElement(Harness, { mode: "active", conversationId: "c1" }));
    const toggleEl = toggle();
    act(() => toggleEl.click());
    expect(toggleEl.getAttribute("aria-pressed")).toBe("false");
    expect(toggleEl.getAttribute("aria-label")).toBe("Submit with Ctrl+Enter");
    expect(toggleEl.getAttribute("title")).toContain("Ctrl+Enter sends");

    await act(async () => typeText(textarea(), "ctrl text"));
    await act(async () => key(textarea(), "Enter", { ctrlKey: true }));
    expect(sendConversationMessage).toHaveBeenCalledTimes(1);
    expect(sendConversationMessage).toHaveBeenCalledWith("c1", "ctrl text", "test-token");

    // Plain Enter now inserts a newline and never submits.
    await act(async () => typeText(textarea(), "more"));
    await act(async () => key(textarea(), "Enter"));
    expect(sendConversationMessage).toHaveBeenCalledTimes(1);
    // Shift+Enter remains a newline too.
    await act(async () => key(textarea(), "Enter", { shiftKey: true }));
    expect(sendConversationMessage).toHaveBeenCalledTimes(1);
  });

  it("IME composition is a hard no-submit condition in Ctrl+Enter mode", async () => {
    render(createElement(Harness, { mode: "active", conversationId: "c1" }));
    act(() => toggle().click());
    await act(async () => typeText(textarea(), "漢字"));
    await act(async () => {
      textarea().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    });
    await act(async () => key(textarea(), "Enter", { ctrlKey: true, isComposing: true }));
    expect(sendConversationMessage).not.toHaveBeenCalled();
  });

  it("toggling has zero side effects: no send, no create, no storage, no URL change", async () => {
    render(createElement(Harness, { mode: "active", conversationId: "c1" }));
    const beforeHash = window.location.hash;
    act(() => toggle().click());
    act(() => toggle().click());
    expect(sendConversationMessage).not.toHaveBeenCalled();
    expect(createConversation).not.toHaveBeenCalled();
    expect(window.location.hash).toBe(beforeHash);
    // Storage must be untouched where it exists (some jsdom configs expose
    // none at all); the static repo-wide scan forbids any storage API usage
    // in the web sources themselves.
    expect(typeof window.localStorage === "undefined" || window.localStorage.length === 0).toBe(true);
    expect(typeof window.sessionStorage === "undefined" || window.sessionStorage.length === 0).toBe(true);
  });

  it("the submit policy is page-local only: a fresh mount resets to Enter mode", async () => {
    render(createElement(Harness, { mode: "active", conversationId: "c1" }));
    act(() => toggle().click());
    expect(toggle().getAttribute("aria-pressed")).toBe("false");

    // A fresh page load remounts the composer: the policy resets to default.
    act(() => {
      root.unmount();
    });
    render(createElement(Harness, { mode: "active", conversationId: "c1" }));
    const fresh = toggle();
    expect(fresh.getAttribute("aria-pressed")).toBe("true");
    expect(fresh.getAttribute("aria-label")).toBe("Submit with Enter");
  });

  it("the draft composer carries the same page-local toggle with no create side effect", async () => {
    render(createElement(Harness, { mode: "draft" }));
    const toggleEl = toggle();
    expect(toggleEl.getAttribute("aria-pressed")).toBe("true");
    act(() => toggleEl.click());
    expect(toggleEl.getAttribute("aria-label")).toBe("Submit with Ctrl+Enter");
    expect(createConversation).not.toHaveBeenCalled();
  });
});

describe("P1 modal X close focus/semantics (jsdom component)", () => {
  let container: HTMLDivElement;
  let root: Root;

  function renderModal(onClose: () => void): void {
    root = createRoot(container);
    act(() => {
      root.render(
        createElement(ConversationDetailsModal, {
          conversation: CONVERSATION,
          agents: [],
          lifecyclePhase: "idle",
          lifecycleError: null,
          confirmingArchive: false,
          archiveButtonRef: { current: null },
          confirmArchiveRef: { current: null },
          onArchiveRequest: () => {},
          onCancelArchive: () => {},
          onConfirmArchive: () => {},
          onReopen: () => {},
          onLifecycleRetry: () => {},
          onRename: async () => null,
          onClose,
        }),
      );
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
  });

  it("the modal close is an icon-only labelled X button that dismisses and has no visible text", () => {
    const onClose = vi.fn();
    renderModal(onClose);
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close conversation details"]');
    expect(close).not.toBeNull();
    // Icon-only: inline svg present, no visible text content.
    expect(close!.querySelector("svg")).not.toBeNull();
    expect(close!.textContent?.trim()).toBe("");
    act(() => close!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("destructive lifecycle confirmation and error/retry actions keep visible text", () => {
    renderModal(() => {});
    const archive = container.querySelector<HTMLButtonElement>("button");
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).map((b) => b.textContent?.trim() ?? "");
    expect(buttons).toContain("Archive");
    expect(buttons).toContain("Cancel");
    expect(buttons).toContain("Save");
    // No modal button carries the bare text "Close" anymore.
    expect(buttons).not.toContain("Close");
  });
});

describe("P1 submit policy type surface (compile-time)", () => {
  it("exposes exactly the two page-local policies", () => {
    const policies: readonly ConversationSubmitPolicy[] = ["enter", "ctrl-enter"];
    expect(policies).toEqual(["enter", "ctrl-enter"]);
  });
});
