import { describe, expect, it } from "vitest";
import {
  COMPANION_PANE_MIN_PX,
  CHAT_PANE_MIN_PX,
  RESIZER_STEP_PX,
  SPLIT_MOBILE_BREAKPOINT_PX,
  balancedChatPaneHeight,
  chatPaneHeight,
  chatPaneHeightAtBound,
  clampChatPaneHeight,
  clampSplitValue,
  closeSplitWorkspace,
  initialSplitWorkspaceState,
  mobileSelectPane,
  openSplitWorkspace,
  setChatPaneHeight,
  splitBounds,
  splitPaneHeights,
  stepChatPaneHeight,
} from "../web/src/split-workspace.js";

/**
 * W1 (0.2.0 scope amendment §3; accepted companion split architecture):
 * pure split-workspace core — in-memory state, balanced 50/50 initial split,
 * deterministic min/max clamp (chat >= 280px, companion >= 200px), 10px
 * keyboard step, Home/End bounds, pointer-drag height math, and the
 * mobile one-pane-at-a-time state. DOM-free.
 */

describe("split workspace constants", () => {
  it("declares the accepted minimums and step deterministically", () => {
    expect(CHAT_PANE_MIN_PX).toBe(280);
    expect(COMPANION_PANE_MIN_PX).toBe(200);
    expect(RESIZER_STEP_PX).toBe(10);
    expect(SPLIT_MOBILE_BREAKPOINT_PX).toBe(560);
  });
});

describe("initialSplitWorkspaceState", () => {
  it("starts closed with a balanced-default (null) chat height and chat mobile pane", () => {
    expect(initialSplitWorkspaceState()).toEqual({ open: false, chatHeightPx: null, mobilePane: "chat" });
  });
});

describe("clampSplitValue / splitBounds / clampChatPaneHeight", () => {
  it("clamps a value into [min, max]", () => {
    expect(clampSplitValue(100, 280, 600)).toBe(280);
    expect(clampSplitValue(700, 280, 600)).toBe(600);
    expect(clampSplitValue(400, 280, 600)).toBe(400);
  });

  it("computes deterministic bounds from the available height", () => {
    expect(splitBounds(800)).toEqual({ min: 280, max: 600 });
    expect(splitBounds(1000)).toEqual({ min: 280, max: 800 });
  });

  it("degenerate small heights degrade deterministically to the chat minimum", () => {
    // availableHeight < chat min + companion min: max collapses onto min.
    expect(splitBounds(479)).toEqual({ min: 280, max: 280 });
    expect(splitBounds(400)).toEqual({ min: 280, max: 280 });
  });

  it("clampChatPaneHeight enforces the bounds", () => {
    expect(clampChatPaneHeight(100, 800)).toBe(280);
    expect(clampChatPaneHeight(700, 800)).toBe(600);
    expect(clampChatPaneHeight(400, 800)).toBe(400);
  });
});

describe("balancedChatPaneHeight", () => {
  it("balances at 50/50 of the available height", () => {
    expect(balancedChatPaneHeight(800)).toBe(400);
    expect(balancedChatPaneHeight(1000)).toBe(500);
  });

  it("clamps the balanced default into the pane bounds", () => {
    expect(balancedChatPaneHeight(560)).toBe(280); // half (280) == min
    expect(balancedChatPaneHeight(700)).toBe(350);
    expect(balancedChatPaneHeight(1600)).toBe(800); // half (800) < max (1400)
    expect(balancedChatPaneHeight(480)).toBe(280); // half (240) < min (280)
  });
});

describe("openSplitWorkspace / closeSplitWorkspace", () => {
  it("first open uses the balanced default", () => {
    const opened = openSplitWorkspace(initialSplitWorkspaceState(), 800);
    expect(opened.open).toBe(true);
    expect(opened.chatHeightPx).toBe(400);
  });

  it("open is idempotent", () => {
    const opened = openSplitWorkspace(initialSplitWorkspaceState(), 800);
    expect(openSplitWorkspace(opened, 800)).toBe(opened);
  });

  it("a later open keeps the session's in-memory resized height", () => {
    let state = openSplitWorkspace(initialSplitWorkspaceState(), 800);
    state = stepChatPaneHeight(state, "up", 800); // 410
    state = closeSplitWorkspace(state);
    expect(state.open).toBe(false);
    expect(state.chatHeightPx).toBe(410);
    const reopened = openSplitWorkspace(state, 800);
    expect(reopened.chatHeightPx).toBe(410);
  });

  it("close is idempotent", () => {
    const closed = closeSplitWorkspace(initialSplitWorkspaceState());
    expect(closeSplitWorkspace(closed)).toBe(closed);
  });
});

describe("chatPaneHeight", () => {
  it("resolves the balanced default when no height was set", () => {
    expect(chatPaneHeight(initialSplitWorkspaceState(), 800)).toBe(400);
  });

  it("clamps a stale stored height on read after a viewport change", () => {
    const state = { open: true, chatHeightPx: 800, mobilePane: "chat" as const };
    expect(chatPaneHeight(state, 600)).toBe(400); // max at 600px available
  });
});

describe("stepChatPaneHeight (keyboard)", () => {
  it("steps 10px up/down from the current height", () => {
    const base = { open: true, chatHeightPx: 400, mobilePane: "chat" as const };
    expect(stepChatPaneHeight(base, "up", 800).chatHeightPx).toBe(410);
    expect(stepChatPaneHeight(base, "down", 800).chatHeightPx).toBe(390);
  });

  it("clamps at the bounds", () => {
    const atMax = { open: true, chatHeightPx: 600, mobilePane: "chat" as const };
    expect(stepChatPaneHeight(atMax, "up", 800).chatHeightPx).toBe(600);
    const atMin = { open: true, chatHeightPx: 280, mobilePane: "chat" as const };
    expect(stepChatPaneHeight(atMin, "down", 800).chatHeightPx).toBe(280);
  });
});

describe("chatPaneHeightAtBound (Home/End)", () => {
  it("Home resolves the minimum, End the maximum", () => {
    expect(chatPaneHeightAtBound("min", 800)).toBe(280);
    expect(chatPaneHeightAtBound("max", 800)).toBe(600);
  });
});

describe("setChatPaneHeight (pointer)", () => {
  it("clamps the absolute height into the bounds", () => {
    const base = { open: true, chatHeightPx: 400, mobilePane: "chat" as const };
    expect(setChatPaneHeight(base, 100, 800).chatHeightPx).toBe(280);
    expect(setChatPaneHeight(base, 900, 800).chatHeightPx).toBe(600);
    expect(setChatPaneHeight(base, 350, 800).chatHeightPx).toBe(350);
  });
});

describe("mobileSelectPane", () => {
  it("switches the one-pane-at-a-time selection and is idempotent", () => {
    const base = { open: true, chatHeightPx: 400, mobilePane: "chat" as const };
    const switched = mobileSelectPane(base, "companion");
    expect(switched.mobilePane).toBe("companion");
    expect(mobileSelectPane(switched, "companion")).toBe(switched);
    expect(mobileSelectPane(switched, "chat").mobilePane).toBe("chat");
  });
});

describe("splitPaneHeights", () => {
  it("chat + companion fill the available height exactly", () => {
    const state = { open: true, chatHeightPx: 400, mobilePane: "chat" as const };
    const { chat, companion } = splitPaneHeights(state, 800);
    expect(chat).toBe(400);
    expect(companion).toBe(400);
  });

  it("never lets the companion pane go negative at degenerate heights", () => {
    const state = { open: true, chatHeightPx: 280, mobilePane: "chat" as const };
    const { chat, companion } = splitPaneHeights(state, 300);
    expect(chat).toBe(280);
    expect(companion).toBe(20);
  });
});
