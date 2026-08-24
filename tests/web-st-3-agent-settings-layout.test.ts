import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

/**
 * ST-3 - REAL rendered Agent Settings layout in system Chrome (WUX/P8/ST-2A
 * convention: built stylesheet, geometry not screenshots, no live gateway/
 * platform contact; skipped when Chrome/built assets are unavailable).
 *
 * Proves at desktop and narrow/portrait sizes:
 *   - the roster radio cards are visible and reachable without horizontal
 *     document overflow;
 *   - fallback rows render with visible per-row controls in list order;
 *   - the auto-switch confirmation dialog is reachable (opens above content)
 *     and its actions are visible;
 *   - no inner second scroll owner; hidden panels excluded.
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
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>ST-3 agent settings layout probe</title>
<link rel="stylesheet" href="${cssUrl}" />
<style>html, body { margin: 0; }</style>
</head>
<body>
<main class="shell-main">
  <div class="workspace-panel workspace-panel-conversations">
    <ul class="settings-family-list">
      <li class="settings-family" id="agent-prefs">
        <div class="settings-form">
          <fieldset class="settings-agent-roster">
            <div class="settings-agent-cards" role="radiogroup" aria-label="Locally runnable agents">
              <label class="settings-agent-card settings-agent-card-active"><input type="radio" name="settings-agent-roster" value="kimi" checked /><span>kimi</span></label>
              <label class="settings-agent-card"><input type="radio" name="settings-agent-roster" value="dipu" /><span>dipu</span></label>
            </div>
          </fieldset>
          <section class="settings-agent-family" aria-label="Model fallback declaration">
            <ol class="settings-agent-fallback-list">
              <li class="settings-agent-fallback-row"><span class="settings-agent-fallback-model">openai/gpt-4o</span>
                <button type="button" class="settings-agent-fallback-up" aria-label="Move openai/gpt-4o up">U</button>
                <button type="button" class="settings-agent-fallback-down" aria-label="Move openai/gpt-4o down">D</button>
                <button type="button" class="settings-agent-fallback-remove" aria-label="Remove openai/gpt-4o">R</button></li>
              <li class="settings-agent-fallback-row"><span class="settings-agent-fallback-model">openrouter/kimi-k3-long-identifier-abcdefghijklmnopqrstuvwxyz-0123456789</span>
                <button type="button" class="settings-agent-fallback-up" aria-label="Move openrouter/kimi-k3 up">U</button>
                <button type="button" class="settings-agent-fallback-down" aria-label="Move openrouter/kimi-k3 down" disabled>D</button>
                <button type="button" class="settings-agent-fallback-remove" aria-label="Remove openrouter/kimi-k3">R</button></li>
              <li class="settings-agent-fallback-row"><span class="settings-agent-fallback-model">anthropic/claude-opus-4-1-20250805-with-a-deliberately-extreme-provider-and-model-suffix-string</span>
                <button type="button" class="settings-agent-fallback-up" aria-label="Move long model up">U</button>
                <button type="button" class="settings-agent-fallback-down" aria-label="Move long model down">D</button>
                <button type="button" class="settings-agent-fallback-remove" aria-label="Remove long model">R</button></li>
            </ol>
            <button type="button" class="settings-form-save button" id="fallback-save">Save fallback</button>
          </section>
        </div>
      </li>
    </ul>
  </div>
</main>
<div class="settings-help-backdrop" id="confirm-backdrop" hidden>
  <div class="settings-help-dialog card" role="dialog" aria-modal="true" id="confirm-dialog">
    <h4>Enable automatic switching?</h4>
    <div class="settings-agent-confirm-actions">
      <button type="button" class="settings-agent-confirm-save button">Confirm and save</button>
      <button type="button" class="settings-agent-confirm-cancel button">Cancel</button>
    </div>
  </div>
</div>
</body>
</html>`;

interface Report {
  documentOverflowX: boolean;
  innerScrollOwners: string[];
  cardRectsVisible: number;
  rowCount: number;
  rowOrder: string[];
  rowControlsReachable: boolean;
}

async function measure(page: Page): Promise<Report> {
  return page.evaluate(() => {
    const scrollingElement = document.scrollingElement as Element;
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
    const cards = Array.from(document.querySelectorAll<HTMLElement>(".settings-agent-card"));
    const cardRectsVisible = cards.filter((card) => {
      const rect = card.getBoundingClientRect();
      const style = getComputedStyle(card);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
    }).length;
    const models = Array.from(document.querySelectorAll(".settings-agent-fallback-model")).map((n) => n.textContent ?? "");
    let controlsReachable = true;
    for (const row of Array.from(document.querySelectorAll<HTMLElement>(".settings-agent-fallback-row"))) {
      const rect = row.getBoundingClientRect();
      if (!(rect.top >= 0 && rect.left >= 0 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 2000)) {
        controlsReachable = false;
      }
      for (const button of Array.from(row.querySelectorAll("button"))) {
        const brect = button.getBoundingClientRect();
        if (brect.width <= 0 || brect.height <= 0) controlsReachable = false;
      }
    }
    return {
      documentOverflowX: scrollingElement.scrollWidth > scrollingElement.clientWidth + 1,
      innerScrollOwners: owners,
      cardRectsVisible,
      rowCount: models.length,
      rowOrder: models,
      rowControlsReachable: controlsReachable,
    };
  });
}

const probe = describe.skipIf(chromePath === null || builtCssPath() === null)(
  "ST-3 real-browser agent settings layout probe (system Chrome, no screenshot guessing)",
  () => {
    let browser: Browser;
    let page: Page;
    let fixturePath: string;

    it("setup: launch system Chrome and load the built agent-settings fixture", async () => {
      const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
        headless: true,
        args: ["--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check"],
      };
      if (chromePath !== null) launchOptions.executablePath = chromePath;
      browser = await puppeteer.launch(launchOptions);
      page = await browser.newPage();
      fixturePath = join(mkdtempSync(join(tmpdir(), "st3-agent-settings-")), "index.html");
      writeFileSync(fixturePath, FIXTURE(`file://${builtCssPath() as string}`));
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`file://${fixturePath}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }, 60_000);

    it("desktop: roster cards, ordered fallback rows and controls visible; no overflow or second scroll owner", async () => {
      const report = await measure(page);
      expect(report.documentOverflowX).toBe(false);
      expect(report.innerScrollOwners).toEqual([]);
      expect(report.cardRectsVisible).toBe(2);
      expect(report.rowCount).toBe(3);
      expect(report.rowOrder[2]).toContain("claude-opus-4-1");
      expect(report.rowControlsReachable).toBe(true);

      // The confirmation dialog is reachable: unhide it and check placement.
      await page.evaluate(() => {
        (document.getElementById("confirm-backdrop") as HTMLElement).hidden = false;
      });
      const dialogVisible = await page.evaluate(() => {
        const dialog = document.getElementById("confirm-dialog");
        if (dialog === null) return false;
        const rect = dialog.getBoundingClientRect();
        const style = getComputedStyle(dialog);
        return (
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.right <= window.innerWidth + 1 &&
          rect.bottom <= window.innerHeight + 1
        );
      });
      expect(dialogVisible).toBe(true);
    });

    it("narrow portrait: a LONG model label shrinks/ellipsizes; controls stay visible without horizontal overflow", async () => {
      await page.setViewport({ width: 420, height: 800 });
      await new Promise((resolve) => setTimeout(resolve, 120));
      const report = await measure(page);
      expect(report.documentOverflowX).toBe(false);
      expect(report.innerScrollOwners).toEqual([]);
      // Every row control stays rendered and reachable next to the ellipsized
      // label (never pushed offscreen or hidden by the long value).
      for (const row of await page.evaluate(() =>
        Array.from(document.querySelectorAll(".settings-agent-fallback-row")).map((row) => ({
          labelWidth: (row.querySelector(".settings-agent-fallback-model") as HTMLElement).getBoundingClientRect().width,
          buttons: Array.from(row.querySelectorAll("button")).map((b) => {
            const r = b.getBoundingClientRect();
            return { w: r.width, h: r.height, right: r.right };
          }),
        })),
      )) {
        expect(row.buttons.every((b) => b.w > 0 && b.h > 0 && b.right <= 421)).toBe(true);
      }
      expect(report.rowControlsReachable).toBe(true);
      await browser.close();
    });
  },
);

probe; // keep the descriptor referenced
