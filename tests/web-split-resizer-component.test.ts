// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SplitResizer } from "../web/src/SplitResizer.js";
import { CHAT_PANE_MIN_PX, COMPANION_PANE_MIN_PX, RESIZER_STEP_PX } from "../web/src/split-workspace.js";

/**
 * W1 (accepted companion split architecture §3; 0.2.0 amendment §3): the
 * real accessible resizer — focusable `role="separator"` with horizontal
 * orientation, bounded aria-valuemin/max/now (chat pane height px), ArrowUp/
 * ArrowDown 10px step, Home/End min/max, and pointer drag via WINDOW
 * pointermove/pointerup listeners with cleanup. Keyboard focus stays on the
 * resizer; no per-tick live-region announcements.
 */

const MIN = CHAT_PANE_MIN_PX;
const MAX = 800 - COMPANION_PANE_MIN_PX; // 600 for an 800px workspace

let container: HTMLDivElement;
let root: Root;

function key(handle: HTMLElement, keyValue: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: keyValue, bubbles: true, cancelable: true, ...init });
  handle.dispatchEvent(event);
  return event;
}

function pointer(target: EventTarget, type: string, clientY: number): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientY }));
}

interface Harness {
  handle: HTMLElement;
  onChange: ReturnType<typeof vi.fn>;
  onCommit: ReturnType<typeof vi.fn>;
}

async function renderResizer(overrides: Record<string, unknown> = {}): Promise<Harness> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onChange = vi.fn();
  const onCommit = vi.fn();
  await act(async () => {
    root.render(
      createElement(SplitResizer, {
        label: "Resize chat pane",
        value: 400,
        min: MIN,
        max: MAX,
        onChange,
        onCommit,
        ...overrides,
      }),
    );
  });
  const handle = container.querySelector('[role="separator"]') as HTMLElement;
  if (handle === null) throw new Error("missing separator");
  return { handle, onChange, onCommit };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

describe("SplitResizer: accessible separator semantics", () => {
  it("renders a focusable horizontal separator with bounded chat-pane-height value", async () => {
    const { handle } = await renderResizer();
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
    expect(handle.getAttribute("aria-label")).toBe("Resize chat pane");
    expect(handle.getAttribute("aria-valuemin")).toBe(String(MIN));
    expect(handle.getAttribute("aria-valuemax")).toBe(String(MAX));
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
    expect(handle.tabIndex).toBe(0);
  });

  it("does not use per-tick live-region announcements", async () => {
    const { handle } = await renderResizer();
    expect(handle.hasAttribute("aria-live")).toBe(false);
    expect(container.querySelector('[aria-live]')).toBeNull();
  });
});

describe("SplitResizer: keyboard", () => {
  it("ArrowUp commits +10px and ArrowDown commits -10px, preventing page scroll", async () => {
    const { handle, onCommit } = await renderResizer();
    const up = key(handle, "ArrowUp");
    expect(up.defaultPrevented).toBe(true);
    expect(onCommit).toHaveBeenLastCalledWith(410);
    const down = key(handle, "ArrowDown");
    expect(down.defaultPrevented).toBe(true);
    expect(onCommit).toHaveBeenLastCalledWith(390);
  });

  it("Home commits the minimum and End commits the maximum", async () => {
    const { handle, onCommit } = await renderResizer();
    key(handle, "Home");
    expect(onCommit).toHaveBeenLastCalledWith(MIN);
    key(handle, "End");
    expect(onCommit).toHaveBeenLastCalledWith(MAX);
  });

  it("steps clamp at the bounds", async () => {
    const { handle, onCommit } = await renderResizer({ value: MAX });
    key(handle, "ArrowUp");
    expect(onCommit).toHaveBeenLastCalledWith(MAX);
  });

  it("focus stays on the resizer after keyboard interaction", async () => {
    const { handle } = await renderResizer();
    handle.focus();
    key(handle, "ArrowUp");
    expect(document.activeElement).toBe(handle);
  });
});

describe("SplitResizer: pointer drag with window move/up cleanup", () => {
  it("dragging up grows the chat pane; dragging down shrinks it; pointerup commits", async () => {
    const { handle, onChange, onCommit } = await renderResizer();
    await act(async () => pointer(handle, "pointerdown", 100));
    await act(async () => window.dispatchEvent(new PointerEvent("pointermove", { clientY: 60 })));
    expect(onChange).toHaveBeenLastCalledWith(440); // start 400 + (100 - 60)
    await act(async () => window.dispatchEvent(new PointerEvent("pointermove", { clientY: 0 })));
    expect(onChange).toHaveBeenLastCalledWith(500);
    await act(async () => window.dispatchEvent(new PointerEvent("pointerup", { clientY: 0 })));
    expect(onCommit).toHaveBeenLastCalledWith(500);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("clamps the drag into the bounds", async () => {
    const { handle, onChange } = await renderResizer();
    await act(async () => pointer(handle, "pointerdown", 100));
    await act(async () => window.dispatchEvent(new PointerEvent("pointermove", { clientY: 1000 })));
    expect(onChange).toHaveBeenLastCalledWith(MIN);
    await act(async () => window.dispatchEvent(new PointerEvent("pointermove", { clientY: -1000 })));
    expect(onChange).toHaveBeenLastCalledWith(MAX);
    await act(async () => window.dispatchEvent(new PointerEvent("pointerup", { clientY: -1000 })));
  });

  it("removes the window listeners after pointerup (no dangling move handling)", async () => {
    const { handle, onChange } = await renderResizer();
    const removeSpy = vi.spyOn(window, "removeEventListener");
    await act(async () => pointer(handle, "pointerdown", 100));
    await act(async () => window.dispatchEvent(new PointerEvent("pointermove", { clientY: 90 })));
    await act(async () => window.dispatchEvent(new PointerEvent("pointerup", { clientY: 90 })));
    expect(removeSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("pointerup", expect.any(Function));
    const callsAfterUp = onChange.mock.calls.length;
    await act(async () => window.dispatchEvent(new PointerEvent("pointermove", { clientY: 0 })));
    expect(onChange.mock.calls.length).toBe(callsAfterUp);
  });
});
