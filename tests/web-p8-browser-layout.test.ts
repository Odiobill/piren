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
 * R1 (accepted `workbench-conversation-canvas-refinement-contract.md` §2) —
 * REAL rendered geometry and REAL autoscroll semantics in an actual browser
 * (system `/usr/bin/google-chrome-stable` via the minimal declared
 * `puppeteer-core` dev-dependency — no browser binary is downloaded). No
 * screenshot pixel guessing: deterministic layout assertions.
 *
 * The fixture replicates the R1 document-flow Conversation surface
 * (`shell shell-conversation` → fixed chrome + document-root scrolling +
 * sticky composer dock). It must prove that at desktop size with overflowing
 * Conversation content:
 *   - the BROWSER ROOT document is scrollable (scrollbar at the window's
 *     right edge), and no inner conversation-surface element is a scroll
 *     container (no inner transcript scrollbar required);
 *   - the composer/details dock stays pinned at the viewport bottom while
 *     the reader scrolls, and does not obscure the final timeline content;
 *   - the P8 44px composer geometry and flush control bottoms are preserved;
 *   - append anchoring (P8 §5 semantics) drives the DOCUMENT root via the
 *     REAL pure core: initial bottom, anchored reader follows, upward reader
 *     preserved, batch appends produce one decision.
 *
 * The previous P8 inner-scroll-host assumption (`.conversation-scroll`) is
 * superseded by the R1 contract exactly as to scroll-host placement.
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

/**
 * R1 fixture: the real shell classes drive the layout so the probe measures
 * the ACTUAL stylesheet (document root scroll host, sticky dock, uncarded
 * workspace). The header includes a 48px logo placeholder so the desktop
 * chrome height matches `--shell-chrome-height` exactly.
 */
const FIXTURE = (cssUrl: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>R1 layout probe</title>
<link rel="stylesheet" href="${cssUrl}" />
<style>
  html, body { margin: 0; }
</style>
</head>
<body>
<div class="shell shell-conversation">
  <header class="shell-header">
    <div class="shell-logo" style="width:48px;height:48px;background:#ccc"></div>
    <div class="shell-heading"><h1>Workbench</h1></div>
  </header>
  <div class="shell-body">
    <div class="sidebar-desktop">
      <div style="height:1200px;color:var(--muted)">sidebar</div>
    </div>
    <main class="shell-main">
      <div class="workspace-panel workspace-panel-conversations">
        <section class="conversation-surface" aria-label="Conversation: probe">
          <div class="conversation-workspace">
            <div id="history" aria-label="Conversation history">
              <div style="height:400px;background:#eee">history-1</div>
              <div style="height:400px;background:#eef">history-2</div>
              <div style="height:400px;background:#eee">history-3</div>
              <div style="height:400px;background:#eef">history-4</div>
              <div style="height:400px;background:#eee">history-5</div>
              <div style="height:400px;background:#eef">history-6</div>
              <div style="height:400px;background:#eee">history-7</div>
              <div style="height:400px;background:#eef">history-8</div>
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
        </section>
      </div>
    </main>
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
      dock: rect(".composer-action-row"),
    };
  });
}

interface ComposerRects {
  textarea: { top: number; bottom: number; height: number };
  upload: { top: number; bottom: number; height: number };
  submit: { top: number; bottom: number; height: number };
  details: { top: number; bottom: number; height: number };
  dock: { top: number; bottom: number; height: number };
}

async function composerRectsTyped(page: Page): Promise<ComposerRects> {
  return (await composerRects(page)) as unknown as ComposerRects;
}

interface RootMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

async function rootMetrics(page: Page): Promise<RootMetrics> {
  return page.evaluate(() => {
    const el = document.scrollingElement as Element;
    return { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
  });
}

/** Walk every element inside the conversation surface and report inner scroll
    containers: an element is one only when it can actually show a scrollbar
    (computed overflow-y auto/scroll) AND has overflowing content. */
async function innerScrollOwners(page: Page): Promise<Array<{ selector: string }>> {
  return page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>(".conversation-surface");
    if (surface === null) throw new Error("missing .conversation-surface");
    const owners: Array<{ selector: string }> = [];
    const walk = (el: Element) => {
      if (el !== surface && el.scrollHeight > el.clientHeight + 1) {
        const overflowY = getComputedStyle(el).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") {
          const chain: string[] = [];
          let current: Element | null = el;
          while (current !== null && current !== surface) {
            chain.unshift(current.id !== "" ? `#${current.id}` : current.className !== "" ? `.${String(current.className).split(/\s+/)[0]}` : current.tagName.toLowerCase());
            current = current.parentElement;
          }
          owners.push({ selector: chain.join(" > ") });
        }
      }
      for (const child of el.children) walk(child);
    };
    walk(surface);
    return owners;
  });
}

async function setRootScrollTop(page: Page, top: number): Promise<void> {
  await page.evaluate((value) => {
    const el = document.scrollingElement as Element;
    el.scrollTop = value as number;
  }, top);
}

async function lastHistoryBottom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const history = document.getElementById("history") as HTMLElement;
    const last = history.lastElementChild as HTMLElement;
    return last.getBoundingClientRect().bottom;
  });
}

async function appendHistoryBlock(page: Page, height: number, text: string): Promise<void> {
  await page.evaluate((opts) => {
    const history = document.getElementById("history") as HTMLElement;
    const block = document.createElement("div");
    block.style.height = `${opts.height}px`;
    block.style.background = "#dde";
    block.textContent = opts.text;
    history.appendChild(block);
  }, { height, text });
}

const probe = describe.skipIf(chromePath === null || builtCssPath() === null)(
  "R1 real-browser root-scroll + stable dock + autoscroll probe (system Chrome, no screenshot guessing)",
  () => {
    let browser: Browser;
    let page: Page;
    let fixturePath: string;

    it("setup: launch system Chrome at desktop size and load the built workbench stylesheet fixture", async () => {
      const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
        headless: true,
        args: ["--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check"],
      };
      if (chromePath !== null) launchOptions.executablePath = chromePath;
      browser = await puppeteer.launch(launchOptions);
      page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      const cssPath = builtCssPath() as string;
      const cssUrl = `file://${cssPath}`;
      fixturePath = join(mkdtempSync(join(tmpdir(), "r1-layout-")), "index.html");
      writeFileSync(fixturePath, FIXTURE(cssUrl));
      await page.goto(`file://${fixturePath}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }, 60_000);

    it("root-scroll: with overflowing content the BROWSER ROOT document is scrollable (no inner transcript/main-pane scroll owner)", async () => {
      const before = await rootMetrics(page);
      // The conversation content overflows the viewport: the document must be
      // the scrollable surface (scrollbar at the browser's right edge).
      expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
      // No element inside the conversation surface is an inner scroll owner:
      // no nested transcript scrollbar is required.
      const owners = await innerScrollOwners(page);
      expect(owners).toEqual([]);
      // And the obsolete inner wrapper class does not exist in the surface.
      const hasConversationScroll = await page.evaluate(() => document.querySelector(".conversation-scroll") !== null);
      expect(hasConversationScroll).toBe(false);
      // The document really scrolls.
      await setRootScrollTop(page, before.scrollHeight);
      const scrolled = await rootMetrics(page);
      expect(scrolled.scrollTop).toBeGreaterThan(0);
    });

    it("dock: the composer/details dock stays pinned at the viewport bottom while the reader scrolls (sticky)", async () => {
      const position = await page.evaluate(() => getComputedStyle(document.querySelector(".composer-action-row") as Element).position);
      expect(position).toBe("sticky");
      // Scroll the document to the middle of the history.
      const mid = await page.evaluate(() => {
        const el = document.scrollingElement as Element;
        const max = el.scrollHeight - el.clientHeight;
        el.scrollTop = Math.floor(max * 0.4);
        return el.scrollTop;
      });
      expect(mid).toBeGreaterThan(0);
      const rects = await composerRectsTyped(page);
      // The dock bottom sits at the viewport bottom (within a 2px tolerance)
      // and the dock is fully visible.
      expect(Math.abs(rects.dock.bottom - 800)).toBeLessThanOrEqual(2);
      expect(rects.dock.top).toBeGreaterThan(0);
      expect(rects.dock.top).toBeLessThan(800);
      // The dock's own height is bounded (no full-screen takeover).
      expect(rects.dock.height).toBeLessThan(400);
    });

    it("clearance: at max scroll the final timeline content sits above the dock (never obscured)", async () => {
      await setRootScrollTop(page, (await rootMetrics(page)).scrollHeight);
      const rects = await composerRectsTyped(page);
      const lastBottom = await lastHistoryBottom(page);
      expect(lastBottom).toBeLessThanOrEqual(rects.dock.top + 1);
      // The dock itself settles at the document end (viewport bottom).
      expect(Math.abs(rects.dock.bottom - 800)).toBeLessThanOrEqual(2);
    });

    it("one-line: the rendered textarea border-box is exactly 44px and its bottom equals the 44px control bottoms (P8 preserved)", async () => {
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

    it("autosized multi-line: the textarea bottom stays flush with the control bottoms (P8 preserved)", async () => {
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

    it("autoscroll: an anchored reader follows a single append to the new DOCUMENT bottom (real root metrics + REAL pure core)", async () => {
      await setRootScrollTop(page, (await rootMetrics(page)).scrollHeight);
      const before = await rootMetrics(page);
      expect(isScrollAnchored(before)).toBe(true);

      await appendHistoryBlock(page, 600, "appended");
      const after = await rootMetrics(page);
      const target = nextScrollTopForAppend(before, after.scrollHeight);
      expect(target).not.toBeNull();
      await setRootScrollTop(page, target as number);

      const final = await rootMetrics(page);
      expect(final.scrollTop + final.clientHeight).toBeGreaterThanOrEqual(final.scrollHeight - 2);
    });

    it("autoscroll: an upward reader's exact position is preserved across an append", async () => {
      await setRootScrollTop(page, 1000);
      const before = await rootMetrics(page);
      expect(isScrollAnchored(before)).toBe(false);

      await appendHistoryBlock(page, 600, "appended-2");
      const after = await rootMetrics(page);
      const target = nextScrollTopForAppend(before, after.scrollHeight);
      expect(target).toBeNull();
      const final = await rootMetrics(page);
      expect(final.scrollTop).toBe(1000);
    });

    it("autoscroll: batch appends produce one correct decision to the new DOCUMENT bottom", async () => {
      await setRootScrollTop(page, (await rootMetrics(page)).scrollHeight);
      const before = await rootMetrics(page);
      // Batch: two chunks appended before any scroll decision.
      await appendHistoryBlock(page, 400, "batch-a");
      await appendHistoryBlock(page, 400, "batch-b");
      const after = await rootMetrics(page);
      const target = nextScrollTopForAppend(before, after.scrollHeight);
      expect(target).not.toBeNull();
      await setRootScrollTop(page, target as number);
      const final = await rootMetrics(page);
      expect(final.scrollTop + final.clientHeight).toBeGreaterThanOrEqual(final.scrollHeight - 2);
    });

    it("teardown: close the browser", async () => {
      await browser?.close();
    }, 30_000);
  },
);

probe; // keep the descriptor referenced
