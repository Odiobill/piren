import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

/**
 * 0.2.5 S10 — REAL rendered geometry of the shared Workbench presentation
 * vocabulary in an actual browser (system Chrome via the minimal declared
 * `puppeteer-core`; W1/W2/P8/WUX-B precedent). Geometry, not screenshots:
 *
 * - the four full-page surfaces' shared vocabulary (.wb-page-header,
 *   .wb-surface, .wb-pill, .wb-row) actually resolves styles in the browser;
 * - representative Dashboard/Settings/Vault Explorer/Steward Alerts markup
 *   has NO horizontal overflow at desktop and narrow widths;
 * - required actions stay inside the viewport width (no clipped actions);
 * - the surfaces are token-driven: switching the emulated color scheme from
 *   light to dark changes the rendered background (no light-only styling).
 *
 * Requires a built `dist/public/assets` CSS artifact (npm run build), the
 * same requirement as the retained W1/W2/WUX-B probes.
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

function vaultRows(count: number): string {
  const rows: string[] = [];
  for (let i = 0; i < count; i += 1) {
    rows.push(
      `<li><button type="button" class="vault-explorer-entry wb-row"><span class="vault-entry-icon" aria-hidden="true">f</span><span>document-${i}.md</span></button></li>`,
    );
  }
  return rows.join("\n");
}

/**
 * One representative fixture carrying the shared vocabulary of all four
 * surfaces with the same data shapes used in the component suites.
 */
const FIXTURE = (cssUrl: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>S10 presentation geometry probe</title>
<link rel="stylesheet" href="${cssUrl}" />
<style>html, body { margin: 0; }</style>
</head>
<body>
<main class="shell-main" id="main">
  <section class="dashboard wb-page" aria-label="Dashboard">
    <header class="dashboard-welcome wb-page-header">
      <div class="dashboard-welcome-text wb-page-heading">
        <h2>Dashboard</h2>
        <p class="muted wb-page-lede">Start a Conversation with one agent or several peers.</p>
      </div>
    </header>
    <section class="card wb-surface" aria-labelledby="dashboard-agents-heading">
      <h3 id="dashboard-agents-heading">Start a conversation</h3>
      <ul class="agent-card-grid">
        <li class="agent-card"><button type="button" class="agent-select" aria-pressed="true">
          <span class="agent-card-avatar" aria-hidden="true">D</span>
          <span class="agent-card-body">
            <span class="agent-card-title-row"><span class="agent-name">Dipu</span>
            <span class="agent-status status-ok wb-pill wb-pill-ok">Online</span></span>
          </span></button></li>
      </ul>
      <div class="dashboard-actions">
        <button type="button" class="button button-primary dashboard-start" id="start-action">Start conversation</button>
        <button type="button" class="button dashboard-assign">Assign task</button>
      </div>
    </section>
  </section>

  <section class="settings-page wb-page" aria-label="Settings">
    <header class="settings-header wb-page-header">
      <span class="wb-page-icon" aria-hidden="true">S</span>
      <div class="wb-page-heading">
        <h2>Settings</h2>
        <p class="muted settings-lede wb-page-lede">Configure this installation.</p>
      </div>
    </header>
    <div class="settings-tabs" role="tablist" aria-label="Settings sections">
      <button type="button" role="tab" aria-selected="true">This installation</button>
      <button type="button" role="tab" aria-selected="false">Agent settings</button>
      <button type="button" role="tab" aria-selected="false">Agent groups</button>
    </div>
    <ul class="settings-family-list">
      <li class="settings-family wb-surface">Telegram settings</li>
      <li class="settings-family wb-surface">Discord settings</li>
    </ul>
  </section>

  <section class="vault-explorer" aria-label="Vault Explorer">
    <nav class="vault-explorer-breadcrumb wb-toolbar" aria-label="Vault path">
      <button type="button">Vault</button>
      <button type="button" class="vault-explorer-order-toggle" aria-pressed="false">Name</button>
    </nav>
    <div class="vault-explorer-body">
      <ul class="vault-explorer-entries">
${vaultRows(40)}
      </ul>
    </div>
  </section>

  <section class="steward-alerts" aria-label="Steward Alerts">
    <header class="steward-alerts-header wb-page-header">
      <span class="wb-page-icon" aria-hidden="true">!</span>
      <div class="wb-page-heading"><h2>Steward Alerts</h2></div>
    </header>
    <ul class="steward-alert-list">
      <li><button type="button" class="wb-row">
        <span class="steward-alert-severity severity-urgent wb-pill wb-pill-error">urgent</span>
        <strong>Urgent alert</strong><small>open · 2026-09-01</small>
      </button></li>
      <li><button type="button" class="wb-row">
        <span class="steward-alert-severity severity-normal wb-pill wb-pill-muted">normal</span>
        <strong>Normal alert</strong><small>open · 2026-09-02</small>
      </button></li>
    </ul>
    <article class="steward-alert-detail wb-surface">
      <p class="steward-alert-severity severity-urgent wb-pill wb-pill-error">urgent</p>
      <h3>Urgent alert</h3>
      <time dateTime="2026-09-01T10:00:00.000Z">2026-09-01T10:00:00.000Z</time>
      <p class="steward-alert-terminal steward-alert-terminal-closed wb-pill wb-pill-accent" role="status">Closed 2026-09-02</p>
    </article>
    <p class="steward-alert-terminal steward-alert-terminal-resolved wb-pill wb-pill-muted" role="status">Resolved 2026-09-01</p>
  </section>
</main>
</body>
</html>`;

const probe = describe.skipIf(chromePath === null || builtCssPath() === null)(
  "S10 real-browser shared presentation geometry (system Chrome)",
  () => {
    let browser: Browser;
    let page: Page;
    let fixturePath: string;

    it("setup: launch system Chrome", async () => {
      const launchOptions: Parameters<typeof puppeteer.launch>[0] = { headless: true };
      if (chromePath !== null) launchOptions.executablePath = chromePath;
      browser = await puppeteer.launch(launchOptions);
      page = await browser.newPage();
      fixturePath = join(mkdtempSync(join(tmpdir(), "piren-s10-geometry-")), "probe.html");
      writeFileSync(fixturePath, FIXTURE(`file://${builtCssPath()}`));
    });

    it("shared vocabulary resolves real styles, with no horizontal overflow and reachable actions at desktop width", async () => {
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`file://${fixturePath}`);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const result = await page.evaluate(() => {
        const root = document.scrollingElement as Element;
        const row = document.querySelector<HTMLElement>(".vault-explorer-entry.wb-row");
        const rowStyle = row === null ? null : getComputedStyle(row);
        const start = document.getElementById("start-action");
        const startRect = start?.getBoundingClientRect();
        const actions = [...document.querySelectorAll<HTMLElement>("button")];
        return {
          horizontalOverflow: root.scrollWidth > root.clientWidth + 1,
          rowBorderRadius: rowStyle?.borderTopLeftRadius ?? "none",
          rowBorderRadiusStyled: rowStyle !== null && rowStyle.borderTopLeftRadius !== "0px",
          startWithinViewport: startRect !== undefined && startRect.right <= window.innerWidth && startRect.left >= 0,
          clippedActions: actions.filter((button) => {
            const rect = button.getBoundingClientRect();
            return rect.width > 0 && (rect.right > window.innerWidth + 1 || rect.left < -1);
          }).length,
        };
      });

      expect(result.horizontalOverflow).toBe(false);
      expect(result.rowBorderRadiusStyled).toBe(true);
      expect(result.startWithinViewport).toBe(true);
      expect(result.clippedActions).toBe(0);
    });

    it("narrow width keeps every required action reachable with no horizontal overflow", async () => {
      await page.setViewport({ width: 390, height: 844 });
      await page.goto(`file://${fixturePath}`);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const result = await page.evaluate(() => {
        const root = document.scrollingElement as Element;
        const actions = [...document.querySelectorAll<HTMLElement>("button")];
        return {
          horizontalOverflow: root.scrollWidth > root.clientWidth + 1,
          clippedActions: actions.filter((button) => {
            const rect = button.getBoundingClientRect();
            return rect.width > 0 && (rect.right > window.innerWidth + 1 || rect.left < -1);
          }).length,
        };
      });

      expect(result.horizontalOverflow).toBe(false);
      expect(result.clippedActions).toBe(0);
    });

    it("surfaces are token-driven: the dark color scheme changes the rendered background", async () => {
      await page.setViewport({ width: 1280, height: 900 });
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
      await page.goto(`file://${fixturePath}`);
      const lightBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const darkBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(darkBackground).not.toBe(lightBackground);
    });

    it("teardown: close the browser", async () => {
      await browser.close();
    });
  },
);

void probe;
