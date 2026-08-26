import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * L1 landing-page static regression: the marketing site stylesheet must carry
 * the accepted light editorial visual system tokens and honor reduced motion.
 *
 * The tokens mirror the accepted 0.2 presentation DESIGN.md identity and the
 * landing-page refactor plan:
 *   Paper #F8F6F0, Ink #0B1D3A, Piren Red #D32328, Apricot #F2A46F,
 *   Mist #DCE7EE, Charcoal #14191D.
 *
 * Charcoal is a frame/matte token only; it never recolors product UI. This
 * test pins the token set and the paper canvas plus the reduced-motion rule,
 * not the exact shade of every derived semantic alias.
 */
const root = process.cwd();

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

describe("landing page light editorial visual system (L1)", () => {
  it("defines the accepted light editorial design tokens", () => {
    const css = read("site/style.css");
    for (const token of [
      "--paper: #F8F6F0",
      "--ink: #0B1D3A",
      "--red: #D32328",
      "--apricot: #F2A46F",
      "--mist: #DCE7EE",
      "--charcoal: #14191D",
    ]) {
      expect(css, `missing token ${token}`).toContain(token);
    }
  });

  it("uses the paper canvas for the page and shows the full logo image", () => {
    const css = read("site/style.css");
    expect(css).toContain("background: var(--paper)");
    // The hero is the full original logo image; the animated wordmark and its
    // ink recolor rule are gone.
    expect(css).not.toContain("#piren-hero-text text");
  });

  it("disables logo and transition motion under reduced motion", () => {
    const css = read("site/style.css");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
