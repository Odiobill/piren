// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONVERSATION_SCROLL_ANCHOR_THRESHOLD_PX,
  isScrollAnchored,
  nextScrollTopForAppend,
  reducedMotionPreferred,
  scrollBehaviorFor,
  type ConversationScrollMetrics,
} from "../web/src/conversation-scroll-anchor.js";

/**
 * P6 — pure transcript scroll-anchor core (accepted contract §3): the single
 * chronological conversation scroll region is bottom-anchored by default;
 * appended durable/transient content scrolls to the bottom ONLY while the
 * reader was anchored to the pre-append bottom, and a deliberate upward
 * reading position is preserved exactly (no forced jump); scrolling back to
 * the bottom re-anchors. Reduced-motion is honored. These tests are pure
 * plus one jsdom integration proof of the DOM application path.
 */

function metrics(overrides: Partial<ConversationScrollMetrics>): ConversationScrollMetrics {
  return { scrollTop: 0, clientHeight: 300, scrollHeight: 3000, ...overrides };
}

describe("isScrollAnchored (pure)", () => {
  it("is anchored when the content fits entirely", () => {
    expect(isScrollAnchored(metrics({ scrollHeight: 200, clientHeight: 300 }))).toBe(true);
  });

  it("is anchored exactly at the bottom", () => {
    expect(isScrollAnchored(metrics({ scrollTop: 2700 }))).toBe(true);
  });

  it("is anchored within the threshold of the bottom", () => {
    expect(isScrollAnchored(metrics({ scrollTop: 2700 - (CONVERSATION_SCROLL_ANCHOR_THRESHOLD_PX - 1) }))).toBe(true);
  });

  it("is NOT anchored when the reader scrolled up beyond the threshold", () => {
    expect(isScrollAnchored(metrics({ scrollTop: 2700 - CONVERSATION_SCROLL_ANCHOR_THRESHOLD_PX - 1 }))).toBe(false);
  });
});

describe("nextScrollTopForAppend (pure, pre-append anchor state)", () => {
  it("follows appends for a reader anchored to the pre-append bottom", () => {
    const before = metrics({ scrollTop: 2700 });
    expect(nextScrollTopForAppend(before, 3600)).toBe(3600);
  });

  it("returns null for an upward reader (preserve scrollTop, no forced jump)", () => {
    const before = metrics({ scrollTop: 1000 });
    expect(nextScrollTopForAppend(before, 3600)).toBeNull();
  });

  it("re-anchors once the reader scrolls back to the bottom", () => {
    const before = metrics({ scrollTop: 3300, scrollHeight: 3600 });
    expect(nextScrollTopForAppend(before, 4200)).toBe(4200);
  });
});

describe("reduced motion (pure)", () => {
  it("reducedMotionPreferred reads the matchMedia matches flag and fails safe to non-reduced", () => {
    expect(reducedMotionPreferred(undefined)).toBe(false);
    expect(reducedMotionPreferred({ matches: false })).toBe(false);
    expect(reducedMotionPreferred({ matches: true })).toBe(true);
  });

  it("scrollBehaviorFor maps reduced motion to auto, otherwise smooth", () => {
    expect(scrollBehaviorFor(true)).toBe("auto");
    expect(scrollBehaviorFor(false)).toBe("smooth");
  });
});

describe("DOM application path (jsdom integration)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    Object.defineProperty(container, "clientHeight", { value: 300, configurable: true });
    document.body.appendChild(container);
  });

  afterEach(() => {
    container?.remove();
  });

  function fill(scrollHeight: number): void {
    container.innerHTML = `<div style="height:${scrollHeight}px"></div>`;
    Object.defineProperty(container, "scrollHeight", { value: scrollHeight, configurable: true });
  }

  /** Capture pre-append metrics, grow the content, then apply the append decision. */
  function applyAppend(newScrollHeight: number): number | null {
    const before = {
      scrollTop: container.scrollTop,
      clientHeight: container.clientHeight,
      scrollHeight: container.scrollHeight,
    };
    fill(newScrollHeight);
    const target = nextScrollTopForAppend(before, newScrollHeight);
    if (target !== null) {
      container.scrollTop = target;
    }
    return target;
  }

  it("an anchored reader follows appended content to the new bottom", () => {
    fill(3000);
    container.scrollTop = 2700;
    const target = applyAppend(3600);
    expect(target).toBe(3600);
    expect(container.scrollTop).toBe(3600);
    expect(
      isScrollAnchored({ scrollTop: container.scrollTop, clientHeight: container.clientHeight, scrollHeight: container.scrollHeight }),
    ).toBe(true);
  });

  it("an upward reader keeps scrollTop unchanged when content appends (no forced jump)", () => {
    fill(3000);
    container.scrollTop = 1000;
    const target = applyAppend(3600);
    expect(target).toBeNull();
    expect(container.scrollTop).toBe(1000);
  });

  it("scrolling back to the bottom re-anchors", () => {
    fill(3000);
    container.scrollTop = 1000;
    expect(applyAppend(3600)).toBeNull();
    container.scrollTop = 3300; // back to the (new) bottom
    expect(applyAppend(4200)).toBe(4200);
  });
});
