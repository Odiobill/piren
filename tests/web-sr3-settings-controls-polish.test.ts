import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

/**
 * SR-3 - REAL rendered Settings controls in system Chrome against the BUILT
 * stylesheet (ST-2A/ST-3/ST-4 probe convention: geometry and computed
 * styles, not screenshots; no live gateway/platform contact; skipped when
 * Chrome/built assets are unavailable).
 *
 * Proves the polished Settings text inputs and selects (including the Groups
 * create/add/fallback controls):
 *   - surface background, rounded border, comfortable padding, readable text;
 *   - visible focus ring on keyboard focus;
 *   - disabled state is visually distinct from enabled;
 *   - long values/options shrink instead of overflowing at narrow width;
 *   - no horizontal document overflow at any probed size.
 *
 * Scoped to the Settings page classes only; dashboard/conversation/native
 * controls are absent from this fixture by construction.
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

const LONG = "anthropic/claude-opus-4-1-with-a-deliberately-extreme-long-value-suffix-0123456789-abcdefghijklmnopqrstuvwxyz";

/** Fixture replicating the real SettingsView/AgentGroupsPanel DOM classes. */
const FIXTURE = (cssUrl: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>SR-3 settings controls polish probe</title>
<link rel="stylesheet" href="${cssUrl}" />
<style>html, body { margin: 0; }</style>
</head>
<body>
<main class="shell-main">
  <div class="settings-page">
    <section role="tabpanel" id="settings-panel-groups">
      <div class="settings-groups" id="groups-root">
        <div class="settings-agent-fallback-add-row">
          <input class="settings-groups-new-name" type="text" aria-label="New group name"
                 value="${LONG}" placeholder="new-group-name" />
          <button type="button" class="settings-groups-create button-link">Create group</button>
          <button type="button" class="settings-groups-validate button-link">Validate all groups</button>
        </div>
        <section class="settings-agent-family" aria-label="Fallback order in test">
          <label class="settings-field">
            Fallback target (member)
            <select class="settings-groups-fallback-member">
              <option value="">Choose a member…</option>
              <option value="Piren">Piren</option>
            </select>
          </label>
          <ol class="settings-agent-fallback-list settings-groups-fallback-list">
            <li class="settings-agent-fallback-row">
              <span class="settings-agent-fallback-model">${LONG}</span>
              <button type="button" class="settings-groups-fallback-remove">R</button>
            </li>
          </ol>
          <div class="settings-agent-fallback-add-row">
            <select class="settings-groups-fallback-candidate-select" aria-label="Add fallback candidate">
              <option value="">Choose a candidate…</option>
              <option value="${LONG}" selected>${LONG}</option>
            </select>
          </div>
          <p class="settings-form-error settings-groups-fallback-alert" role="alert">
            Vera is already in the ordered list.
          </p>
          <input class="settings-groups-disabled-probe" type="text" disabled aria-label="Disabled control" />
        </section>
      </div>
    </section>
  </div>
</main>
</body>
</html>`;

interface Report {
  overflowX: boolean;
  background: string;
  borderRadiusPx: number;
  paddingYPx: number;
  fontPx: number;
  focusOutlineWidthPx: number;
  disabledBackground: string;
  enabledBackground: string;
  selectWithinViewport: boolean;
  inputWithinViewport: boolean;
  alertInsideFamily: boolean;
  alertNotBelowCreateRow: boolean;
}

async function measure(page: Page): Promise<Report> {
  return page.evaluate(() => {
    const scrollingElement = document.scrollingElement as Element;
    const input = document.querySelector<HTMLInputElement>(".settings-groups-new-name")!;
    const select = document.querySelector<HTMLSelectElement>(".settings-groups-fallback-candidate-select")!;
    const disabledInput = document.querySelector<HTMLInputElement>(".settings-groups-disabled-probe")!;
    const enabledStyle = getComputedStyle(input);
    const selectStyle = getComputedStyle(select);
    // Keyboard focus must be visible.
    input.focus();
    const focusedOutline = getComputedStyle(input).outlineWidth;
    input.blur();
    const withinViewport = (el: Element): boolean => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.right <= window.innerWidth + 1;
    };
    const alert = document.querySelector<HTMLElement>(".settings-groups-fallback-alert")!;
    const createRow = document.querySelector<HTMLElement>(".settings-agent-fallback-add-row")!;
    return {
      overflowX: scrollingElement.scrollWidth > scrollingElement.clientWidth + 1,
      background: selectStyle.backgroundColor,
      borderRadiusPx: Number.parseFloat(selectStyle.borderRadius),
      paddingYPx: Number.parseFloat(selectStyle.paddingTop) + Number.parseFloat(selectStyle.paddingBottom),
      fontPx: Number.parseFloat(selectStyle.fontSize),
      focusOutlineWidthPx: Number.parseFloat(focusedOutline),
      disabledBackground: getComputedStyle(disabledInput).backgroundColor,
      enabledBackground: enabledStyle.backgroundColor,
      selectWithinViewport: withinViewport(select),
      inputWithinViewport: withinViewport(input),
      alertInsideFamily: alert.closest(".settings-agent-family") !== null,
      // The fallback-local alert must render BELOW the candidate row inside
      // the editor, never under the New group name form.
      alertNotBelowCreateRow:
        alert.closest(".settings-agent-family") !== null &&
        !Array.from(document.querySelectorAll(".settings-agent-fallback-add-row")).some(
          (row) => row === createRow && row.contains(alert),
        ),
    };
  });
}

const probe = describe.skipIf(chromePath === null || builtCssPath() === null)(
  "SR-3 real-browser settings controls polish probe (system Chrome, built CSS)",
  () => {
    let browser: Browser;
    let page: Page;

    it("setup: launch system Chrome and load the built settings fixture", async () => {
      const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
        headless: true,
        args: ["--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check"],
      };
      if (chromePath !== null) launchOptions.executablePath = chromePath;
      browser = await puppeteer.launch(launchOptions);
      page = await browser.newPage();
      const fixturePath = join(mkdtempSync(join(tmpdir(), "sr3-controls-")), "index.html");
      writeFileSync(fixturePath, FIXTURE(`file://${builtCssPath() as string}`));
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`file://${fixturePath}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }, 60_000);

    it("desktop: inputs/selects are styled like Workbench cards with visible focus", async () => {
      const report = await measure(page);
      expect(report.overflowX).toBe(false);
      expect(report.borderRadiusPx).toBeGreaterThanOrEqual(8);
      expect(report.paddingYPx).toBeGreaterThanOrEqual(10);
      expect(report.fontPx).toBeGreaterThanOrEqual(13);
      expect(report.focusOutlineWidthPx).toBeGreaterThanOrEqual(2);
      // Surface background on both enabled and disabled controls, distinct
      // disabled state.
      expect(report.enabledBackground).not.toBe("rgba(0, 0, 0, 0)");
      expect(report.disabledBackground).not.toBe(report.enabledBackground);
      expect(report.alertInsideFamily).toBe(true);
      expect(report.alertNotBelowCreateRow).toBe(true);
    });

    it("narrow portrait: long values/options shrink; no horizontal overflow", async () => {
      await page.setViewport({ width: 420, height: 800 });
      await new Promise((resolve) => setTimeout(resolve, 120));
      const report = await measure(page);
      expect(report.overflowX).toBe(false);
      expect(report.selectWithinViewport).toBe(true);
      expect(report.inputWithinViewport).toBe(true);
      await browser.close();
    });
  },
);

probe; // keep the descriptor referenced
