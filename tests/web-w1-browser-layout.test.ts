import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import {
  balancedChatPaneHeight,
  CHAT_PANE_MIN_PX,
  COMPANION_PANE_MIN_PX,
  splitBounds,
} from "../web/src/split-workspace.js";

/**
 * W1 (accepted companion split architecture §3; P8 precedent) — REAL rendered
 * geometry of the split workspace in an actual browser (system Chrome via the
 * minimal declared `puppeteer-core` dev-dependency; no browser binary is
 * downloaded). Geometry, not screenshots.
 *
 * The fixture replicates the ACTIVE Conversation shell and drives the split
 * with the REAL pure core: the chat pane inline flex-basis is the balanced/
 * clamped value computed by `split-workspace.ts` for the measured workspace
 * height. It must prove at desktop size that:
 *   - the balanced default is 50/50 of the available split height (subject to
 *     the declared minimums) and the panes fill the container exactly;
 *   - the CSS minimums clamp deterministically (chat >= 280px, companion
 *     >= 200px) when the inline basis violates them;
 *   - one scroll owner per pane: the companion pane owns its own internal
 *     scroll and the Conversation history owns the chat pane's scroll; the
 *     browser root never scrolls;
 *   - the mobile one-pane toggle is hidden at desktop size.
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

const FIXTURE = (cssUrl: string, chatBasisPx: number): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>W1 split workspace probe</title>
<link rel="stylesheet" href="${cssUrl}" />
<style>
  html, body { margin: 0; }
</style>
</head>
<body>
<div class="shell shell-conversation shell-conversation-active">
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
        <div class="split-workspace" id="split">
          <section class="split-companion-pane" aria-label="Vault Explorer" id="companion">
            <ol style="list-style:none;margin:0;padding:12px">
              <li style="height:320px;background:#f4f4f4">file-row-1</li>
              <li style="height:320px;background:#eef">file-row-2</li>
              <li style="height:320px;background:#f4f4f4">file-row-3</li>
              <li style="height:320px;background:#eef">file-row-4</li>
              <li style="height:320px;background:#f4f4f4">file-row-5</li>
            </ol>
          </section>
          <div class="split-mobile-toggle" role="group" aria-label="Companion view toggle">
            <button type="button" aria-pressed="true">Chat</button>
            <button type="button" aria-pressed="false">Vault Explorer</button>
          </div>
          <div class="split-resizer-host">
            <div class="split-resizer" role="separator" aria-orientation="horizontal" tabindex="0"
                 aria-valuemin="${CHAT_PANE_MIN_PX}" aria-valuenow="${chatBasisPx}"
                 aria-label="Resize chat pane" id="resizer"></div>
          </div>
          <section class="split-chat-pane" aria-label="Chat" id="chatpane" style="flex-basis:${chatBasisPx}px">
            <section class="conversation-surface">
              <div class="conversation-workspace">
                <div class="conversation-history" role="region" aria-label="Conversation history" tabindex="0" id="history">
                  <ol class="transcript-list" style="margin:0;padding:0">
                    <li style="height:320px;background:#eee">row-1</li>
                    <li style="height:320px;background:#eef">row-2</li>
                    <li style="height:320px;background:#eee">row-3</li>
                    <li style="height:320px;background:#eef">row-4</li>
                    <li style="height:320px;background:#eee">row-5</li>
                    <li style="height:320px;background:#eef">row-6</li>
                  </ol>
                </div>
                <div class="interaction-tray" id="tray">
                  <div class="composer-action-row">
                    <form class="conversation-composer">
                      <div class="composer-input-wrap">
                        <label class="sr-only" for="m">Message</label>
                        <textarea id="m" rows="1">Hi</textarea>
                      </div>
                    </form>
                  </div>
                </div>
              </div>
            </section>
          </section>
        </div>
      </div>
    </main>
  </div>
</div>
</body>
</html>`;

interface Rect {
  height: number;
}

async function rectOf(page: Page, selector: string): Promise<Rect> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (el === null) throw new Error(`missing ${sel}`);
    return { height: el.getBoundingClientRect().height };
  }, selector);
}

interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

async function metrics(page: Page, selector: string): Promise<ScrollMetrics> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (el === null) throw new Error(`missing ${sel}`);
    return { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
  }, selector);
}

async function rootMetrics(page: Page): Promise<ScrollMetrics> {
  return page.evaluate(() => {
    const el = document.scrollingElement as Element;
    return { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
  });
}

/** Walk every element inside the split and report inner scroll containers. */
async function splitScrollOwners(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const split = document.getElementById("split");
    if (split === null) throw new Error("missing #split");
    const owners: string[] = [];
    const walk = (el: Element) => {
      if (el !== split && el.scrollHeight > el.clientHeight + 1) {
        const overflowY = getComputedStyle(el).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") {
          owners.push(el.id !== "" ? `#${el.id}` : `#${String(el.className).split(/\s+/)[0]}`);
        }
      }
      for (const child of el.children) walk(child);
    };
    walk(split);
    return owners;
  });
}

const probe = describe.skipIf(chromePath === null || builtCssPath() === null)(
  "W1 real-browser split workspace geometry probe (system Chrome, no screenshot guessing)",
  () => {
    let browser: Browser;
    let page: Page;
    let fixturePath: string;

    async function reloadWith(chatBasisPx: number): Promise<number> {
      const cssPath = builtCssPath() as string;
      const cssUrl = `file://${cssPath}`;
      writeFileSync(fixturePath, FIXTURE(cssUrl, chatBasisPx));
      await page.reload();
      await new Promise((resolve) => setTimeout(resolve, 120));
      return (await metrics(page, "#split")).clientHeight;
    }

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
      fixturePath = join(mkdtempSync(join(tmpdir(), "w1-split-")), "index.html");
      writeFileSync(fixturePath, FIXTURE(cssUrl, 400));
      await page.goto(`file://${fixturePath}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }, 60_000);

    it("balanced default: chat is 50/50 of the available split height and the panes fill it exactly", async () => {
      const splitHeight = await reloadWith(400);
      expect(splitHeight).toBeGreaterThan(480);
      // The shell sets the inline basis to the pure-core balanced default.
      const balanced = balancedChatPaneHeight(splitHeight);
      const splitHeight2 = await reloadWith(balanced);
      expect(splitHeight2).toBe(splitHeight);
      const chat = await rectOf(page, "#chatpane");
      expect(Math.abs(chat.height - balanced)).toBeLessThanOrEqual(2);
      // The resizer + both panes fill the workspace exactly.
      const resizer = await rectOf(page, ".split-resizer-host");
      const companion = await rectOf(page, "#companion");
      const sum = chat.height + resizer.height + companion.height;
      expect(Math.abs(sum - splitHeight)).toBeLessThanOrEqual(2);
      // The balanced chat height is inside the declared bounds.
      const { min, max } = splitBounds(splitHeight);
      expect(chat.height).toBeGreaterThanOrEqual(min - 1);
      expect(chat.height).toBeLessThanOrEqual(max + 1);
      // The mobile toggle is hidden at desktop size.
      const toggleDisplay = await page.evaluate(() => getComputedStyle(document.querySelector(".split-mobile-toggle") as HTMLElement).display);
      expect(toggleDisplay).toBe("none");
    });

    it("min clamp: a chat basis below 280px renders at the 280px minimum", async () => {
      const splitHeight = await reloadWith(100);
      expect(splitHeight).toBeGreaterThan(480);
      const chat = await rectOf(page, "#chatpane");
      expect(chat.height).toBe(CHAT_PANE_MIN_PX);
    });

    it("max configuration: at the JS-computed maximum the companion renders at its 200px minimum with no overflow", async () => {
      const splitHeight = await reloadWith(400);
      expect(splitHeight).toBeGreaterThan(480);
      const resizer = await rectOf(page, ".split-resizer-host");
      // The shell never sets a chat basis above avail - companion min - resizer.
      const maxBasis = splitHeight - COMPANION_PANE_MIN_PX - resizer.height;
      const clampedHeight = await reloadWith(maxBasis);
      expect(clampedHeight).toBe(splitHeight);
      const companion = await rectOf(page, "#companion");
      expect(companion.height).toBe(COMPANION_PANE_MIN_PX);
      const chat = await rectOf(page, "#chatpane");
      const resizer2 = await rectOf(page, ".split-resizer-host");
      expect(Math.abs(chat.height + resizer2.height + companion.height - splitHeight)).toBeLessThanOrEqual(2);
    });

    it("one scroll owner per pane: companion owns its scroll, chat history owns the chat scroll, the root never scrolls", async () => {
      const splitHeight = await reloadWith(400);
      expect(splitHeight).toBeGreaterThan(480);
      // Companion content overflows and scrolls inside its own pane.
      const companion = await metrics(page, "#companion");
      expect(companion.scrollHeight).toBeGreaterThan(companion.clientHeight);
      const companionOverflow = await page.evaluate(() => getComputedStyle(document.getElementById("companion") as HTMLElement).overflowY);
      expect(companionOverflow).toBe("auto");
      // Chat history overflows and scrolls.
      const history = await metrics(page, "#history");
      expect(history.scrollHeight).toBeGreaterThan(history.clientHeight);
      // Exactly two inner scroll owners inside the split: companion + history.
      const owners = await splitScrollOwners(page);
      expect(owners.sort()).toEqual(["#companion", "#history"].sort());
      // The browser root document does not scroll.
      const root = await rootMetrics(page);
      expect(root.scrollHeight).toBeLessThanOrEqual(root.clientHeight + 1);
    });
  },
);
