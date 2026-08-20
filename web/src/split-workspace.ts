/**
 * W1 (0.2.0 scope amendment §3; accepted companion split architecture §2/§3/
 * §4) — pure split-workspace core. DOM-free: in-memory split state, balanced
 * 50/50 initial split, deterministic min/max clamp (chat pane >= 280px,
 * companion pane >= 200px), 10px keyboard step, Home/End bounds, pointer-drag
 * height math, and the mobile/portrait one-pane-at-a-time selection. The
 * shell component measures the available height and feeds it in; nothing here
 * reads pixels, storage, or the network.
 */

/** Minimum chat pane height (px): docked composer + minimum transcript. */
export const CHAT_PANE_MIN_PX = 280;
/** Minimum companion pane height (px). */
export const COMPANION_PANE_MIN_PX = 200;
/** Deterministic keyboard resize step (px). */
export const RESIZER_STEP_PX = 10;
/** Existing workbench mobile/portrait layout breakpoint (px). */
export const SPLIT_MOBILE_BREAKPOINT_PX = 560;

/** The mobile one-pane-at-a-time selection. */
export type MobileSplitPane = "chat" | "companion";

export interface SplitWorkspaceState {
  /** True when a companion module is open (desktop split or mobile one-pane). */
  open: boolean;
  /**
   * Chat pane height px in the desktop split; null = balanced 50/50 default
   * (first open in a session). In-memory only; never persisted.
   */
  chatHeightPx: number | null;
  /** Mobile/portrait one-pane-at-a-time selection. */
  mobilePane: MobileSplitPane;
}

export function initialSplitWorkspaceState(): SplitWorkspaceState {
  return { open: false, chatHeightPx: null, mobilePane: "chat" };
}

/** Clamp a value into [min, max]. */
export function clampSplitValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface SplitBounds {
  min: number;
  max: number;
}

/**
 * Deterministic chat-pane bounds for an available split height. `max` is the
 * available height minus the companion minimum. Degenerate heights below the
 * two minimums collapse both bounds onto the chat minimum (deterministic;
 * desktop sizes never reach it).
 */
export function splitBounds(availableHeight: number): SplitBounds {
  return {
    min: CHAT_PANE_MIN_PX,
    max: Math.max(CHAT_PANE_MIN_PX, availableHeight - COMPANION_PANE_MIN_PX),
  };
}

/** Clamp a chat pane height into the deterministic bounds. */
export function clampChatPaneHeight(height: number, availableHeight: number): number {
  const { min, max } = splitBounds(availableHeight);
  return clampSplitValue(height, min, max);
}

/** The balanced 50/50 default, clamped into the bounds. */
export function balancedChatPaneHeight(availableHeight: number): number {
  return clampChatPaneHeight(Math.round(availableHeight / 2), availableHeight);
}

/**
 * Open the split. Idempotent. First open in a session uses the balanced
 * default; a later open keeps the session's in-memory resized height.
 */
export function openSplitWorkspace(state: SplitWorkspaceState, availableHeight: number): SplitWorkspaceState {
  if (state.open) return state;
  return {
    ...state,
    open: true,
    chatHeightPx: state.chatHeightPx ?? balancedChatPaneHeight(availableHeight),
  };
}

/** Close the split. Idempotent; the in-memory height is retained for this session. */
export function closeSplitWorkspace(state: SplitWorkspaceState): SplitWorkspaceState {
  if (!state.open) return state;
  return { ...state, open: false };
}

/**
 * The effective chat pane height: the balanced default when unset, otherwise
 * the stored height clamped against the current available height (so a
 * viewport change re-clamps deterministically on read).
 */
export function chatPaneHeight(state: SplitWorkspaceState, availableHeight: number): number {
  return state.chatHeightPx === null
    ? balancedChatPaneHeight(availableHeight)
    : clampChatPaneHeight(state.chatHeightPx, availableHeight);
}

/** Keyboard step: ArrowUp grows the chat pane by 10px, ArrowDown shrinks it. */
export function stepChatPaneHeight(
  state: SplitWorkspaceState,
  direction: "up" | "down",
  availableHeight: number,
): SplitWorkspaceState {
  const delta = direction === "up" ? RESIZER_STEP_PX : -RESIZER_STEP_PX;
  const next = clampChatPaneHeight(chatPaneHeight(state, availableHeight) + delta, availableHeight);
  return { ...state, chatHeightPx: next };
}

/** Home resolves the minimum chat height, End the maximum. */
export function chatPaneHeightAtBound(bound: "min" | "max", availableHeight: number): number {
  const { min, max } = splitBounds(availableHeight);
  return bound === "min" ? min : max;
}

/** Pointer/absolute set: clamp the requested height into the bounds. */
export function setChatPaneHeight(state: SplitWorkspaceState, height: number, availableHeight: number): SplitWorkspaceState {
  return { ...state, chatHeightPx: clampChatPaneHeight(height, availableHeight) };
}

/** Switch the mobile one-pane-at-a-time selection. Idempotent. */
export function mobileSelectPane(state: SplitWorkspaceState, pane: MobileSplitPane): SplitWorkspaceState {
  if (state.mobilePane === pane) return state;
  return { ...state, mobilePane: pane };
}

/** The desktop pane heights: chat + companion fill the available height. */
export function splitPaneHeights(
  state: SplitWorkspaceState,
  availableHeight: number,
): { chat: number; companion: number } {
  const chat = chatPaneHeight(state, availableHeight);
  return { chat, companion: Math.max(0, availableHeight - chat) };
}
