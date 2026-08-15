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
 * ADR-0044 Tracer B: the target is the actual history scroll host resolved
 * by `conversationScrollTarget` (the active Conversation's named history
 * region), not the document root.
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
 * ADR-0044 Tracer B — resolve the actual Conversation scroll target: the
 * named `.conversation-history` region inside the selected surface when the
 * surface provides one (the ACTIVE Conversation, where the history region is
 * the sole Conversation scroll host), else the document root scrolling
 * element (the R1 document-flow behavior retained by read-only inspection
 * and the no-selection surface, which have no history host). Returns null
 * only when neither exists. Never fabricates a host and never targets the
 * page root for a surface that has its own history region — an active
 * Conversation open/append can never scroll the Dashboard, the no-selection
 * or read-only views, or the page root.
 */
export function conversationScrollTarget(surface: Element | null, doc: Document): ConversationScrollTarget | null {
  const host = surface?.querySelector(".conversation-history");
  if (host !== null && host !== undefined) {
    return host as ConversationScrollTarget;
  }
  return doc.scrollingElement;
}

/**
 * The navigator remains mounted while another Workbench page is selected so
 * a live Conversation run is never cancelled. Scroll anchoring must not
 * therefore scroll the browser away from that selected page on an unseen
 * append. The shell's existing `[hidden]` panel state is the source of truth.
 */
export function shouldApplyConversationScroll(surface: Element | null): boolean {
  return surface !== null && surface.closest(".workspace-panel[hidden]") === null;
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
