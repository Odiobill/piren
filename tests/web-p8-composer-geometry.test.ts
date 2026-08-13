import { describe, expect, it } from "vitest";
import {
  COMPOSER_CONTROL_SIZE_PX,
  COMPOSER_GEOMETRY,
  composerBoxHeightPx,
  oneLineComposerBoxHeightPx,
} from "../web/src/composer-geometry.js";

/**
 * P8 (accepted `conversation-p8-pilot-correction-contract.md` §2) — REAL
 * rendered vertical alignment: the one-line textarea border-box MUST equal
 * the 44px control box exactly (today's 1.4 line-height renders 44.4px —
 * the bottom edge sits 0.4px below the controls). Deterministic geometry
 * equation, no screenshot guessing. This module does not exist yet: RED.
 */

describe("composer geometry (P8 §2 deterministic equation)", () => {
  it("the one-line border-box equals the 44px control size exactly (RED: today 44.4)", () => {
    expect(oneLineComposerBoxHeightPx()).toBe(COMPOSER_CONTROL_SIZE_PX);
  });

  it("the geometry equation holds: lines·fontSize·lineHeight + 2·padding + 2·border", () => {
    const { fontSizePx, lineHeight, paddingYPx, borderWidthPx } = COMPOSER_GEOMETRY;
    const one = 1 * fontSizePx * lineHeight + 2 * paddingYPx + 2 * borderWidthPx;
    expect(composerBoxHeightPx(1, COMPOSER_GEOMETRY)).toBe(one);
    expect(one).toBe(COMPOSER_CONTROL_SIZE_PX);
  });

  it("multiline boxes grow monotonically and stay border-box deterministic", () => {
    const two = composerBoxHeightPx(2, COMPOSER_GEOMETRY);
    const three = composerBoxHeightPx(3, COMPOSER_GEOMETRY);
    expect(two).toBeGreaterThan(COMPOSER_CONTROL_SIZE_PX);
    expect(three).toBeGreaterThan(two);
    // Exactly one content line per added line (no sub-pixel drift):
    expect(two - oneLineComposerBoxHeightPx()).toBe(COMPOSER_GEOMETRY.fontSizePx * COMPOSER_GEOMETRY.lineHeight);
    expect(three - two).toBe(COMPOSER_GEOMETRY.fontSizePx * COMPOSER_GEOMETRY.lineHeight);
  });

  it("tokens are deterministic integers/halves (no per-viewport pixel guessing)", () => {
    expect(COMPOSER_CONTROL_SIZE_PX).toBe(44);
    expect(Number.isInteger(COMPOSER_GEOMETRY.fontSizePx)).toBe(true);
    expect(Number.isInteger(COMPOSER_GEOMETRY.paddingYPx)).toBe(true);
    expect(Number.isInteger(COMPOSER_GEOMETRY.borderWidthPx)).toBe(true);
    expect(Number.isFinite(COMPOSER_GEOMETRY.lineHeight)).toBe(true);
  });
});
