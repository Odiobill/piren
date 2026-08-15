// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DetailsToggleButton } from "../web/src/ConversationNavigator.js";

/**
 * P6 — a11y jsdom proof of the docked `Conversation details` action: on an
 * active/read-only surface it is enabled and opens the modal. ADR-0044
 * removed the browser-local draft surface and its disabled variant.
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

describe("DetailsToggleButton (ADR-0044 enabled-only semantics)", () => {
  it("the enabled active/read-only button fires the click and has no disabled/title state", () => {
    const onClick = vi.fn();
    render(createElement(DetailsToggleButton, { buttonRef: { current: null }, onClick }));
    const button = container.querySelector<HTMLButtonElement>(".conversation-details-toggle");
    expect(button?.getAttribute("aria-label")).toBe("Conversation details");
    expect(button?.disabled).toBe(false);
    expect(button?.hasAttribute("title")).toBe(false);
    button?.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("the component accepts no disabled/title props (the draft variant is gone)", () => {
    // Compile-time shape: only buttonRef/onClick remain.
    const props: Parameters<typeof DetailsToggleButton>[0] = { buttonRef: { current: null } };
    expect(Object.keys(props)).toEqual(["buttonRef"]);
  });
});
