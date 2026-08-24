import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

/**
 * ST-2A lead correction - REAL rendered Settings layout in system Chrome
 * (puppeteer-core against the BUILT stylesheet; geometry, not screenshots;
 * no live gateway/platform contact; skipped when Chrome/built assets are
 * unavailable, consistent with the WUX/P8 probes).
 *
 * Proves at desktop and narrow/portrait sizes:
 *   - all three tabs are visible and reachable without horizontal overflow;
 *   - inactive panels do not create a second scroll owner (only the browser
 *     root document may scroll);
 *   - the installation cards are visible in the default active panel.
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

/** Fixture replicating the real SettingsView DOM structure and classes. */
const FIXTURE = (cssUrl: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>ST-2A settings layout probe</title>
<link rel="stylesheet" href="${cssUrl}" />
<style>html, body { margin: 0; }</style>
</head>
<body>
<main class="shell-main">
  <div class="workspace-panel workspace-panel-conversations">
    <div class="settings-page" id="settings-page">
      <header class="settings-header"><h2>Settings</h2></header>
      <div class="settings-tabs" role="tablist" aria-label="Settings sections">
        <button type="button" role="tab" id="settings-tab-installation" aria-selected="true"
                aria-controls="settings-panel-installation" class="settings-tab settings-tab-active">This installation</button>
        <button type="button" role="tab" id="settings-tab-agents" aria-selected="false"
                aria-controls="settings-panel-agents" class="settings-tab">Agent settings</button>
        <button type="button" role="tab" id="settings-tab-groups" aria-selected="false"
                aria-controls="settings-panel-groups" class="settings-tab">Agent groups</button>
      </div>
      <section role="tabpanel" id="settings-panel-installation" aria-labelledby="settings-tab-installation">
        <ul class="settings-family-list">
          <li class="settings-family" id="card-telegram"><strong>Telegram transport</strong></li>
          <li class="settings-family" id="card-discord"><strong>Discord transport</strong></li>
          <li class="settings-family" id="card-scheduler"><strong>Scheduler automation</strong></li>
        </ul>
      </section>
      <section role="tabpanel" id="settings-panel-agents" aria-labelledby="settings-tab-agents" hidden>
        <ul class="settings-family-list"><li class="settings-family">Agent preferences</li></ul>
      </section>
      <section role="tabpanel" id="settings-panel-groups" aria-labelledby="settings-tab-groups" hidden>
        <p class="muted">Group management is not available yet.</p>
      </section>
    </div>
  </div>
</main>
</body>
</html>`;

interface OverflowReport {
  documentOverflowX: boolean;
  innerScrollOwners: string[];
  tabRects: Array<{ label: string; visible: boolean; insideViewport: boolean }>;
  activeCardVisible: boolean;
  inactivePanelDisplay: string;
}

const probe = describe.skipIf(chromePath === null || builtCssPath() === null)(
  "ST-2A real-browser Settings layout probe (system Chrome, no screenshot guessing)",
  () => {
    let browser: Browser;
    let page: Page;
    let fixturePath: string;

    async function measure(): Promise<OverflowReport> {
      return page.evaluate(() => {
        const scrollingElement = document.scrollingElement as Element;
        const documentOverflowX = scrollingElement.scrollWidth > scrollingElement.clientWidth + 1;
        // Any VISIBLE inner element with a real overflow becomes a second
        // scroll owner; hidden panels must not count.
        const owners: string[] = [];
        const walk = (el: Element): void => {
          if (el.hasAttribute("hidden")) return;
          const cs = getComputedStyle(el);
          if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 1) {
            owners.push(el.className !== "" ? `.${String(el.className).split(/\s+/)[0]}` : el.tagName.toLowerCase());
          }
          for (const child of el.children) walk(child);
        };
        walk(document.body);
        const tabRects = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]')).map((tab) => {
          const rect = tab.getBoundingClientRect();
          const style = getComputedStyle(tab);
          const visible = style.display !== "none" && style.visibility !== "hidden" && rect.height > 0 && rect.width > 0;
          const insideViewport =
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.right <= window.innerWidth + 1 &&
            rect.bottom <= window.innerHeight + 1;
          return { label: tab.textContent?.trim() ?? "", visible, insideViewport };
        });
        const card = document.querySelector("#card-telegram");
        const cardStyle = card === null ? null : getComputedStyle(card);
        const cardRect = card?.getBoundingClientRect();
        const activeCardVisible =
          cardStyle !== null &&
          cardStyle.display !== "none" &&
          (cardRect?.height ?? 0) > 0 &&
          (cardRect?.width ?? 0) > 0;
        const inactivePanel = document.getElementById("settings-panel-agents");
        return {
          documentOverflowX,
          innerScrollOwners: owners,
          tabRects,
          activeCardVisible,
          inactivePanelDisplay: inactivePanel === null ? "missing" : getComputedStyle(inactivePanel).display,
        };
      });
    }

    it("setup: launch system Chrome and load the built settings fixture", async () => {
      const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
        headless: true,
        args: ["--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check"],
      };
      if (chromePath !== null) launchOptions.executablePath = chromePath;
      browser = await puppeteer.launch(launchOptions);
      page = await browser.newPage();
      fixturePath = join(mkdtempSync(join(tmpdir(), "st2a-settings-")), "index.html");
      writeFileSync(fixturePath, FIXTURE(`file://${builtCssPath() as string}`));
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(`file://${fixturePath}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }, 60_000);

    it("desktop: tabs visible/reachable, no horizontal overflow, no second scroll owner, cards visible", async () => {
      const report = await measure();
      expect(report.documentOverflowX).toBe(false);
      expect(report.innerScrollOwners).toEqual([]);
      expect(report.tabRects).toHaveLength(3);
      for (const tab of report.tabRects) {
        expect(`${tab.label}: ${tab.visible} ${tab.insideViewport}`).toBe(`${tab.label}: true true`);
      }
      expect(report.activeCardVisible).toBe(true);
      expect(report.inactivePanelDisplay).toBe("none");
    });

    it("narrow portrait: tabs remain stacked and reachable without horizontal overflow or scroll traps", async () => {
      await page.setViewport({ width: 420, height: 800 });
      await new Promise((resolve) => setTimeout(resolve, 120));
      const report = await measure();
      expect(report.documentOverflowX).toBe(false);
      expect(report.innerScrollOwners).toEqual([]);
      for (const tab of report.tabRects) {
        expect(`${tab.label}: ${tab.visible} ${tab.insideViewport}`).toBe(`${tab.label}: true true`);
      }
      expect(report.activeCardVisible).toBe(true);
      await browser.close();
    });
  },
);

probe; // keep the descriptor referenced
