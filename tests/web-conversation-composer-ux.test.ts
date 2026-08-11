import { describe, expect, it } from "vitest";
import {
  clampComposerHeight,
  COMPOSER_MAX_HEIGHT_PX,
  COMPOSER_MIN_HEIGHT_PX,
  estimateComposerHeightPx,
  shouldSubmitOnEnter,
} from "../web/src/conversation-composer.js";

/**
 * U3 — pure composer UX core (accepted 0.2.0 UX plan §U3): Enter submits
 * only for a plain Enter (Shift+Enter inserts a newline; any IME composition
 * state must prevent premature submit), and the auto-growing height math is
 * bounded and deterministic.
 */

describe("shouldSubmitOnEnter (keyboard semantics)", () => {
  it("a plain Enter submits", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true);
  });

  it("Shift+Enter inserts a newline and never submits", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: true, isComposing: false })).toBe(false);
  });

  it("any IME/composition state prevents premature submit", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: true, isComposing: true })).toBe(false);
  });

  it("non-Enter keys never submit", () => {
    expect(shouldSubmitOnEnter({ key: "a", shiftKey: false, isComposing: false })).toBe(false);
    expect(shouldSubmitOnEnter({ key: "", shiftKey: false, isComposing: false })).toBe(false);
  });
});

describe("composer autogrow height math", () => {
  it("clamps the content height to the bounded composer range", () => {
    expect(clampComposerHeight(0, COMPOSER_MIN_HEIGHT_PX, COMPOSER_MAX_HEIGHT_PX)).toBe(COMPOSER_MIN_HEIGHT_PX);
    expect(clampComposerHeight(80, COMPOSER_MIN_HEIGHT_PX, COMPOSER_MAX_HEIGHT_PX)).toBe(80);
    expect(clampComposerHeight(5000, COMPOSER_MIN_HEIGHT_PX, COMPOSER_MAX_HEIGHT_PX)).toBe(COMPOSER_MAX_HEIGHT_PX);
    expect(COMPOSER_MIN_HEIGHT_PX).toBeLessThan(COMPOSER_MAX_HEIGHT_PX);
  });

  it("estimates a bounded height that grows with lines and wrapped text", () => {
    expect(estimateComposerHeightPx("")).toBe(COMPOSER_MIN_HEIGHT_PX);
    expect(estimateComposerHeightPx("one line")).toBeGreaterThanOrEqual(COMPOSER_MIN_HEIGHT_PX);
    // A multi-line message is taller than a single line.
    const single = estimateComposerHeightPx("short");
    const multi = estimateComposerHeightPx("a\nb\nc\nd\ne");
    expect(multi).toBeGreaterThan(single);
    // A very long single line wraps (conservative estimate) but stays capped.
    const huge = estimateComposerHeightPx("x".repeat(2000), { charsPerLine: 60, lineHeightPx: 22 });
    expect(huge).toBe(COMPOSER_MAX_HEIGHT_PX);
    // A very short message never collapses below the minimum.
    expect(estimateComposerHeightPx("x", { charsPerLine: 60, lineHeightPx: 22 })).toBeGreaterThanOrEqual(COMPOSER_MIN_HEIGHT_PX);
  });
});
