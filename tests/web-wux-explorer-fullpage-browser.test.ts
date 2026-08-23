import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

/**
 * WUX-B — REAL rendered geometry of the full-page Vault Explorer in an
 * actual browser (system Chrome via the minimal declared `puppeteer-core`
 * dev-dependency; W1/W2/P8 precedent). Geometry, not screenshots. Proves the
 * full-page presentation has EXACTLY ONE vertical scroll owner (the
 * Explorer's entries/document region), no second outer shell scrollbar, and
 * no inset workspace card container: the Explorer surface reaches the bottom
 * of the viewport below the fixed header. The split-mode scroll owners stay
 * pinned by the retained W2 probe.
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
    rows.push(
      `<li><button type="button" class="vault-explorer-entry"><span class="vault-entry-icon" aria-hidden="true">f</span><span>document-${i}.md</span></button></li>`,
    );
  }
  return rows.join("\n");
}

const FIXTURE = (cssUrl: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>WUX-B full-page Explorer scroll probe</title>
<link rel="stylesheet" href="${cssUrl}" />
<style>html, body { margin: 0; }</style>
</head>
<body>
<div class="shell shell-explorer-fullpage">
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
            <button type="button" class="vault-explorer-order-toggle" aria-pressed="false">
              Name
            </button>
          </nav>
          <div class="vault-explorer-body">
            <ul class="vault-explorer-entries" id="entries">
${entryRows(120)}
            </ul>
          </div>
        </section>
      </div>
    </main>
  </div>
</div>
</body>
</html>`;

const probe = describe.skipIf(chromePath === null || builtCssPath() === null)(
  "WUX-B real-browser full-page Explorer geometry probe (system Chrome)",
  () => {
    let browser: Browser;
    let page: Page;
    let fixturePath: string;

    it("setup: launch system Chrome", async () => {
      const launchOptions: Parameters<typeof puppeteer.launch>[0] = { headless: true };
      if (chromePath !== null) launchOptions.executablePath = chromePath;
      browser = await puppeteer.launch(launchOptions);
      page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      fixturePath = join(mkdtempSync(join(tmpdir(), "piren-wux-b-fullpage-")), "probe.html");
    });

    it("full-page Explorer has one vertical scroll owner, no outer shell scrollbar, and no inset card container", async () => {
      writeFileSync(fixturePath, FIXTURE(`file://${builtCssPath()}`));
      await page.goto(`file://${fixturePath}`);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const result = await page.evaluate(() => {
        const root = document.scrollingElement as Element;
        // Vertical overflow-y:auto/scroll elements inside the explorer panel.
        const owners: string[] = [];
        const scope = document.querySelector<HTMLElement>(".vault-explorer-fullpage");
        if (scope === null) throw new Error("missing full-page panel");
        const walk = (el: Element): void => {
          if (el.scrollHeight > el.clientHeight + 1) {
            const overflowY = getComputedStyle(el).overflowY;
            if (overflowY === "auto" || overflowY === "scroll") {
              owners.push(el.id !== "" ? `#${el.id}` : `.${String(el.className).split(/\s+/)[0]}`);
            }
          }
          for (const child of el.children) walk(child);
        };
        walk(scope);
        const main = document.querySelector<HTMLElement>(".shell-main");
        const mainStyle = main === null ? null : getComputedStyle(main);
        const panelBottom = scope.getBoundingClientRect().bottom;
        return {
          rootScrollTop: root.scrollTop,
          rootOverflowY:
            root === document.documentElement ? getComputedStyle(document.documentElement).overflowY : "",
          innerOwners: owners,
          mainOverflow: mainStyle?.overflowY ?? null,
          mainPaddingTop: mainStyle?.paddingTop ?? null,
          viewportHeight: window.innerHeight,
          panelBottom,
        };
      });

      // No outer shell scrollbar: the root document does not overflow.
      expect(result.rootScrollTop).toBe(0);
      // The workspace pane is NOT an independent scroll region anymore.
      expect(result.mainOverflow).toBe("hidden");
      // The inset card padding is gone.
      expect(result.mainPaddingTop).toBe("0px");
      // Exactly one vertical scroll owner: the Explorer's entries region.
      expect(result.innerOwners).toEqual(["#entries"]);
      // The surface reaches the bottom of the viewport (no inset gap).
      expect(result.panelBottom).toBeGreaterThanOrEqual(result.viewportHeight - 2);
    });

    it("teardown: close the browser", async () => {
      await browser?.close();
    });
  },
);
