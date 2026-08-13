import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import {
  isScrollAnchored,
  nextScrollTopForAppend,
} from "../web/src/conversation-scroll-anchor.js";

/**
 * P8 (accepted `conversation-p8-pilot-correction-contract.md` §2 + §5) — REAL
 * rendered geometry and REAL autoscroll semantics in an actual browser
 * (system `/usr/bin/google-chrome-stable` via the minimal declared
 * `puppeteer-core` dev-dependency — no browser binary is downloaded). No
 * screenshot pixel guessing: deterministic layout assertions. The built
 * workbench stylesheet (`dist/public/assets/*.css`) is loaded into a fixture
 * page; the REAL pure anchor core is driven with REAL measured layout
 * metrics for single/batch appends and upward-reader preservation.
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
<title>P8 layout probe</title>
<link rel="stylesheet" href="${cssUrl}" />
<style>
  html, body { margin: 0; }
  .probe-shell {
    width: 640px;
    height: 600px;
    display: flex;
    flex-direction: column;
  }
  /* The real app constrains the workspace height (flex:1 chain); the probe
     replicates that so #scroller is a genuine scroll container. */
  .probe-shell .conversation-workspace { height: 100%; }
</style>
</head>
<body>
<div class="probe-shell">
  <div class="conversation-workspace">
    <div class="conversation-scroll" id="scroller">
      <div id="scroller-inner"><div style="height:3000px;background:#eee">history</div></div>
    </div>
    <div class="composer-action-row">
      <form class="conversation-composer">
        <div class="composer-controls">
          <button type="button" class="composer-upload-placeholder" disabled aria-label="Upload is not available">+</button>
          <div class="composer-input-wrap">
            <label class="sr-only" for="conversation-message-c1">Message</label>
            <textarea id="conversation-message-c1" rows="1">Hi</textarea>
          </div>
          <button type="button" class="composer-submit-toggle" aria-label="Submit">&#8617;</button>
        </div>
      </form>
      <button type="button" class="conversation-details-toggle" aria-label="Conversation details">i</button>
    </div>
  </div>
</div>
</body>
</html>`;

function composerRects(page: Page): Promise<Record<string, { top: number; bottom: number; height: number }>> {
  return page.evaluate(() => {
    const rect = (selector: string): { top: number; bottom: number; height: number } => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el === null) throw new Error(`missing ${selector}`);
      const box = el.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, height: box.height };
    };
    return {
      textarea: rect(".conversation-composer textarea"),
      upload: rect(".composer-upload-placeholder"),
      submit: rect(".composer-submit-toggle"),
      details: rect(".conversation-details-toggle"),
    };
  });
}

interface ComposerRects {
  textarea: { top: number; bottom: number; height: number };
  upload: { top: number; bottom: number; height: number };
  submit: { top: number; bottom: number; height: number };
  details: { top: number; bottom: number; height: number };
}

async function composerRectsTyped(page: Page): Promise<ComposerRects> {
  return (await composerRects(page)) as unknown as ComposerRects;
}

async function scrollerMetrics(page: Page): Promise<{ scrollTop: number; clientHeight: number; scrollHeight: number }> {
  return page.evaluate(() => {
    const el = document.getElementById("scroller") as HTMLElement;
    return { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
  });
}

const probe = describe.skipIf(chromePath === null || builtCssPath() === null)(
  "P8 real-browser layout + autoscroll probe (system Chrome, no screenshot guessing)",
  () => {
    let browser: Browser;
    let page: Page;
    let fixturePath: string;

    it("setup: launch system Chrome and load the built workbench stylesheet fixture", async () => {
      const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
        headless: true,
        args: ["--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check"],
      };
      if (chromePath !== null) launchOptions.executablePath = chromePath;
      browser = await puppeteer.launch(launchOptions);
      page = await browser.newPage();
      const cssPath = builtCssPath() as string;
      const cssUrl = `file://${cssPath}`;
      fixturePath = join(mkdtempSync(join(tmpdir(), "p8-layout-")), "index.html");
      writeFileSync(fixturePath, FIXTURE(cssUrl));
      await page.goto(`file://${fixturePath}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }, 60_000);

    it("one-line: the rendered textarea border-box is exactly 44px and its bottom equals the 44px control bottoms (RED: today 44.4)", async () => {
      const rects = await composerRectsTyped(page);
      expect(Math.abs(rects.textarea.height - 44)).toBeLessThan(0.1);
      // The textarea bottom edge is flush with the upload/submit/details bottoms.
      expect(Math.abs(rects.textarea.bottom - rects.upload.bottom)).toBeLessThan(0.1);
      expect(Math.abs(rects.textarea.bottom - rects.submit.bottom)).toBeLessThan(0.1);
      expect(Math.abs(rects.textarea.bottom - rects.details.bottom)).toBeLessThan(0.1);
      // The 44px controls really are 44px tall.
      expect(Math.abs(rects.upload.height - 44)).toBeLessThan(0.1);
      expect(Math.abs(rects.details.height - 44)).toBeLessThan(0.1);
    });

    it("autosized multi-line: the textarea bottom stays flush with the control bottoms", async () => {
      // Simulate the real autosize path: two content lines -> 66px box.
      await page.evaluate(() => {
        const input = document.getElementById("conversation-message-c1") as HTMLTextAreaElement;
        input.value = "line one\nline two";
        input.style.height = "66px";
      });
      const rects = await composerRectsTyped(page);
      expect(rects.textarea.height).toBeGreaterThan(60);
      expect(Math.abs(rects.textarea.bottom - rects.upload.bottom)).toBeLessThan(0.1);
      expect(Math.abs(rects.textarea.bottom - rects.submit.bottom)).toBeLessThan(0.1);
      expect(Math.abs(rects.textarea.bottom - rects.details.bottom)).toBeLessThan(0.1);
      // Reset to one line for the autoscroll probes.
      await page.evaluate(() => {
        const input = document.getElementById("conversation-message-c1") as HTMLTextAreaElement;
        input.value = "Hi";
        input.style.height = "";
      });
    });

    it("autoscroll: an anchored reader follows a single append to the new bottom (real layout metrics + REAL pure core)", async () => {
      await page.evaluate(() => {
        const scroller = document.getElementById("scroller") as HTMLElement;
        scroller.scrollTop = scroller.scrollHeight;
      });
      const before = await scrollerMetrics(page);
      expect(isScrollAnchored(before)).toBe(true);

      await page.evaluate(() => {
        const inner = document.getElementById("scroller-inner") as HTMLElement;
        const block = document.createElement("div");
        block.style.height = "600px";
        block.textContent = "appended";
        inner.appendChild(block);
      });
      const after = await scrollerMetrics(page);
      const target = nextScrollTopForAppend(before, after.scrollHeight);
      expect(target).not.toBeNull();
      await page.evaluate((top) => {
        const scroller = document.getElementById("scroller") as HTMLElement;
        scroller.scrollTop = top as number;
      }, target as number);

      const final = await scrollerMetrics(page);
      expect(final.scrollTop + final.clientHeight).toBeGreaterThanOrEqual(final.scrollHeight - 2);
    });

    it("autoscroll: an upward reader's exact position is preserved across an append", async () => {
      await page.evaluate(() => {
        const scroller = document.getElementById("scroller") as HTMLElement;
        scroller.scrollTop = 1000;
      });
      const before = await scrollerMetrics(page);
      expect(isScrollAnchored(before)).toBe(false);

      await page.evaluate(() => {
        const inner = document.getElementById("scroller-inner") as HTMLElement;
        const block = document.createElement("div");
        block.style.height = "600px";
        block.textContent = "appended-2";
        inner.appendChild(block);
      });
      const after = await scrollerMetrics(page);
      const target = nextScrollTopForAppend(before, after.scrollHeight);
      expect(target).toBeNull();
      const final = await scrollerMetrics(page);
      expect(final.scrollTop).toBe(1000);
    });

    it("autoscroll: batch appends produce one correct decision to the new bottom", async () => {
      await page.evaluate(() => {
        const scroller = document.getElementById("scroller") as HTMLElement;
        scroller.scrollTop = scroller.scrollHeight;
      });
      const before = await scrollerMetrics(page);
      // Batch: two chunks appended before any scroll decision.
      await page.evaluate(() => {
        const inner = document.getElementById("scroller-inner") as HTMLElement;
        for (const height of [400, 400]) {
          const block = document.createElement("div");
          block.style.height = `${height}px`;
          inner.appendChild(block);
        }
      });
      const after = await scrollerMetrics(page);
      const target = nextScrollTopForAppend(before, after.scrollHeight);
      expect(target).not.toBeNull();
      await page.evaluate((top) => {
        const scroller = document.getElementById("scroller") as HTMLElement;
        scroller.scrollTop = top as number;
      }, target as number);
      const final = await scrollerMetrics(page);
      expect(final.scrollTop + final.clientHeight).toBeGreaterThanOrEqual(final.scrollHeight - 2);
    });

    it("teardown: close the browser", async () => {
      await browser?.close();
    }, 30_000);
  },
);

probe; // keep the descriptor referenced
