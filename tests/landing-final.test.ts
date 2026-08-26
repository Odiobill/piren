import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * L5 landing-page static regression: the accepted 0.2 film, documented
 * quickstart order, footer links, and the no-em-dash public-copy boundary.
 */
const root = process.cwd();
const landing = readFileSync(join(root, "site/index.html"), "utf8");

describe("landing L5 film, quickstart, footer, and copy hygiene", () => {
  it("points only at the accepted 0.2 film and its thumbnail", () => {
    expect(landing).toContain("https://youtu.be/lYJcP_hXT4k");
    expect(landing).toContain("https://img.youtube.com/vi/lYJcP_hXT4k/hqdefault.jpg");
    expect(landing).not.toContain("M6anngSckxs");
  });

  it("documents the quickstart order and required footer links", () => {
    const start = landing.slice(landing.indexOf('id="start"'), landing.indexOf("<footer>"));
    const curl = start.indexOf("pi.dev/install.sh");
    const login = start.indexOf("/login");
    const install = start.indexOf("npm install -g @odiobill/piren");
    const setup = start.indexOf("piren setup");
    expect(curl).toBeGreaterThan(-1);
    expect(login).toBeGreaterThan(curl);
    expect(install).toBeGreaterThan(login);
    expect(setup).toBeGreaterThan(install);
    expect(start).toContain("piren telegram configure");
    expect(start).toContain("piren discord configure");

    const footer = landing.slice(landing.indexOf("<footer>"));
    expect(footer).toContain("github.com/Odiobill/piren");
    expect(footer).toContain("npmjs.com/package/@odiobill/piren");
    expect(footer).toContain("CHANGELOG.md");
    expect(footer).toContain("pi.dev");
  });

  it("contains no em-dash punctuation in visible copy", () => {
    expect(landing).not.toContain("&mdash;");
    expect(landing).not.toContain("—");
  });
});
