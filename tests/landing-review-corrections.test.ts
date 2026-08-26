import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Landing review corrections: full logo image, reviewed captures, and
 * Workbench-first post-setup configuration guidance.
 */
const root = process.cwd();
const landing = readFileSync(join(root, "site/index.html"), "utf8");

describe("landing review corrections", () => {
  it("uses the full logo image and removes the hero animation script", () => {
    expect(landing).toContain('src="assets/piren-full-logo.png"');
    expect(landing).not.toContain("hero-logo.js");
    expect(landing).not.toContain('id="piren-hero-text"');
  });

  it("references the reviewed captures and drops the stale screenshot", () => {
    expect(landing).toContain('src="assets/workbench-vault.png"');
    expect(landing).toContain('src="assets/workbench-conversation.png"');
    expect(landing).not.toContain("assets/webui-screenshot.png");
  });

  it("presents Workbench configuration before the transport wizards after setup", () => {
    const start = landing.slice(landing.indexOf('id="start"'), landing.indexOf("<footer>"));
    const gateway = start.indexOf("piren gateway");
    const wizard = start.indexOf("piren telegram configure");
    expect(gateway).toBeGreaterThan(-1);
    expect(wizard).toBeGreaterThan(gateway);
    expect(start).toContain("http://127.0.0.1:7317/");
    expect(start).toContain("does not start services");
    expect(start).toContain("provider credentials");
    expect(start).toContain("gateway token");
    expect(start).toContain("runnable-agent policy");
  });
});
