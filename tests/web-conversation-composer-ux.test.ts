import { describe, expect, it } from "vitest";
import {
  clampComposerHeight,
  COMPOSER_MAX_HEIGHT_PX,
  COMPOSER_MIN_HEIGHT_PX,
  estimateComposerHeightPx,
  shouldSubmitForPolicy,
  submitPolicyAccessibleName,
  submitPolicyTooltip,
} from "../web/src/conversation-composer.js";

/**
 * U3 + P1 — pure composer UX core (accepted 0.2.0 UX plan §U3 and the P1
 * submit-shortcut contract): the Enter-to-send policy submits only on a
 * plain Enter (Shift/Ctrl/Meta+Enter insert a newline; any IME composition
 * state prevents premature submit); the Ctrl+Enter-to-send policy submits
 * only on Ctrl+Enter (Enter/Shift+Enter insert newlines; IME still blocks).
 * The auto-growing height math is bounded and deterministic.
 */

describe("shouldSubmitForPolicy (keyboard semantics)", () => {
  const base = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false };

  it("Enter policy: a plain Enter submits", () => {
    expect(shouldSubmitForPolicy(base, "enter")).toBe(true);
  });

  it("Enter policy: Shift/Ctrl/Meta+Enter insert a newline and never submit", () => {
    expect(shouldSubmitForPolicy({ ...base, shiftKey: true }, "enter")).toBe(false);
    expect(shouldSubmitForPolicy({ ...base, ctrlKey: true }, "enter")).toBe(false);
    expect(shouldSubmitForPolicy({ ...base, metaKey: true }, "enter")).toBe(false);
    expect(shouldSubmitForPolicy({ ...base, shiftKey: true, ctrlKey: true }, "enter")).toBe(false);
  });

  it("Enter policy: any IME/composition state prevents premature submit", () => {
    expect(shouldSubmitForPolicy({ ...base, isComposing: true }, "enter")).toBe(false);
    expect(shouldSubmitForPolicy({ ...base, shiftKey: true, isComposing: true }, "enter")).toBe(false);
    expect(shouldSubmitForPolicy({ ...base, ctrlKey: true, isComposing: true }, "enter")).toBe(false);
  });

  it("Ctrl+Enter policy: only Ctrl+Enter submits; plain/Shift/Meta variants never submit", () => {
    expect(shouldSubmitForPolicy({ ...base, ctrlKey: true }, "ctrl-enter")).toBe(true);
    expect(shouldSubmitForPolicy(base, "ctrl-enter")).toBe(false);
    expect(shouldSubmitForPolicy({ ...base, shiftKey: true }, "ctrl-enter")).toBe(false);
    expect(shouldSubmitForPolicy({ ...base, ctrlKey: true, shiftKey: true }, "ctrl-enter")).toBe(false);
    expect(shouldSubmitForPolicy({ ...base, ctrlKey: true, metaKey: true }, "ctrl-enter")).toBe(false);
  });

  it("Ctrl+Enter policy: IME composition blocks the submit key too", () => {
    expect(shouldSubmitForPolicy({ ...base, ctrlKey: true, isComposing: true }, "ctrl-enter")).toBe(false);
  });

  it("non-Enter keys never submit in either policy", () => {
    expect(shouldSubmitForPolicy({ ...base, key: "a" }, "enter")).toBe(false);
    expect(shouldSubmitForPolicy({ ...base, key: "a", ctrlKey: true }, "ctrl-enter")).toBe(false);
    expect(shouldSubmitForPolicy({ ...base, key: "" }, "enter")).toBe(false);
  });
});

describe("submit policy labels (accessible disclosure)", () => {
  it("the accessible name discloses the current submit mode", () => {
    expect(submitPolicyAccessibleName("enter")).toBe("Submit with Enter");
    expect(submitPolicyAccessibleName("ctrl-enter")).toBe("Submit with Ctrl+Enter");
  });

  it("the tooltip discloses the exact key semantics of each mode", () => {
    expect(submitPolicyTooltip("enter")).toContain("Enter sends");
    expect(submitPolicyTooltip("enter")).toContain("Shift+Enter");
    expect(submitPolicyTooltip("ctrl-enter")).toContain("Ctrl+Enter sends");
    expect(submitPolicyTooltip("ctrl-enter")).toContain("Enter");
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
