import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

/**
 * VR-3 - REAL rendered work-card layout in system Chrome against the BUILT
 * stylesheet (ST-2A/ST-3/ST-4 convention: geometry and computed styles, not
 * screenshots; no live gateway/platform contact; skipped when Chrome/built
 * assets are unavailable).
 *
 * Proves at desktop and narrow widths:
 *   - the transient activity cards directly follow the durable timeline in
 *     the existing history scroll owner (no second scroll region);
 *   - the bounded streamed tail and safe tool lines render within the card
 *     without horizontal overflow;
 *   - the scoped Abort control stays visible and reachable.
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

const LONG = "anthropic/claude-opus-4-1-with-a-deliberately-extreme-streamed-tail-suffix-0123456789-abcdefghijklmnopqrstuvwxyz";

const FIXTURE = (cssUrl: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>VR-3 work cards layout probe</title>
<link rel="stylesheet" href="${cssUrl}" />
<style>html, body { margin: 0; }</style>
</head>
<body>
<main class="shell-main">
  <div class="conversation-workspace">
    <div class="conversation-history" id="history" role="region" aria-label="Conversation history">
      <div class="mock-timeline" id="timeline">
        <div class="conversation-row">durable steward message</div>
        <div class="conversation-row">durable agent reply</div>
      </div>
      <div class="conversation-activity-cards" id="cards" aria-label="Live agent activity">
        <div class="activity-card activity-card-typing">
          <span class="activity-card-agent">dipu</span>
          <span class="activity-card-state">is typing…</span>
          <button type="button" class="transient-run-abort" data-activity-abort-run-id="r1" aria-label="Abort dipu's current work">Abort</button>
          <p class="activity-card-tail">…${LONG}${LONG}</p>
          <ul class="activity-card-tools">
            <li>vault_read — started</li>
            <li>bash — failed</li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</main>
</body>
</html>`;

interface Report {
  documentOverflowX: boolean;
  innerScrollOwners: string[];
  cardsFollowTimeline: boolean;
  tailVisible: boolean;
  toolsVisible: number;
  abortReachable: boolean;
}

async function measure(page: Page): Promise<Report> {
  return page.evaluate(() => {
    const scrollingElement = document.scrollingElement as Element;
    const history = document.getElementById("history") as HTMLElement;
    const cards = document.getElementById("cards") as HTMLElement;
    const timeline = document.getElementById("timeline") as HTMLElement;
    const owners: string[] = [];
    const visiblePanel = Array.from(document.querySelectorAll<HTMLElement>(".workspace-panel")).find(
      (panel) => panel.getBoundingClientRect().width > 0,
    );
    const walk = (el: Element): void => {
      if (el.hasAttribute("hidden")) return;
      const cs = getComputedStyle(el);
      if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 1) {
        owners.push(el.className !== "" ? `.${String(el.className).split(/\\s+/)[0]}` : el.tagName.toLowerCase());
      }
      for (const child of el.children) walk(child);
    };
    if (visiblePanel !== undefined) walk(visiblePanel);
    else walk(history);
    const isVisible = (el: Element | null): boolean => {
      if (el === null) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const abort = document.querySelector<HTMLElement>(".transient-run-abort");
    const abortRect = abort?.getBoundingClientRect();
    return {
      documentOverflowX: scrollingElement.scrollWidth > scrollingElement.clientWidth + 1,
      innerScrollOwners: owners,
      cardsFollowTimeline: cards.previousElementSibling === timeline && cards.parentElement === history,
      tailVisible: isVisible(document.querySelector(".activity-card-tail")),
      toolsVisible: Array.from(document.querySelectorAll(".activity-card-tools li")).filter((li) => isVisible(li)).length,
      abortReachable: isVisible(abort) && abortRect !== undefined && abortRect.left >= 0 && abortRect.right <= window.innerWidth + 1,
    };
  });
}

const probe = describe.skipIf(chromePath === null || builtCssPath() === null)(
  "VR-3 real-browser work-card layout probe (system Chrome, built CSS)",
  () => {
    let browser: Browser;
    let page: Page;

    it("setup: launch system Chrome and load the built work-card fixture", async () => {
      const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
        headless: true,
        args: ["--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check"],
      };
      if (chromePath !== null) launchOptions.executablePath = chromePath;
      browser = await puppeteer.launch(launchOptions);
      page = await browser.newPage();
      const fixturePath = join(mkdtempSync(join(tmpdir(), "vr3-cards-")), "index.html");
      writeFileSync(fixturePath, FIXTURE(`file://${builtCssPath() as string}`));
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`file://${fixturePath}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }, 60_000);

    it("desktop: cards directly follow the timeline in the history scroll owner; tail/tools/abort visible; no second scroll owner", async () => {
      const report = await measure(page);
      expect(report.documentOverflowX).toBe(false);
      expect(report.innerScrollOwners).toEqual([]);
      expect(report.cardsFollowTimeline).toBe(true);
      expect(report.tailVisible).toBe(true);
      expect(report.toolsVisible).toBe(2);
      expect(report.abortReachable).toBe(true);
    });

    it("narrow portrait: long tail/tool text shrinks without horizontal overflow; abort stays reachable", async () => {
      await page.setViewport({ width: 420, height: 800 });
      await new Promise((resolve) => setTimeout(resolve, 120));
      const report = await measure(page);
      expect(report.documentOverflowX).toBe(false);
      expect(report.innerScrollOwners).toEqual([]);
      expect(report.cardsFollowTimeline).toBe(true);
      expect(report.tailVisible).toBe(true);
      expect(report.toolsVisible).toBe(2);
      expect(report.abortReachable).toBe(true);
      await browser.close();
    });
  },
);

probe; // keep the descriptor referenced
