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
 * W2 (accepted companion split architecture Phase B; P8/W1 precedent) — REAL
 * rendered geometry of the first companion module in an actual browser
 * (system Chrome via the minimal declared `puppeteer-core` dev-dependency).
 * Geometry, not screenshots. Proves:
 *   - SELECTED Conversation: the open Explorer renders as the UPPER pane of
 *     the W1 split above the live chat, balanced 50/50, one scroll owner per
 *     pane (Explorer entries + Conversation history), root never scrolls;
 *   - NO selected Conversation: the open Explorer is a FULL-PAGE module
 *     surface (no split/resizer), one internal scroll owner, root never
 *     scrolls.
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

function entryRows(count: number): string {
  const rows: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const kind = i % 3 === 0 ? "dir" : "file";
    const name = kind === "dir" ? `directory-${i}` : `document-${i}.md`;
    rows.push(
      `<li><button type="button" class="vault-explorer-entry"><span class="vault-entry-type" aria-hidden="true">${kind}</span><span>${name}</span></button></li>`,
    );
  }
  return rows.join("\n");
}

const EXPLORER_PANE = (rows: string): string => `<section class="vault-explorer" id="explorer" aria-label="Vault Explorer">
  <nav class="vault-explorer-breadcrumb" aria-label="Vault path">
    <button type="button">Vault</button>
  </nav>
  <div class="vault-explorer-body">
    <ul class="vault-explorer-entries" id="entries">
${rows}
    </ul>
  </div>
</section>`;

const SPLIT_FIXTURE = (cssUrl: string, chatBasisPx: number): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>W2 split Explorer probe</title>
<link rel="stylesheet" href="${cssUrl}" />
<style>html, body { margin: 0; }</style>
</head>
<body>
<div class="shell shell-conversation shell-conversation-active">
  <header class="shell-header">
    <div class="shell-logo" style="width:48px;height:48px;background:#ccc"></div>
    <div class="shell-heading"><h1>Workbench</h1></div>
  </header>
  <div class="shell-body">
    <div class="sidebar-desktop"><div style="height:1200px">sidebar</div></div>
    <main class="shell-main">
      <div class="workspace-panel workspace-panel-conversations">
        <div class="split-workspace" id="split">
          <section class="split-companion-pane" aria-label="Vault Explorer" id="companion">
            ${EXPLORER_PANE(entryRows(60))}
          </section>
          <div class="split-mobile-toggle" role="group" aria-label="Companion view toggle">
            <button type="button" aria-pressed="false">Chat</button>
            <button type="button" aria-pressed="true">Vault Explorer</button>
          </div>
          <div class="split-resizer-host">
            <div class="split-resizer" role="separator" aria-orientation="horizontal" tabindex="0"
                 aria-valuemin="${CHAT_PANE_MIN_PX}" aria-valuenow="${chatBasisPx}" aria-label="Resize chat pane"></div>
          </div>
          <section class="split-chat-pane" aria-label="Chat" id="chatpane" style="flex-basis:${chatBasisPx}px">
            <section class="conversation-surface">
              <div class="conversation-workspace">
                <div class="conversation-history" role="region" aria-label="Conversation history" tabindex="0" id="history">
                  <ol class="transcript-list">
                    <li style="height:320px;background:#eee">row-1</li>
                    <li style="height:320px;background:#eef">row-2</li>
                    <li style="height:320px;background:#eee">row-3</li>
                    <li style="height:320px;background:#eef">row-4</li>
                    <li style="height:320px;background:#eee">row-5</li>
                    <li style="height:320px;background:#eef">row-6</li>
                  </ol>
                </div>
                <div class="interaction-tray"><div class="composer-action-row"><form class="conversation-composer"><textarea rows="1">Hi</textarea></form></div></div>
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

const FULLPAGE_FIXTURE = (cssUrl: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>W2 full-page Explorer probe</title>
<link rel="stylesheet" href="${cssUrl}" />
<style>html, body { margin: 0; }</style>
</head>
<body>
<div class="shell shell-conversation">
  <header class="shell-header">
    <div class="shell-logo" style="width:48px;height:48px;background:#ccc"></div>
    <div class="shell-heading"><h1>Workbench</h1></div>
  </header>
  <div class="shell-body">
    <div class="sidebar-desktop"><div style="height:1200px">sidebar</div></div>
    <main class="shell-main">
      <div class="workspace-panel vault-explorer-fullpage">
        <section class="vault-explorer" aria-label="Vault Explorer">
          <nav class="vault-explorer-breadcrumb" aria-label="Vault path">
            <button type="button">Vault</button>
          </nav>
          <div class="vault-explorer-body">
            <ul class="vault-explorer-entries" id="entries">
${entryRows(60)}
            </ul>
          </div>
        </section>
      </div>
    </main>
  </div>
</div>
</body>
</html>`;

interface Rect {
  height: number;
  top: number;
  bottom: number;
}

async function rectOf(page: Page, selector: string): Promise<Rect> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (el === null) throw new Error(`missing ${sel}`);
    const box = el.getBoundingClientRect();
    return { height: box.height, top: box.top, bottom: box.bottom };
  }, selector);
}

async function metrics(page: Page, selector: string): Promise<{ scrollTop: number; clientHeight: number; scrollHeight: number }> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (el === null) throw new Error(`missing ${sel}`);
    return { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
  }, selector);
}

async function rootMetrics(page: Page): Promise<{ scrollTop: number; clientHeight: number; scrollHeight: number }> {
  return page.evaluate(() => {
    const el = document.scrollingElement as Element;
    return { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
  });
}

async function innerScrollOwners(page: Page, scope: string): Promise<string[]> {
  return page.evaluate((scopeSel) => {
    const scopeEl = document.querySelector<HTMLElement>(scopeSel);
    if (scopeEl === null) throw new Error(`missing ${scopeSel}`);
    const owners: string[] = [];
    const walk = (el: Element) => {
      if (el !== scopeEl && el.scrollHeight > el.clientHeight + 1) {
        const overflowY = getComputedStyle(el).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") {
          owners.push(el.id !== "" ? `#${el.id}` : `#${String(el.className).split(/\s+/)[0]}`);
        }
      }
      for (const child of el.children) walk(child);
    };
    walk(scopeEl);
    return owners;
  }, scope);
}

const probe = describe.skipIf(chromePath === null || builtCssPath() === null)(
  "W2 real-browser Vault Explorer geometry probe (system Chrome, no screenshot guessing)",
  () => {
    let browser: Browser;
    let page: Page;
    let fixturePath: string;

    async function loadHtml(html: string): Promise<void> {
      writeFileSync(fixturePath, html);
      await page.goto(`file://${fixturePath}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    it("setup: launch system Chrome at desktop size", async () => {
      const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
        headless: true,
        args: ["--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check"],
      };
      if (chromePath !== null) launchOptions.executablePath = chromePath;
      browser = await puppeteer.launch(launchOptions);
      page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      fixturePath = join(mkdtempSync(join(tmpdir(), "w2-explorer-")), "index.html");
    }, 60_000);

    it("selected Conversation: the Explorer is the upper split pane above the live chat, one scroll owner per pane", async () => {
      const cssPath = builtCssPath() as string;
      const cssUrl = `file://${cssPath}`;
      await loadHtml(SPLIT_FIXTURE(cssUrl, 400));
      const splitHeight = (await metrics(page, "#split")).clientHeight;
      expect(splitHeight).toBeGreaterThan(480);
      // The shell sets the inline basis to the balanced default.
      const balanced = balancedChatPaneHeight(splitHeight);
      await loadHtml(SPLIT_FIXTURE(cssUrl, balanced));
      const splitHeight2 = (await metrics(page, "#split")).clientHeight;
      expect(splitHeight2).toBe(splitHeight);
      const companion = await rectOf(page, "#companion");
      const chat = await rectOf(page, "#chatpane");
      const resizer = await rectOf(page, ".split-resizer-host");
      expect(Math.abs(chat.height - balanced)).toBeLessThanOrEqual(2);
      const { min, max } = splitBounds(splitHeight);
      expect(chat.height).toBeGreaterThanOrEqual(min - 1);
      expect(chat.height).toBeLessThanOrEqual(max + 1);
      // Explorer pane (upper) sits directly above the resizer, which sits
      // directly above the chat pane (lower); the panes fill the split.
      expect(Math.abs(resizer.top - companion.bottom)).toBeLessThanOrEqual(2);
      expect(Math.abs(chat.top - resizer.bottom)).toBeLessThanOrEqual(2);
      expect(Math.abs(companion.height + resizer.height + chat.height - splitHeight)).toBeLessThanOrEqual(2);
      // One scroll owner per pane: explorer entries + conversation history.
      const entries = await metrics(page, "#entries");
      expect(entries.scrollHeight).toBeGreaterThan(entries.clientHeight);
      const history = await metrics(page, "#history");
      expect(history.scrollHeight).toBeGreaterThan(history.clientHeight);
      const owners = await innerScrollOwners(page, "#split");
      expect(owners.sort()).toEqual(["#entries", "#history"].sort());
      // V1: the Explorer scrollbar sits at the upper pane's right edge,
      // horizontally aligned with the lower chat-history scrollbar.
      const edges = await page.evaluate(() => {
        const rightOf = (sel: string) => {
          const el = document.querySelector<HTMLElement>(sel);
          if (el === null) throw new Error(`missing ${sel}`);
          return el.getBoundingClientRect().right;
        };
        return { entries: rightOf("#entries"), history: rightOf("#history") };
      });
      expect(Math.abs(edges.entries - edges.history)).toBeLessThanOrEqual(2);
      // The browser root does not scroll.
      const root = await rootMetrics(page);
      expect(root.scrollHeight).toBeLessThanOrEqual(root.clientHeight + 1);
    });

    it("no selected Conversation: the open Explorer is a full-page surface with one internal scroll owner and no split/resizer", async () => {
      const cssPath = builtCssPath() as string;
      const cssUrl = `file://${cssPath}`;
      await loadHtml(FULLPAGE_FIXTURE(cssUrl));
      // The full-page surface fills the workspace below the header (77px).
      const fullpage = await rectOf(page, ".vault-explorer-fullpage");
      expect(Math.abs(fullpage.bottom - 800)).toBeLessThanOrEqual(2);
      expect(fullpage.height).toBeGreaterThan(600);
      // No split, no resizer.
      expect(await page.evaluate(() => document.querySelectorAll(".split-resizer-host").length)).toBe(0);
      // ONE internal scroll owner (the entries list) and no root scroll.
      const entries = await metrics(page, "#entries");
      expect(entries.scrollHeight).toBeGreaterThan(entries.clientHeight);
      const owners = await innerScrollOwners(page, ".vault-explorer-fullpage");
      expect(owners).toEqual(["#entries"]);
      const root = await rootMetrics(page);
      expect(root.scrollHeight).toBeLessThanOrEqual(root.clientHeight + 1);
      expect(root.scrollTop).toBe(0);
    });
  },
);
