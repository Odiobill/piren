// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConversationComposer } from "../web/src/ConversationComposer.js";
import { sendConversationMessage } from "../web/src/api.js";
import type { ConversationAgentEntry } from "../web/src/conversation-agents.js";

/**
 * U2 — composer interlock presentation + state-machine wiring (amendment
 * §6.2). The interlocked composer is visible but non-editable: read-only
 * textarea with aria-disabled="true" and a visible reason referenced by
 * aria-describedby; submit/policy controls disabled; one polite announcement
 * per interlock change; never moves focus, scrolls, fetches, or mutates.
 */

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return { ...actual, sendConversationMessage: vi.fn() };
});

const AGENTS: ConversationAgentEntry[] = [{ name: "dipu", online: true }];

function Harness(props: {
  conversationId: string;
  interlocked?: boolean;
  interlockReason?: string;
  onAnnounce?: (message: string) => void;
  onSent?: () => void;
}): ReturnType<typeof createElement> {
  return createElement(ConversationComposer, {
    conversationId: props.conversationId,
    token: "test-token",
    agents: AGENTS,
    onUnauthorized: () => {},
    onAnnounce: props.onAnnounce ?? (() => {}),
    interlocked: props.interlocked ?? false,
    interlockReason: props.interlockReason ?? "",
    ...(props.onSent !== undefined ? { onSent: props.onSent } : {}),
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

describe("ConversationComposer interlock (U2)", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(element: ReturnType<typeof createElement>): void {
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

  function reason(): HTMLElement | null {
    return container.querySelector<HTMLElement>('[id$="-interlock-reason"]');
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.mocked(sendConversationMessage).mockReset().mockResolvedValue({ event: { id: "e1", conversationId: "c1", kind: "steward_message", created: "2026-08-11T00:00:00.000Z" } });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
  });

  it("interlocked: read-only textarea, aria-disabled, aria-describedby reason, disabled submit/policy controls", async () => {
    render(createElement(Harness, { conversationId: "c1", interlocked: true, interlockReason: "Dipu is working…" }));
    const input = textarea();
    expect(input.readOnly).toBe(true);
    expect(input.getAttribute("aria-disabled")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("conversation-message-c1-interlock-reason");
    expect(reason()?.textContent).toBe("Dipu is working…");
    // The policy toggle (the only submit-adjacent control) is disabled.
    const toggle = container.querySelector<HTMLButtonElement>(".composer-submit-toggle");
    expect(toggle?.disabled).toBe(true);
  });

  it("preserves an unsent draft byte-for-byte across interlock begin/clear", async () => {
    const onAnnounce = vi.fn();
    render(createElement(Harness, { conversationId: "c1", onAnnounce }));
    await act(async () => typeText(textarea(), "unsent \u2026 draft"));
    expect(textarea().value).toBe("unsent \u2026 draft");

    // Interlock begins: the draft is preserved read-only.
    act(() => root.render(createElement(Harness, { conversationId: "c1", interlocked: true, interlockReason: "Dipu is working…", onAnnounce })));
    expect(textarea().readOnly).toBe(true);
    expect(textarea().value).toBe("unsent \u2026 draft");
    expect(onAnnounce).toHaveBeenLastCalledWith("Dipu is working…");

    // Interlock clears: the draft is restored editable byte-for-byte.
    act(() => root.render(createElement(Harness, { conversationId: "c1", interlocked: false, onAnnounce })));
    expect(textarea().readOnly).toBe(false);
    expect(textarea().value).toBe("unsent \u2026 draft");
    expect(onAnnounce).toHaveBeenLastCalledWith("Composer available.");
  });

  it("VR-1: clears the composer IMMEDIATELY on submit, before the deferred POST resolves", async () => {
    let resolveSend: (() => void) | undefined;
    vi.mocked(sendConversationMessage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSend = () => resolve({ event: { id: "e1", conversationId: "c1", kind: "steward_message", created: "2026-08-11T00:00:00.000Z" } });
        }),
    );
    render(createElement(Harness, { conversationId: "c1" }));
    await act(async () => typeText(textarea(), "sent while in flight"));
    act(() => key(textarea(), "Enter"));
    // The visible text is already gone BEFORE the POST resolves.
    expect(textarea().value).toBe("");
    await act(async () => resolveSend?.());
    // Accepted: still empty; nothing is retained for later display.
    expect(textarea().value).toBe("");
    expect(textarea().readOnly).toBe(false);
  });

  it("VR-1: an accepted send followed by interlock shows an EMPTY read-only composer, then an empty editable composer", async () => {
    const onAnnounce = vi.fn();
    render(createElement(Harness, { conversationId: "c1", onAnnounce }));
    await act(async () => typeText(textarea(), "please do this"));
    await act(async () => key(textarea(), "Enter"));
    expect(textarea().value).toBe("");

    // The run the send caused now interlocks the composer: EMPTY, never the
    // accepted message re-shown as a read-only acknowledgement.
    act(() => root.render(createElement(Harness, { conversationId: "c1", interlocked: true, interlockReason: "Dipu is working…", onAnnounce })));
    expect(textarea().readOnly).toBe(true);
    expect(textarea().value).toBe("");

    // Interlock clears: empty editable composer; the durable timeline item
    // remains the only evidence of the send.
    act(() => root.render(createElement(Harness, { conversationId: "c1", interlocked: false, onAnnounce })));
    expect(textarea().readOnly).toBe(false);
    expect(textarea().value).toBe("");
  });

  it("VR-1: an interlock beginning mid-flight shows an empty read-only composer before resolution and never resurrects the sent text", async () => {
    let resolveSend: (() => void) | undefined;
    vi.mocked(sendConversationMessage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSend = () => resolve({ event: { id: "e1", conversationId: "c1", kind: "steward_message", created: "2026-08-11T00:00:00.000Z" } });
        }),
    );
    render(createElement(Harness, { conversationId: "c1" }));
    await act(async () => typeText(textarea(), "in-flight accepted send"));
    act(() => key(textarea(), "Enter"));

    // Broker activity arrives while the POST is in flight: empty read-only
    // composer (the cleared state is protected), NOT the sent message.
    act(() => root.render(createElement(Harness, { conversationId: "c1", interlocked: true, interlockReason: "Dipu is working…" })));
    await act(async () => resolveSend?.());
    expect(textarea().readOnly).toBe(true);
    expect(textarea().value).toBe("");

    act(() => root.render(createElement(Harness, { conversationId: "c1", interlocked: false })));
    expect(textarea().readOnly).toBe(false);
    expect(textarea().value).toBe("");
  });

  it("VR-1: a send failing while a real mid-flight interlock is active preserves the exact draft READ-ONLY until the interlock clears", async () => {
    let rejectSend: ((cause: unknown) => void) | undefined;
    vi.mocked(sendConversationMessage).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSend = (cause) => reject(cause);
        }),
    );
    render(createElement(Harness, { conversationId: "c1" }));
    await act(async () => typeText(textarea(), "failed under protection \u2026"));
    act(() => key(textarea(), "Enter"));

    // A REAL interlock begins mid-flight: the composer is read-only empty.
    act(() => root.render(createElement(Harness, { conversationId: "c1", interlocked: true, interlockReason: "Dipu is working…" })));
    expect(textarea().readOnly).toBe(true);

    // The POST fails while the real interlock holds: the exact failed draft
    // is preserved INSIDE the read-only interlock — never an editable bypass.
    await act(async () => rejectSend?.(new Error("boom")));
    expect(container.querySelector("[role='status']")?.textContent).toBe("boom");
    expect(textarea().readOnly).toBe(true);
    expect(textarea().value).toBe("failed under protection \u2026");

    // It becomes editable only when the real interlock clears, byte-for-byte.
    act(() => root.render(createElement(Harness, { conversationId: "c1", interlocked: false })));
    expect(textarea().readOnly).toBe(false);
    expect(textarea().value).toBe("failed under protection \u2026");
  });

  it("VR-1: a later unrelated interlock after an accepted send does not resurrect the accepted text", async () => {
    render(createElement(Harness, { conversationId: "c1" }));
    await act(async () => typeText(textarea(), "accepted earlier"));
    await act(async () => key(textarea(), "Enter"));
    expect(sendConversationMessage).toHaveBeenCalledTimes(1);
    expect(textarea().value).toBe("");
    // An independent later run interlocks: nothing of the old send returns.
    act(() => root.render(createElement(Harness, { conversationId: "c1", interlocked: true, interlockReason: "zai is typing…" })));
    expect(textarea().readOnly).toBe(true);
    expect(textarea().value).toBe("");
  });

  it("an accepted send with no following interlock stays editable and cleared (clear-on-success regression)", async () => {
    render(createElement(Harness, { conversationId: "c1" }));
    await act(async () => typeText(textarea(), "quick note"));
    await act(async () => key(textarea(), "Enter"));
    expect(textarea().value).toBe("");
    expect(textarea().readOnly).toBe(false);
  });

  it("does not reuse a prior no-interlock send as an acknowledgement after the steward resumes drafting", async () => {
    render(createElement(Harness, { conversationId: "c1" }));
    await act(async () => typeText(textarea(), "old accepted message"));
    await act(async () => key(textarea(), "Enter"));
    // Transition 4: the accepted send had no authoritative interlock and is
    // cleared. A later, independent broker interlock must preserve the new
    // unsent draft, never resurrect that old message as an acknowledgement.
    await act(async () => typeText(textarea(), "new unsent draft"));
    act(() => root.render(createElement(Harness, { conversationId: "c1", interlocked: true, interlockReason: "Dipu is working…" })));
    expect(textarea().readOnly).toBe(true);
    expect(textarea().value).toBe("new unsent draft");
  });

  it("a failed send stays editable with the bounded error surfaced and never acknowledges", async () => {
    vi.mocked(sendConversationMessage).mockRejectedValueOnce(new Error("boom"));
    render(createElement(Harness, { conversationId: "c1" }));
    await act(async () => typeText(textarea(), "will fail"));
    await act(async () => key(textarea(), "Enter"));
    expect(textarea().readOnly).toBe(false);
    expect(textarea().value).toBe("will fail");
    expect(container.querySelector("[role='status']")?.textContent).toBe("boom");
  });

  it("interlock transitions never fetch, never move focus, and never scroll", async () => {
    render(createElement(Harness, { conversationId: "c1" }));
    const input = textarea();
    await act(async () => typeText(input, "draft"));
    // Move focus away from the composer deliberately.
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    const scrollSpy = vi.fn();
    (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = scrollSpy;
    const sendCalls = vi.mocked(sendConversationMessage).mock.calls.length;

    act(() => root.render(createElement(Harness, { conversationId: "c1", interlocked: true, interlockReason: "Dipu is working…" })));
    act(() => root.render(createElement(Harness, { conversationId: "c1", interlocked: false })));

    // No new send call, focus still on the other element, no scroll.
    expect(vi.mocked(sendConversationMessage).mock.calls.length).toBe(sendCalls);
    expect(document.activeElement).toBe(other);
    expect(scrollSpy).not.toHaveBeenCalled();
    other.remove();
  });

  it("an interlocked composer cannot submit via Enter", async () => {
    render(createElement(Harness, { conversationId: "c1", interlocked: true, interlockReason: "Approval required for Dipu" }));
    const input = textarea();
    await act(async () => key(input, "Enter"));
    expect(sendConversationMessage).not.toHaveBeenCalled();
  });
});
