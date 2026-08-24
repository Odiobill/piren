import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

/**
 * ST-4 - REAL rendered Agent Groups layout in system Chrome (ST-2A/ST-3
 * convention: built stylesheet, geometry not screenshots, no live gateway/
 * platform contact; skipped when Chrome/built assets are unavailable).
 *
 * Proves at desktop and narrow/portrait sizes:
 *   - ready detail: group item, member rows (with the non-runnable marker),
 *     and the ordered fallback editor render visibly;
 *   - LONG group/member/fallback identifiers shrink instead of overflowing;
 *   - no horizontal document overflow;
 *   - no visible-panel second scroll owner;
 *   - the confirmation dialog is reachable above content with visible actions.
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
<title>ST-4 groups layout probe</title>
<link rel="stylesheet" href="${cssUrl}" />
<style>html, body { margin: 0; }</style>
</head>
<body>
<main class="shell-main">
  <div class="workspace-panel workspace-panel-conversations">
    <div class="settings-groups" id="groups-root">
      <ul class="settings-groups-list">
        <li><button type="button" class="settings-group-item settings-group-item-active button-link"><svg aria-hidden="true" width="13" height="13"></svg>research-team-with-a-deliberately-extremely-long-group-identifier</button></li>
      </ul>
      <div class="settings-agent-fallback-add-row">
        <input class="settings-groups-new-name" type="text" aria-label="New group name" value="" />
        <button type="button" class="settings-groups-create button-link" aria-label="Create group"><svg aria-hidden="true" width="13" height="13"></svg>Create group</button>
        <button type="button" class="settings-groups-validate button-link" aria-label="Validate all groups"><svg aria-hidden="true" width="13" height="13"></svg>Validate all groups</button>
      </div>
      <section aria-label="Group research" class="settings-group-detail">
        <h4>research-team-with-a-deliberately-extremely-long-group-identifier</h4>
        <ul class="settings-agent-fallback-list">
          <li class="settings-agent-fallback-row">
            <span class="settings-agent-fallback-model">kimi</span>
            <button type="button" class="settings-groups-remove" aria-label="Remove kimi"><svg aria-hidden="true" width="13" height="13"></svg></button>
          </li>
          <li class="settings-agent-fallback-row">
            <span class="settings-agent-fallback-model">offline-agent-with-a-deliberately-extremely-long-vault-identifier-0123456789</span>
            <span class="settings-groups-not-runnable">Not locally runnable</span>
            <button type="button" class="settings-groups-remove" aria-label="Remove offline agent"><svg aria-hidden="true" width="13" height="13"></svg></button>
          </li>
        </ul>
        <div class="settings-agent-fallback-add-row">
          <select class="settings-groups-add-select" aria-label="Add member to research">
            <option value="">Choose a vault agent…</option>
            <option value="another-offline-agent-with-an-even-longer-name-suffix-9876543210">another-offline-agent-with-an-even-longer-name-suffix-9876543210 (Not locally runnable)</option>
          </select>
          <button type="button" class="settings-groups-add button-link" aria-label="Add member to research"><svg aria-hidden="true" width="13" height="13"></svg>Add member</button>
        </div>
        <section class="settings-agent-family" aria-label="Fallback order in research">
          <strong>Fallback order per member</strong>
          <ol class="settings-agent-fallback-list settings-groups-fallback-list">
            <li class="settings-agent-fallback-row">
              <span class="settings-agent-fallback-model">anthropic/claude-opus-4-1-20250805-with-a-deliberately-extreme-candidate-suffix-string</span>
              <button type="button" class="settings-groups-fallback-up" aria-label="Move up">U</button>
              <button type="button" class="settings-groups-fallback-down" aria-label="Move down">D</button>
              <button type="button" class="settings-groups-fallback-remove" aria-label="Remove candidate">R</button>
            </li>
            <li class="settings-agent-fallback-row">
              <span class="settings-agent-fallback-model">openrouter/kimi-k3-long-identifier-abcdefghijklmnopqrstuvwxyz-0123456789</span>
              <button type="button" class="settings-groups-fallback-up" aria-label="Move up">U</button>
              <button type="button" class="settings-groups-fallback-down" aria-label="Move down">D</button>
              <button type="button" class="settings-groups-fallback-remove" aria-label="Remove candidate">R</button>
            </li>
          </ol>
          <button type="button" class="settings-groups-fallback-save settings-form-save button">Save fallback</button>
        </section>
      </section>
    </div>
  </div>
</main>
<div class="settings-help-backdrop" id="confirm-backdrop" hidden>
  <div class="settings-help-dialog card" role="dialog" aria-modal="true" id="confirm-dialog">
    <h4>Save fallback order for kimi?</h4>
    <p class="muted">Nothing has been written yet.</p>
    <div class="settings-agent-confirm-actions">
      <button type="button" class="settings-agent-confirm-save button">Confirm</button>
      <button type="button" class="settings-agent-confirm-cancel button">Cancel</button>
    </div>
  </div>
</div>
</body>
</html>`;

interface Report {
  documentOverflowX: boolean;
  innerScrollOwners: string[];
  groupItemVisible: boolean;
  memberRowsVisible: number;
  markerVisible: boolean;
  fallbackRowsVisible: number;
  rowControlsReachable: boolean;
}

async function measure(page: Page): Promise<Report> {
  return page.evaluate(() => {
    const scrollingElement = document.scrollingElement as Element;
    const owners: string[] = [];
    // Only the visible panel counts as a potential second scroll owner.
    const visiblePanel = Array.from(document.querySelectorAll<HTMLElement>(".workspace-panel")).find(
      (panel) => panel.getBoundingClientRect().width > 0,
    );
    const walk = (el: Element): void => {
      if (el.hasAttribute("hidden")) return;
      const cs = getComputedStyle(el);
      if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 1) {
        owners.push(el.className !== "" ? `.${String(el.className).split(/\s+/)[0]}` : el.tagName.toLowerCase());
      }
      for (const child of el.children) walk(child);
    };
    if (visiblePanel !== undefined) walk(visiblePanel);
    const isVisible = (el: Element): boolean => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
    };
    let rowControlsReachable = true;
    for (const row of Array.from(document.querySelectorAll<HTMLElement>(".settings-agent-fallback-row"))) {
      for (const button of Array.from(row.querySelectorAll("button"))) {
        if (!isVisible(button)) rowControlsReachable = false;
      }
    }
    return {
      documentOverflowX: scrollingElement.scrollWidth > scrollingElement.clientWidth + 1,
      innerScrollOwners: owners,
      groupItemVisible: isVisible(document.querySelector(".settings-group-item") as Element),
      memberRowsVisible: Array.from(document.querySelectorAll(".settings-agent-fallback-row .settings-groups-remove")).filter((r) => isVisible(r)).length,
      markerVisible: isVisible(document.querySelector(".settings-groups-not-runnable") as Element),
      fallbackRowsVisible: Array.from(document.querySelectorAll(".settings-groups-fallback-list .settings-agent-fallback-row")).filter((r) => isVisible(r)).length,
      rowControlsReachable,
    };
  });
}

const probe = describe.skipIf(chromePath === null || builtCssPath() === null)(
  "ST-4 real-browser agent groups layout probe (system Chrome, no screenshot guessing)",
  () => {
    let browser: Browser;
    let page: Page;
    let fixturePath: string;

    it("setup: launch system Chrome and load the built groups fixture", async () => {
      const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
        headless: true,
        args: ["--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check"],
      };
      if (chromePath !== null) launchOptions.executablePath = chromePath;
      browser = await puppeteer.launch(launchOptions);
      page = await browser.newPage();
      fixturePath = join(mkdtempSync(join(tmpdir(), "st4-groups-")), "index.html");
      writeFileSync(fixturePath, FIXTURE(`file://${builtCssPath() as string}`));
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`file://${fixturePath}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }, 60_000);

    it("desktop: ready detail, markers, ordered fallback controls; no overflow or second scroll owner", async () => {
      const report = await measure(page);
      expect(report.documentOverflowX).toBe(false);
      expect(report.innerScrollOwners).toEqual([]);
      expect(report.groupItemVisible).toBe(true);
      expect(report.memberRowsVisible).toBe(2);
      expect(report.markerVisible).toBe(true);
      expect(report.fallbackRowsVisible).toBe(2);
      expect(report.rowControlsReachable).toBe(true);

      // Confirmation reachability: unhide it and check placement.
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
      await page.evaluate(() => {
        (document.getElementById("confirm-backdrop") as HTMLElement).hidden = true;
      });
    });

    it("narrow portrait: long group/member/fallback ids shrink; controls stay reachable without horizontal overflow", async () => {
      await page.setViewport({ width: 420, height: 800 });
      await new Promise((resolve) => setTimeout(resolve, 120));
      const report = await measure(page);
      expect(report.documentOverflowX).toBe(false);
      expect(report.innerScrollOwners).toEqual([]);
      expect(report.memberRowsVisible).toBe(2);
      expect(report.fallbackRowsVisible).toBe(2);
      expect(report.markerVisible).toBe(true);
      expect(report.rowControlsReachable).toBe(true);
      // Every control stays inside the narrow viewport.
      const outside = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>(".settings-agent-fallback-row button")).filter((b) => {
          const r = b.getBoundingClientRect();
          return !(r.width > 0 && r.height > 0 && r.right <= window.innerWidth + 1);
        }).length,
      );
      expect(outside).toBe(0);
      await browser.close();
    });
  },
);

probe; // keep the descriptor referenced
