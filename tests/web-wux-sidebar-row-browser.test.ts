import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

/**
 * WUX-A — REAL rendered geometry of the sidebar Vault Explorer row in an
 * actual browser (system Chrome via the minimal declared `puppeteer-core`
 * dev-dependency; W1/W2/P8 precedent). Geometry, not screenshots. Proves the
 * Explorer name control occupies about 80% of the row and its distinct
 * sibling full-page action about 20%, with both controls on one row.
 */

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((candidate): candidate is string => typeof candidate === "string" && candidate !== "");

function findChrome(): string | null {
  return CHROME_CANDIDATES.find((candidate) => {
    try {
      readFileSync(candidate);
      return true;
    } catch {
      return false;
    }
  }) ?? null;
}

const chromePath = findChrome();

function builtCssPath(): string | null {
  const assetsDir = join(process.cwd(), "dist", "public", "assets");
  try {
    const css = readdirSync(assetsDir).find((name) => name.endsWith(".css"));
    return css === undefined ? null : join(assetsDir, css);
  } catch {
    return null;
  }
}

const FIXTURE = (cssUrl: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>WUX-A sidebar Explorer row probe</title>
<link rel="stylesheet" href="${cssUrl}" />
<style>html, body { margin: 0; }</style>
</head>
<body>
<div class="shell">
  <div class="shell-body">
    <div class="sidebar-desktop" style="width: 280px;">
      <nav class="sidebar-nav" aria-label="Main">
        <ul class="sidebar-pages"></ul>
        <ul class="sidebar-companions">
          <li class="sidebar-companion-row">
            <button type="button" id="explorer-toggle" class="nav-item active" aria-pressed="true">
              Vault Explorer
            </button>
            <button type="button" id="explorer-fullpage" class="nav-item sidebar-companion-fullpage"
                    aria-label="Open Vault Explorer full page">
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path d="M15 3h6v6"/></svg>
            </button>
          </li>
        </ul>
      </nav>
    </div>
  </div>
</div>
</body>
</html>`;

const probe = describe.skipIf(chromePath === null || builtCssPath() === null)(
  "WUX-A real-browser sidebar Explorer row geometry probe (system Chrome)",
  () => {
    let browser: Browser;
    let page: Page;
    let fixturePath: string;

    it("setup: launch system Chrome", async () => {
      const launchOptions: Parameters<typeof puppeteer.launch>[0] = { headless: true };
      if (chromePath !== null) launchOptions.executablePath = chromePath;
      browser = await puppeteer.launch(launchOptions);
      page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      fixturePath = join(mkdtempSync(join(tmpdir(), "piren-wux-sidebar-")), "probe.html");
    });

    it("the Explorer name control owns about 80% and the sibling action about 20% of one row", async () => {
      writeFileSync(fixturePath, FIXTURE(`file://${builtCssPath()}`));
      await page.goto(`file://${fixturePath}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const widths = await page.evaluate(() => {
        const row = document.querySelector<HTMLElement>(".sidebar-companion-row");
        const toggle = document.querySelector<HTMLElement>("#explorer-toggle");
        const action = document.querySelector<HTMLElement>("#explorer-fullpage");
        if (row === null || toggle === null || action === null) throw new Error("row controls missing");
        return {
          rowWidth: row.getBoundingClientRect().width,
          toggleWidth: toggle.getBoundingClientRect().width,
          actionWidth: action.getBoundingClientRect().width,
          sameRowTop: Math.abs(toggle.getBoundingClientRect().top - action.getBoundingClientRect().top) < 2,
        };
      });
      expect(widths.sameRowTop).toBe(true);
      // About 80/20 of the two-control span (gap excluded), with tolerance
      // for borders/padding rounding.
      const total = widths.toggleWidth + widths.actionWidth;
      const toggleShare = widths.toggleWidth / total;
      const actionShare = widths.actionWidth / total;
      expect(toggleShare).toBeGreaterThan(0.7);
      expect(toggleShare).toBeLessThan(0.9);
      expect(actionShare).toBeGreaterThan(0.1);
      expect(actionShare).toBeLessThan(0.3);
    });

    it("teardown: close the browser", async () => {
      await browser?.close();
    });
  },
);
