import { nextScrollTopForAppend, type ConversationScrollMetrics } from "./conversation-scroll-anchor.js";

/**
 * P8 (§5) — commit-time append autoscroll wiring (accepted
 * `conversation-p8-pilot-correction-contract.md`).
 *
 * The anchor decision runs at React COMMIT time (a layout effect driven by a
 * content-version bump), using the PRE-commit metrics from the previous
 * commit: appending grows `scrollHeight` without moving `scrollTop`, so the
 * decision must test the reader against the pre-append bottom. An anchored
 * reader follows durable/activity/summary appends to the new bottom
 * (instant `auto` behavior — P8 amends P6's smooth default to avoid
 * compounding during live bursts); an upward reader keeps the exact
 * position; batch appends in one commit produce ONE correct decision.
 * Reduced-motion stays `auto`/instant. This module is DOM-free and the
 * component wiring calls it from `useLayoutEffect` after each commit.
 */
export interface ConversationScrollWiringState {
  /** Pre-append metrics from the previous commit (null before the first). */
  metrics: ConversationScrollMetrics | null;
  /** True for the initial whole-history load: force the bottom. */
  initialAnchor: boolean;
}

/** Structural scroll-target shape (DOM-free, test-friendly). */
export interface ConversationScrollTarget {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  scrollTo: (options: { top: number; behavior?: ScrollBehavior }) => void;
}

/**
 * R1 — the BROWSER ROOT document is the sole Conversation scroll host: the
 * conversation surface lives in normal document flow (no inner transcript or
 * main-pane scroll owner) so the browser scrollbar sits at the window's
 * right edge. Returns the live root scrolling element (`document.scrollingElement`)
 * as the anchor target, or null when the document exposes none. The wiring
 * calls this at commit time and passes the LIVE element to the pure core, so
 * the pre-append metric semantics are unchanged from the inner-host wiring.
 */
export function rootScrollTarget(doc: Document): ConversationScrollTarget | null {
  return doc.scrollingElement;
}

export const EMPTY_CONVERSATION_SCROLL_WIRING: ConversationScrollWiringState = { metrics: null, initialAnchor: false };

export function applyConversationScrollWiring(
  el: ConversationScrollTarget,
  state: ConversationScrollWiringState,
): ConversationScrollWiringState {
  const current: ConversationScrollMetrics = {
    scrollTop: el.scrollTop,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
  };
  if (state.initialAnchor) {
    el.scrollTo({ top: current.scrollHeight, behavior: "auto" });
  } else if (state.metrics !== null) {
    const target = nextScrollTopForAppend(
      { scrollTop: current.scrollTop, clientHeight: current.clientHeight, scrollHeight: state.metrics.scrollHeight },
      current.scrollHeight,
    );
    if (target !== null) {
      el.scrollTo({ top: target, behavior: "auto" });
    }
  }
  return { metrics: current, initialAnchor: false };
}
