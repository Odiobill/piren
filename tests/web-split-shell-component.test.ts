// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SplitWorkspaceShell } from "../web/src/SplitWorkspaceShell.js";
import {
  CHAT_PANE_MIN_PX,
  COMPANION_PANE_MIN_PX,
  initialSplitWorkspaceState,
  openSplitWorkspace,
  type SplitWorkspaceState,
} from "../web/src/split-workspace.js";

/**
 * W1 (accepted companion split architecture §2/§3/§4; 0.2.0 amendment §3):
 * the split-shell component — a shell-level layout wrapper only. Closed or
 * companion-less it is a DOM pass-through (conversation lifecycle untouched);
 * open with a companion it renders the upper companion pane, the accessible
 * horizontal resizer, and the lower live chat pane, one scroll owner per
 * pane, with the mobile/portrait one-pane-at-a-time labelled toggle (chat
 * stays mounted/live). In-memory state only; no fetch/storage/polling.
 */

const AVAILABLE = 800;

/** jsdom reports clientHeight 0; fix the measured available height. */
function stubClientHeight(height: number): void {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => height,
  });
}

interface MatchMediaLike {
  matches: boolean;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

function stubMatchMedia(matches: boolean): MatchMediaLike {
  const mql: MatchMediaLike = {
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockReturnValue(mql),
  });
  return mql;
}

let container: HTMLDivElement;
let root: Root;

interface ShellHarness {
  onStateChange: ReturnType<typeof vi.fn>;
  onReAnchor: ReturnType<typeof vi.fn>;
  chat: HTMLElement | null;
  companion: HTMLElement | null;
  separator: HTMLElement | null;
}

async function renderShell(overrides: {
  state?: SplitWorkspaceState;
  companion?: ReactNode;
  chatLabel?: string;
  companionLabel?: string;
} = {}): Promise<ShellHarness> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onStateChange = vi.fn();
  const onReAnchor = vi.fn();
  const chatNode = createElement("div", { className: "fake-chat" });
  const companionNode = createElement("div", { className: "fake-companion" });
  await act(async () => {
    root.render(
      createElement(SplitWorkspaceShell, {
        state: overrides.state ?? initialSplitWorkspaceState(),
        onStateChange,
        chat: chatNode,
        companion: overrides.companion === undefined ? undefined : (overrides.companion ?? companionNode),
        resizerLabel: "Resize chat pane",
        chatLabel: overrides.chatLabel ?? "Chat",
        companionLabel: overrides.companionLabel ?? "Vault Explorer",
        onReAnchor,
      }),
    );
  });
  return {
    onStateChange,
    onReAnchor,
    chat: container.querySelector(".fake-chat"),
    companion: container.querySelector(".fake-companion"),
    separator: container.querySelector('[role="separator"]'),
  };
}

function openState(heightPx: number | null = null): SplitWorkspaceState {
  return openSplitWorkspace({ ...initialSplitWorkspaceState(), chatHeightPx: heightPx }, AVAILABLE);
}

beforeEach(() => {
  vi.restoreAllMocks();
  stubClientHeight(AVAILABLE);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

describe("SplitWorkspaceShell: closed-state layout equivalence (W1 fix)", () => {
  it("closed with a companion renders the stable closed shell: chat in the pane path, no companion surface, resizer hidden", async () => {
    const { chat, companion, separator } = await renderShell();
    // The stable-tree shell always renders; closed mode is the `split-closed`
    // layout-neutralized variant (display: contents — layout-equivalent to
    // the old pass-through), so the live chat instance is never remounted.
    expect(container.querySelector(".split-workspace.split-closed")).not.toBeNull();
    expect(container.querySelector(".split-workspace:not(.split-closed)")).toBeNull();
    expect(chat?.closest(".split-closed > .split-chat-pane")).not.toBeNull();
    expect(companion).toBeNull();
    // Resizer exists in the stable tree but is hidden (non-interactive).
    expect(separator).not.toBeNull();
    expect(separator?.closest<HTMLElement>(".split-resizer-host")?.hidden).toBe(true);
    expect(container.children.length).toBe(1);
    expect(container.firstElementChild?.className).toBe("split-workspace split-closed");
  });

  it("open without a companion is still the closed shell (no placeholder surface in W1)", async () => {
    const { chat, companion, separator } = await renderShell({ state: openState(), companion: undefined });
    expect(container.querySelector(".split-workspace.split-closed")).not.toBeNull();
    expect(container.querySelector(".split-workspace:not(.split-closed)")).toBeNull();
    expect(chat).not.toBeNull();
    expect(companion).toBeNull();
    expect(separator?.closest<HTMLElement>(".split-resizer-host")?.hidden).toBe(true);
  });

  it("does not install viewport listeners or media observers while the inert shell is a pass-through", async () => {
    const mql = stubMatchMedia(false);
    const addWindowListener = vi.spyOn(window, "addEventListener");

    await renderShell();

    expect(window.matchMedia).not.toHaveBeenCalled();
    expect(addWindowListener).not.toHaveBeenCalledWith("resize", expect.any(Function));
    expect(mql.addEventListener).not.toHaveBeenCalled();
  });
});

describe("SplitWorkspaceShell: desktop split layout", () => {
  it("renders the upper companion pane, resizer, and lower chat pane with balanced default heights", async () => {
    const { chat, companion, separator, onStateChange, onReAnchor } = await renderShell({
      state: openState(),
      companion: createElement("div", { className: "fake-companion" }),
    });
    const split = container.querySelector(".split-workspace") as HTMLElement;
    expect(split).not.toBeNull();
    expect(companion).not.toBeNull();
    expect(chat).not.toBeNull();
    expect(container.querySelector(".split-mobile-toggle")).not.toBeNull();
    expect(separator?.getAttribute("aria-orientation")).toBe("horizontal");
    // Balanced default for the measured 800px workspace: chat 400, min 280, max 600.
    expect(separator?.getAttribute("aria-valuenow")).toBe("400");
    expect(separator?.getAttribute("aria-valuemin")).toBe(String(CHAT_PANE_MIN_PX));
    expect(separator?.getAttribute("aria-valuemax")).toBe(String(AVAILABLE - COMPANION_PANE_MIN_PX));
    const chatPane = container.querySelector(".split-chat-pane") as HTMLElement;
    expect(chatPane.style.flexBasis).toBe("400px");
    // One labelled pane per side; the toggle is the mobile control.
    expect(container.querySelector(".split-companion-pane")?.getAttribute("aria-label")).toBe("Vault Explorer");
    expect(chatPane.getAttribute("aria-label")).toBe("Chat");
    // Opening rendered nothing focused: no focus theft.
    expect(document.activeElement).not.toBe(separator);
    // Render itself never commits or re-anchors.
    expect(onStateChange).not.toHaveBeenCalled();
    expect(onReAnchor).not.toHaveBeenCalled();
  });

  it("a resizer keyboard step commits the new height and fires the re-anchor signal", async () => {
    const { separator, onStateChange, onReAnchor } = await renderShell({
      state: openState(),
      companion: createElement("div", { className: "fake-companion" }),
    });
    const separatorEl = separator as HTMLElement;
    separatorEl.focus();
    await act(async () => {
      separatorEl.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    });
    expect(onReAnchor).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledTimes(1);
    const next = onStateChange.mock.calls[0]?.[0] as SplitWorkspaceState;
    expect(next.chatHeightPx).toBe(410);
    expect(document.activeElement).toBe(separatorEl);
  });
});

describe("SplitWorkspaceShell: mobile/portrait one-pane-at-a-time", () => {
  it("uses the mobile-or-portrait media query rather than treating only narrow viewports as one-pane", async () => {
    stubMatchMedia(true);

    await renderShell({
      state: openState(),
      companion: createElement("div", { className: "fake-companion" }),
    });

    expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 560px), (orientation: portrait)");
  });

  it("shows one labelled toggle and keeps the chat mounted (hidden, not unmounted)", async () => {
    stubMatchMedia(true); // <= 560px or portrait
    const { chat, companion } = await renderShell({
      state: openState(),
      companion: createElement("div", { className: "fake-companion" }),
    });
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".split-mobile-toggle button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["Chat", "Vault Explorer"]);
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("false");
    // Chat stays mounted and live underneath (hidden), companion hidden until selected.
    expect(chat).not.toBeNull();
    expect(container.querySelector<HTMLElement>(".split-chat-pane")?.hidden).toBe(false);
    expect(container.querySelector<HTMLElement>(".split-companion-pane")?.hidden).toBe(true);
  });

  it("the labelled toggle switches the visible pane through the pure core", async () => {
    stubMatchMedia(true);
    const { onStateChange } = await renderShell({
      state: openState(),
      companion: createElement("div", { className: "fake-companion" }),
    });
    const companionButton = Array.from(container.querySelectorAll<HTMLButtonElement>(".split-mobile-toggle button"))[1];
    expect(companionButton).toBeDefined();
    await act(async () => {
      companionButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onStateChange).toHaveBeenCalledTimes(1);
    const next = onStateChange.mock.calls[0]?.[0] as SplitWorkspaceState;
    expect(next.mobilePane).toBe("companion");
  });
});
