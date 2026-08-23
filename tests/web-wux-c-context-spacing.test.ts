import { readFile } from "node:fs/promises";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WUX-C — Conversation input-area context spacing. The compact per-agent
 * Context card row is the LAST interaction-tray row: the excess vertical
 * separation ABOVE it is reduced (compact padding-top over the composer
 * action row) and the card row gains bottom breathing room visually
 * comparable to the composer controls' padding so it no longer touches the
 * page bottom. Layout/scroll ownership, control authority, and telemetry
 * semantics are untouched.
 */

const css = await readFile(join(process.cwd(), "web", "src", "styles.css"), "utf8");

describe("WUX-C context card spacing (static CSS pins)", () => {
  const start = css.indexOf(".conversation-context-cards {");
  const block = css.slice(start, css.indexOf("}", start));

  it("reduces the vertical separation above the Context card row", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(block).toMatch(/padding-top:\s*4px/s);
  });

  it("gives the card row bottom breathing room comparable to the composer controls", () => {
    // The composer action row pads its controls with 12px at the bottom;
    // the final card row matches that visual rhythm.
    expect(block).toMatch(/padding-bottom:\s*12px/s);
  });
});

// ---------------------------------------------------------------------------
// Real rendered geometry probe (system Chrome via puppeteer-core; W1/W2/P8
// precedent), skipped when Chrome or built CSS assets are unavailable.
// ---------------------------------------------------------------------------

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

function builtCssPath(): string | null {
  const assetsDir = join(process.cwd(), "dist", "public", "assets");
  try {
    const name = readdirSync(assetsDir).find((file) => file.endsWith(".css"));
    return name === undefined ? null : join(assetsDir, name);
  } catch {
    return null;
  }
}

const chromePath = findChrome();

const FIXTURE = (cssUrl: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>WUX-C context spacing probe</title>
<link rel="stylesheet" href="${cssUrl}" />
<style>
  html, body { margin: 0; }
  #stage { position: absolute; inset: 0; display: flex; flex-direction: column; }
</style>
</head>
<body>
<div id="stage">
  <div class="conversation-workspace">
    <div class="interaction-tray">
      <div class="composer-action-row">
        <form class="conversation-composer"><textarea rows="1"></textarea></form>
      </div>
      <div class="conversation-context-cards" aria-label="Conversation context">
        <button type="button" class="context-card"><span>dipu</span></button>
      </div>
    </div>
  </div>
</div>
</body>
</html>`;

const probe = describe.skipIf(chromePath === null || builtCssPath() === null)(
  "WUX-C real-browser context-card spacing probe (system Chrome)",
  () => {
    let page: import("puppeteer-core").Page | null = null;

    it("setup: launch system Chrome", async () => {
      const puppeteer = await import("puppeteer-core");
      const launchOptions: Parameters<typeof puppeteer.launch>[0] = { headless: true };
      if (chromePath !== null) launchOptions.executablePath = chromePath;
      const browser = await puppeteer.launch(launchOptions);
      page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      const fixturePath = join(mkdtempSync(join(tmpdir(), "piren-wux-c-context-")), "probe.html");
      writeFileSync(fixturePath, FIXTURE(`file://${builtCssPath()}`));
      await page.goto(`file://${fixturePath}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      (globalThis as Record<string, unknown>).__wuxcBrowser = browser;
    });

    it("the card row keeps compact top separation and real bottom breathing room", async function () {
      if (page === null) throw new Error("probe page missing");
      const metrics = await page.evaluate(() => {
        const cards = document.querySelector<HTMLElement>(".conversation-context-cards");
        const stage = document.querySelector<HTMLElement>("#stage");
        if (cards === null || stage === null) throw new Error("fixture nodes missing");
        const style = getComputedStyle(cards);
        const rect = cards.getBoundingClientRect();
        return {
          paddingTop: parseFloat(style.paddingTop),
          paddingBottom: parseFloat(style.paddingBottom),
          bottomGap: stage.getBoundingClientRect().bottom - rect.bottom,
        };
      });
      expect(metrics.paddingTop).toBeLessThanOrEqual(6);
      expect(metrics.paddingBottom).toBeGreaterThanOrEqual(10);
      // The card row no longer touches the page bottom.
      expect(metrics.bottomGap).toBeGreaterThan(0);
    });

    it("teardown: close the browser", async () => {
      const browser = (globalThis as Record<string, unknown>).__wuxcBrowser as { close(): Promise<void> } | undefined;
      await browser?.close();
    });
  },
);
void probe;
