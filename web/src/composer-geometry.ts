/**
 * P8 (§2) — deterministic composer geometry core (accepted
 * `conversation-p8-pilot-correction-contract.md`).
 *
 * The REAL rendered one-line textarea border-box MUST equal the 44px control
 * box exactly: `lines·fontSize·lineHeight + 2·padding + 2·border` (border-box).
 * Today's 1.4 line-height renders 16×1.4 + 20 + 2 = 44.4px — the bottom edge
 * sits 0.4px below the controls. The adjusted token set (line-height 1.375)
 * makes the equation hold exactly at one line; the dock's `align-items:
 * flex-end` keeps the bottom edge flush while autosizing. No screenshot
 * pixel guessing: the pure equation + a real-browser layout probe prove it.
 */

export const COMPOSER_CONTROL_SIZE_PX = 44;

export interface ComposerGeometryTokens {
  /** Textarea font size in px (1rem). */
  fontSizePx: number;
  /** Unitless line-height (16 × 1.375 = 22px content line). */
  lineHeight: number;
  /** Vertical padding per side in px. */
  paddingYPx: number;
  /** Border width per side in px (global box-sizing: border-box). */
  borderWidthPx: number;
}

/**
 * The token set the stylesheet and the runtime autosize path must use so the
 * governing equation holds exactly (16 × 1.375 + 2×10 + 2×1 = 44).
 */
export const COMPOSER_GEOMETRY: ComposerGeometryTokens = {
  fontSizePx: 16,
  lineHeight: 1.375,
  paddingYPx: 10,
  borderWidthPx: 1,
};

/** Border-box height of an n-line composer textarea, deterministic. */
export function composerBoxHeightPx(lines: number, tokens: ComposerGeometryTokens): number {
  return lines * tokens.fontSizePx * tokens.lineHeight + 2 * tokens.paddingYPx + 2 * tokens.borderWidthPx;
}

/** The one-line border-box height; must equal COMPOSER_CONTROL_SIZE_PX. */
export function oneLineComposerBoxHeightPx(): number {
  return composerBoxHeightPx(1, COMPOSER_GEOMETRY);
}
