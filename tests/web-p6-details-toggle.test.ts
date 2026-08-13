// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DetailsToggleButton } from "../web/src/ConversationNavigator.js";

/**
 * P6 — a11y jsdom proof of the docked `Conversation details` action: in the
 * browser-local draft it is present but DISABLED with the truthful accessible
 * name and a truthful title (no modal, no click); on an active/read-only
 * surface it is enabled and opens the modal.
 */

function render(element: ReactElement): Root {
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return root;
}

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  container?.remove();
});

describe("DetailsToggleButton (P6 disabled draft semantics)", () => {
  it("the disabled draft button keeps the accessible name and exposes the truthful title", () => {
    render(
      createElement(DetailsToggleButton, {
        buttonRef: { current: null },
        disabled: true,
        title: "Conversation details become available after the first message is sent",
      }),
    );
    const button = container.querySelector<HTMLButtonElement>(".conversation-details-toggle");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-label")).toBe("Conversation details");
    expect(button?.getAttribute("title")).toBe("Conversation details become available after the first message is sent");
    expect(button?.disabled).toBe(true);
  });

  it("a disabled draft button never fires a click handler (no modal path)", () => {
    const onClick = vi.fn();
    render(
      createElement(DetailsToggleButton, {
        buttonRef: { current: null },
        disabled: true,
        title: "Conversation details become available after the first message is sent",
        onClick,
      }),
    );
    const button = container.querySelector<HTMLButtonElement>(".conversation-details-toggle");
    button?.click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("the enabled active/read-only button fires the click and has no disabled/title state", () => {
    const onClick = vi.fn();
    render(createElement(DetailsToggleButton, { buttonRef: { current: null }, onClick }));
    const button = container.querySelector<HTMLButtonElement>(".conversation-details-toggle");
    expect(button?.disabled).toBe(false);
    expect(button?.hasAttribute("title")).toBe(false);
    button?.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
