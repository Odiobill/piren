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
 * ADR-0044 Tracer B — REAL rendered geometry and REAL autoscroll semantics in
 * an actual browser (system Chrome via the minimal declared `puppeteer-core`
 * dev-dependency — no browser binary is downloaded). Geometry, not
 * screenshots.
 *
 * The fixture replicates the B ACTIVE Conversation layout
 * (`shell shell-conversation shell-conversation-active` → clipped viewport →
 * named `.conversation-history` scroll host + bottom `.interaction-tray`
 * flex child outside it). It must prove that at desktop size with
 * overflowing Conversation history:
 *   - the BROWSER ROOT document does NOT become the Conversation history
 *     scroll host (it does not overflow); the named history region is the
 *     sole inner scroll owner;
 *   - the tray (live status/approvals/composer/details) stays OUTSIDE the
 *     history host at the available workspace bottom, and the final history
 *     content is never obscured beneath it;
 *   - transcript content and tray/composer horizontal start/end edges align
 *     (one shared inset);
 *   - the P8 44px composer geometry and flush control bottoms are preserved;
 *   - append anchoring (P8 §5 semantics) drives the HISTORY HOST via the
 *     REAL pure core: initial bottom, anchored reader follows, upward reader
 *     preserved, batch appends produce one decision.
 *
 * R1's browser-root placement is superseded only for this active layout.
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
 * Tracer B fixture: the real shell classes drive the layout so the probe
 * measures the ACTUAL stylesheet (clipped active viewport, named history
 * scroll host, bottom interaction tray). The header includes a 48px logo
 * placeholder so the desktop chrome height matches `--shell-chrome-height`
 * exactly.
 */
const FIXTURE = (cssUrl: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>B layout probe</title>
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
        <section class="conversation-surface" aria-label="Conversation: probe">
          <div class="conversation-workspace">
            <div class="conversation-history" role="region" aria-label="Conversation history" tabindex="0" id="history">
              <section class="timeline" aria-label="Conversation history">
                <ol class="transcript-list" id="rows">
                  <li class="transcript-row transcript-message transcript-agent"><div style="height:320px;background:#eee">row-1</div></li>
                  <li class="transcript-row transcript-message transcript-steward"><div style="height:320px;background:#eef">row-2</div></li>
                  <li class="transcript-row transcript-message transcript-agent"><div style="height:320px;background:#eee">row-3</div></li>
                  <li class="transcript-row transcript-message transcript-steward"><div style="height:320px;background:#eef">row-4</div></li>
                  <li class="transcript-row transcript-message transcript-agent"><div style="height:320px;background:#eee">row-5</div></li>
                  <li class="transcript-row transcript-message transcript-steward"><div style="height:320px;background:#eef">row-6</div></li>
                  <li class="transcript-row transcript-message transcript-agent"><div style="height:320px;background:#eee">row-7</div></li>
                  <li class="transcript-row transcript-message transcript-steward"><div style="height:320px;background:#eef">row-8</div></li>
                </ol>
              </section>
            </div>
            <div class="interaction-tray" id="tray">
              <div class="approval-cards" aria-label="Pending approvals">
                <div class="approval-pager" role="group" aria-label="Pending approval navigator" id="pager">
                  <button type="button" class="approval-pager-button" aria-label="Previous approval" disabled>‹</button>
                  <span class="approval-pager-status" id="pager-status">Approval 1 of 8</span>
                  <button type="button" class="approval-pager-button" aria-label="Next approval">›</button>
                </div>
                <div class="approval-card" role="group" aria-label="Approval requested by dipu" id="visible-card">
                  <p class="approval-title" id="visible-card-title">Approval requested (card 1)</p>
                  <p class="muted">The agent wants to proceed.</p>
                  <p class="approval-meta"><code>dipu</code> · confirm</p>
                  <div class="confirmation-actions">
                    <button type="button" class="button button-primary">Confirm</button>
                    <button type="button" class="button">Cancel</button>
                  </div>
                </div>
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
        </section>
      </div>
    </main>
  </div>
</div>
</body>
</html>`;

interface Rect {
  top: number;
  bottom: number;
  height: number;
  left: number;
  right: number;
}

async function rectOf(page: Page, selector: string): Promise<Rect> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (el === null) throw new Error(`missing ${sel}`);
    const box = el.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, height: box.height, left: box.left, right: box.right };
  }, selector);
}

interface ComposerRects {
  textarea: Rect;
  upload: Rect;
  submit: Rect;
  details: Rect;
  tray: Rect;
}

async function composerRects(page: Page): Promise<ComposerRects> {
  return {
    textarea: await rectOf(page, ".conversation-composer textarea"),
    upload: await rectOf(page, ".composer-upload-placeholder"),
    submit: await rectOf(page, ".composer-submit-toggle"),
    details: await rectOf(page, ".conversation-details-toggle"),
    tray: await rectOf(page, ".interaction-tray"),
  };
}

interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

async function hostMetrics(page: Page): Promise<ScrollMetrics> {
  return page.evaluate(() => {
    const el = document.getElementById("history") as HTMLElement;
    return { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
  });
}

async function rootMetrics(page: Page): Promise<ScrollMetrics> {
  return page.evaluate(() => {
    const el = document.scrollingElement as Element;
    return { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
  });
}

/** Walk every element inside the conversation surface and report inner scroll
    containers: an element is one only when it can actually show a scrollbar
    (computed overflow-y auto/scroll) AND has overflowing content. */
async function innerScrollOwners(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>(".conversation-surface");
    if (surface === null) throw new Error("missing .conversation-surface");
    const owners: string[] = [];
    const walk = (el: Element) => {
      if (el !== surface && el.scrollHeight > el.clientHeight + 1) {
        const overflowY = getComputedStyle(el).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") {
          owners.push(el.id !== "" ? `#${el.id}` : `.${String(el.className).split(/\s+/)[0]}`);
        }
      }
      for (const child of el.children) walk(child);
    };
    walk(surface);
    return owners;
  });
}

async function setHostScrollTop(page: Page, top: number): Promise<void> {
  await page.evaluate((value) => {
    const el = document.getElementById("history") as HTMLElement;
    el.scrollTop = value as number;
  }, top);
}

async function lastRowBottom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const rows = document.getElementById("rows") as HTMLElement;
    const last = rows.lastElementChild as HTMLElement;
    return last.getBoundingClientRect().bottom;
  });
}

async function appendRow(page: Page, height: number, text: string): Promise<void> {
  await page.evaluate((opts) => {
    const rows = document.getElementById("rows") as HTMLElement;
    const item = document.createElement("li");
    item.className = "transcript-row transcript-message transcript-agent";
    const block = document.createElement("div");
    block.style.height = `${opts.height}px`;
    block.style.background = "#dde";
    block.textContent = opts.text;
    item.appendChild(block);
    rows.appendChild(item);
  }, { height, text });
}

const probe = describe.skipIf(chromePath === null || builtCssPath() === null)(
  "Tracer B real-browser history-host + interaction-tray geometry probe (system Chrome, no screenshot guessing)",
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
      fixturePath = join(mkdtempSync(join(tmpdir(), "b-layout-")), "index.html");
      writeFileSync(fixturePath, FIXTURE(cssUrl));
      await page.goto(`file://${fixturePath}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }, 60_000);

    it("scroll host: the ROOT document does NOT own Conversation scrolling; the named history region is the sole inner scroll owner", async () => {
      const root = await rootMetrics(page);
      // The clipped active shell does not overflow the viewport: the document
      // is not the Conversation scroll host.
      expect(root.scrollHeight).toBeLessThanOrEqual(root.clientHeight + 1);
      // The history region overflows and is the ONLY inner scroll owner.
      const host = await hostMetrics(page);
      expect(host.scrollHeight).toBeGreaterThan(host.clientHeight);
      const owners = await innerScrollOwners(page);
      expect(owners).toEqual(["#history"]);
      // The history host really scrolls.
      await setHostScrollTop(page, host.scrollHeight);
      const scrolled = await hostMetrics(page);
      expect(scrolled.scrollTop).toBeGreaterThan(0);
      // The root document did not move.
      expect((await rootMetrics(page)).scrollTop).toBe(0);
    });

    it("tray: the interaction tray sits at the available workspace bottom, outside the history host, fully visible", async () => {
      const tray = await rectOf(page, ".interaction-tray");
      // Tray bottom sits at the viewport bottom (within 2px tolerance).
      expect(Math.abs(tray.bottom - 800)).toBeLessThanOrEqual(2);
      expect(tray.top).toBeGreaterThan(0);
      expect(tray.top).toBeLessThan(800);
      // Bounded tray height (no full-screen takeover).
      expect(tray.height).toBeLessThan(400);
      // The tray is NOT inside the history host.
      const inside = await page.evaluate(() => {
        const host = document.getElementById("history") as HTMLElement;
        return host.contains(document.getElementById("tray"));
      });
      expect(inside).toBe(false);
      // The history host's visible bottom meets the tray's top.
      const host = await rectOf(page, "#history");
      expect(Math.abs(host.bottom - tray.top)).toBeLessThanOrEqual(2);
    });

    it("pager tray: eight pending approvals render ONE card in a bounded non-scrolling tray wholly inside the clipped active viewport", async () => {
      // Exactly one card is present for the eight pending approvals.
      const cardCount = await page.evaluate(() => document.querySelectorAll(".approval-card").length);
      expect(cardCount).toBe(1);
      // The ordinal navigator is a real horizontal row with a truthful count.
      const pagerDisplay = await page.evaluate(() => getComputedStyle(document.querySelector(".approval-pager") as Element).display);
      expect(pagerDisplay).toBe("flex");
      const status = await page.evaluate(() => document.getElementById("pager-status")?.textContent);
      expect(status).toBe("Approval 1 of 8");
      // The tray (pager + one card + composer row) is wholly within the
      // clipped 800px active viewport: the root document does not overflow
      // and the tray is not a scroll area.
      const root = await rootMetrics(page);
      expect(root.scrollHeight).toBeLessThanOrEqual(root.clientHeight + 1);
      const tray = await rectOf(page, ".interaction-tray");
      expect(Math.abs(tray.bottom - 800)).toBeLessThanOrEqual(2);
      expect(tray.height).toBeLessThan(400);
      const trayOverflow = await page.evaluate(() => getComputedStyle(document.querySelector(".interaction-tray") as Element).overflowY);
      expect(trayOverflow).toBe("visible");
      // The required card is fully visible (never clipped below the viewport).
      const card = await rectOf(page, "#visible-card");
      expect(card.bottom).toBeLessThanOrEqual(800);
      expect(card.top).toBeGreaterThanOrEqual(tray.top);
      // The history region remains the sole inner scroll owner.
      const owners = await innerScrollOwners(page);
      expect(owners).toEqual(["#history"]);
    });

    it("pager tray: navigating to the final card keeps the same bounded geometry and the final card is fully reachable", async () => {
      // Emulate the pager outcome for the last of eight pending approvals
      // (the interaction itself is proven by the jsdom component suite).
      await page.evaluate(() => {
        document.getElementById("pager-status")!.textContent = "Approval 8 of 8";
        document.getElementById("visible-card-title")!.textContent = "Approval requested (card 8)";
        const previous = document.querySelector(".approval-pager-button") as HTMLButtonElement;
        const next = document.querySelectorAll(".approval-pager-button")[1] as HTMLButtonElement;
        previous.disabled = false;
        next.disabled = true;
      });
      const tray = await rectOf(page, ".interaction-tray");
      expect(Math.abs(tray.bottom - 800)).toBeLessThanOrEqual(2);
      expect(tray.height).toBeLessThan(400);
      const card = await rectOf(page, "#visible-card");
      expect(card.bottom).toBeLessThanOrEqual(800);
      const root = await rootMetrics(page);
      expect(root.scrollHeight).toBeLessThanOrEqual(root.clientHeight + 1);
      const status = await page.evaluate(() => document.getElementById("pager-status")?.textContent);
      expect(status).toBe("Approval 8 of 8");
    });

    it("clearance: at max host scroll the final history content sits at the tray edge (never obscured)", async () => {
      await setHostScrollTop(page, (await hostMetrics(page)).scrollHeight);
      const tray = await rectOf(page, ".interaction-tray");
      const last = await lastRowBottom(page);
      expect(last).toBeLessThanOrEqual(tray.top + 1);
      // The tray never moved while the history scrolled.
      expect(Math.abs(tray.bottom - 800)).toBeLessThanOrEqual(2);
    });

    it("alignment: transcript content and tray/composer share the same horizontal start/end (one inset)", async () => {
      const row = await rectOf(page, ".transcript-row");
      const rects = await composerRects(page);
      // The transcript content's start/end aligns with the tray content's
      // start (upload control) and end (details control).
      expect(Math.abs(row.left - rects.upload.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(row.right - rects.details.right)).toBeLessThanOrEqual(1);
      // And both edges are genuinely inset from the workspace edges.
      const workspace = await rectOf(page, ".conversation-workspace");
      expect(row.left).toBeGreaterThan(workspace.left);
      expect(row.right).toBeLessThan(workspace.right);
    });

    it("one-line: the rendered textarea border-box is exactly 44px and its bottom equals the 44px control bottoms (P8 preserved)", async () => {
      const rects = await composerRects(page);
      expect(Math.abs(rects.textarea.height - 44)).toBeLessThan(0.1);
      expect(Math.abs(rects.textarea.bottom - rects.upload.bottom)).toBeLessThan(0.1);
      expect(Math.abs(rects.textarea.bottom - rects.submit.bottom)).toBeLessThan(0.1);
      expect(Math.abs(rects.textarea.bottom - rects.details.bottom)).toBeLessThan(0.1);
      expect(Math.abs(rects.upload.height - 44)).toBeLessThan(0.1);
      expect(Math.abs(rects.details.height - 44)).toBeLessThan(0.1);
    });

    it("autosized multi-line: the textarea bottom stays flush with the control bottoms (P8 preserved)", async () => {
      await page.evaluate(() => {
        const input = document.getElementById("conversation-message-c1") as HTMLTextAreaElement;
        input.value = "line one\nline two";
        input.style.height = "66px";
      });
      const rects = await composerRects(page);
      expect(rects.textarea.height).toBeGreaterThan(60);
      expect(Math.abs(rects.textarea.bottom - rects.upload.bottom)).toBeLessThan(0.1);
      expect(Math.abs(rects.textarea.bottom - rects.submit.bottom)).toBeLessThan(0.1);
      expect(Math.abs(rects.textarea.bottom - rects.details.bottom)).toBeLessThan(0.1);
      await page.evaluate(() => {
        const input = document.getElementById("conversation-message-c1") as HTMLTextAreaElement;
        input.value = "Hi";
        input.style.height = "";
      });
    });

    it("autoscroll: an anchored reader follows a single append to the new HISTORY HOST bottom (real host metrics + REAL pure core)", async () => {
      await setHostScrollTop(page, (await hostMetrics(page)).scrollHeight);
      const before = await hostMetrics(page);
      expect(isScrollAnchored(before)).toBe(true);

      await appendRow(page, 320, "appended");
      const after = await hostMetrics(page);
      const target = nextScrollTopForAppend(before, after.scrollHeight);
      expect(target).not.toBeNull();
      await setHostScrollTop(page, target as number);

      const final = await hostMetrics(page);
      expect(final.scrollTop + final.clientHeight).toBeGreaterThanOrEqual(final.scrollHeight - 2);
    });

    it("autoscroll: an upward reader's exact position is preserved across an append", async () => {
      await setHostScrollTop(page, 500);
      const before = await hostMetrics(page);
      expect(isScrollAnchored(before)).toBe(false);

      await appendRow(page, 320, "appended-2");
      const after = await hostMetrics(page);
      const target = nextScrollTopForAppend(before, after.scrollHeight);
      expect(target).toBeNull();
      const final = await hostMetrics(page);
      expect(final.scrollTop).toBe(500);
    });

    it("autoscroll: batch appends produce one correct decision to the new HISTORY HOST bottom", async () => {
      await setHostScrollTop(page, (await hostMetrics(page)).scrollHeight);
      const before = await hostMetrics(page);
      await appendRow(page, 300, "batch-a");
      await appendRow(page, 300, "batch-b");
      const after = await hostMetrics(page);
      const target = nextScrollTopForAppend(before, after.scrollHeight);
      expect(target).not.toBeNull();
      await setHostScrollTop(page, target as number);
      const final = await hostMetrics(page);
      expect(final.scrollTop + final.clientHeight).toBeGreaterThanOrEqual(final.scrollHeight - 2);
    });

    it("teardown: close the browser", async () => {
      await browser?.close();
    }, 30_000);
  },
);

probe; // keep the descriptor referenced
