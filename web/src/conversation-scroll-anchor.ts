/**
 * P6 — pure bottom-anchored transcript scroll core (accepted contract §3).
 *
 * The single chronological conversation scroll region is bottom-anchored by
 * default next to the docked composer. When content appends at the bottom
 * (durable items or permissible transient activity), the region scrolls to
 * the bottom ONLY when the reader was anchored to the PRE-append bottom; a
 * deliberate upward reading position is preserved exactly (no forced jump),
 * and scrolling back to the bottom re-anchors. Reduced-motion is honored by
 * mapping the scroll behavior.
 *
 * The decision must use the pre-append metrics: in a real browser appending
 * content grows `scrollHeight` without moving `scrollTop`, so a post-append
 * "near bottom" check would be false even for a reader who was exactly at
 * the bottom. The thin DOM wiring therefore keeps the last-known pre-append
 * scrollHeight and passes it here. This module is DOM-free.
 */

/** The deterministic near-bottom threshold (px) below which the reader is still "anchored". */
export const CONVERSATION_SCROLL_ANCHOR_THRESHOLD_PX = 24;

export interface ConversationScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/** True when the viewport is at (or within `threshold` of) the given bottom. */
export function isScrollAnchored(
  metrics: ConversationScrollMetrics,
  threshold: number = CONVERSATION_SCROLL_ANCHOR_THRESHOLD_PX,
): boolean {
  if (metrics.scrollHeight <= metrics.clientHeight) return true;
  return metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - threshold;
}

/**
 * The next scrollTop after content was appended to reach `afterScrollHeight`:
 * - reader anchored to the pre-append bottom → the new bottom (follows);
 * - upward reader → null (preserve their exact reading position).
 */
export function nextScrollTopForAppend(
  before: ConversationScrollMetrics,
  afterScrollHeight: number,
  threshold: number = CONVERSATION_SCROLL_ANCHOR_THRESHOLD_PX,
): number | null {
  if (!isScrollAnchored(before, threshold)) return null;
  return afterScrollHeight;
}

/** Reduced-motion preference from an optional matchMedia result; fails safe to false. */
export function reducedMotionPreferred(mql: { matches: boolean } | undefined): boolean {
  return mql?.matches ?? false;
}

/** Scroll behavior honoring reduced motion: "auto" (instant) or "smooth". */
export function scrollBehaviorFor(reduceMotion: boolean): ScrollBehavior {
  return reduceMotion ? "auto" : "smooth";
}
