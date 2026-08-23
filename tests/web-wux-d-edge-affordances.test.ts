import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

/**
 * WUX-D — visibly afford split resize and mirror durable message edge
 * accents (presentation-only Conversation polish). Two closed behaviors:
 *   - In the active desktop split view, the accessible horizontal resizer is
 *     PERCEPTIBLY VISIBLE AT REST (a theme-aware resting background), while
 *     the stronger hover/drag and focus-visible affordances are retained;
 *   - Durable Conversation message cards (`.transcript-message`) carry
 *     SYMMETRIC same-color side accents: the colored left accent is mirrored
 *     on the right edge for steward (`--accent`) and agent (`--ok`) cards,
 *     without broadening to unrelated warning/evidence/system cards.
 *
 * Static pins read `web/src/styles.css` directly (the authoritative source);
 * the system-Chrome probe renders the BUILT stylesheet and checks computed
 * styles, so resting visibility and side symmetry hold after the build step.
 * Geometry, not screenshots.
 */

const webSrc = join(process.cwd(), "web", "src");

describe("WUX-D static presentation contract", () => {
  it("the split resizer has a visible theme-aware resting background while hover/drag and focus affordances stay stronger", async () => {
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    // Resting visibility: the BASE .split-resizer rule itself paints a
    // non-transparent background (previously invisible at rest).
    const baseRule = styles.match(/\.split-resizer\s*\{[^}]*\}/);
    expect(baseRule).not.toBeNull();
    expect(baseRule?.[0]).toMatch(/background:\s*color-mix\(/);
    // Stronger interactive affordances retained on top of the resting paint.
    const hoverRule = styles.match(/\.split-resizer:hover\s*\{[^}]*\}/);
    expect(hoverRule).not.toBeNull();
    expect(hoverRule?.[0]).toMatch(/background:\s*var\(--accent/);
    const activeRule = styles.match(/\.split-resizer:active\s*\{[^}]*\}/);
    expect(activeRule).not.toBeNull();
    expect(activeRule?.[0]).toMatch(/background:\s*var\(--accent-strong/);
    const focusRule = styles.match(/\.split-resizer:focus-visible\s*\{[^}]*\}/);
    expect(focusRule).not.toBeNull();
    expect(focusRule?.[0]).toMatch(/outline:\s*2px solid var\(--accent/);
  });

  it("durable message cards mirror their left accent on the right edge with the SAME per-role color", async () => {
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    // The card frame carries a matching right border width.
    const cardRule = styles.match(/\.transcript-message\s*\{[^}]*\}/);
    expect(cardRule).not.toBeNull();
    expect(cardRule?.[0]).toMatch(/border-left-width:\s*3px/);
    expect(cardRule?.[0]).toMatch(/border-right-width:\s*3px/);
    // Steward cards: --accent on BOTH sides.
    const stewardRule = styles.match(/\.transcript-steward\s*\{[^}]*\}/);
    expect(stewardRule).not.toBeNull();
    expect(stewardRule?.[0]).toMatch(/border-left-color:\s*var\(--accent\)/);
    expect(stewardRule?.[0]).toMatch(/border-right-color:\s*var\(--accent\)/);
    // Agent cards: --ok on BOTH sides.
    const agentRule = styles.match(/\.transcript-agent\s*\{[^}]*\}/);
    expect(agentRule).not.toBeNull();
    expect(agentRule?.[0]).toMatch(/border-left-color:\s*var\(--ok\)/);
    expect(agentRule?.[0]).toMatch(/border-right-color:\s*var\(--ok\)/);
  });
});

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

/** Minimal desktop split-view fixture with durable message cards in the chat pane. */
const FIXTURE = (cssUrl: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>WUX-D edge affordance probe</title>
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
            <ol class="vault-explorer-entries" id="entries" style="overflow-y:auto;height:100%;list-style:none;margin:0;padding:12px">
              <li style="height:320px;background:#f4f4f4">file-row-1</li>
              <li style="height:320px;background:#eef">file-row-2</li>
            </ol>
          </section>
          <div class="split-mobile-toggle" role="group" aria-label="Companion view toggle">
            <button type="button" aria-pressed="true">Chat</button>
            <button type="button" aria-pressed="false">Vault Explorer</button>
          </div>
          <div class="split-resizer-host">
            <div class="split-resizer" role="separator" aria-orientation="horizontal" tabindex="0"
                 aria-valuemin="280" aria-valuenow="400"
                 aria-label="Resize chat pane" id="resizer"></div>
          </div>
          <section class="split-chat-pane" aria-label="Chat" id="chatpane" style="flex-basis:400px">
            <section class="conversation-surface">
              <div class="conversation-workspace">
                <div class="conversation-history" role="region" aria-label="Conversation history" tabindex="0" id="history">
                  <ol class="transcript-list">
                    <li class="transcript-row transcript-message transcript-steward" id="steward-card">steward</li>
                    <li class="transcript-row transcript-message transcript-agent" id="agent-card">agent</li>
                  </ol>
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

interface EdgeStyles {
  background: string;
}

async function edgeStylesOf(page: Page, selector: string): Promise<EdgeStyles> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (el === null) throw new Error(`missing ${sel}`);
    const cs = getComputedStyle(el);
    return { background: cs.backgroundColor };
  }, selector);
}

interface CardEdges {
  leftWidth: string;
  rightWidth: string;
  leftColor: string;
  rightColor: string;
}

async function cardEdges(page: Page, selector: string): Promise<CardEdges> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (el === null) throw new Error(`missing ${sel}`);
    const cs = getComputedStyle(el);
    return { leftWidth: cs.borderLeftWidth, rightWidth: cs.borderRightWidth, leftColor: cs.borderLeftColor, rightColor: cs.borderRightColor };
  }, selector);
}

const probe = describe.skipIf(chromePath === null || builtCssPath() === null)(
  "WUX-D real-browser rendered edge-affordance probe (system Chrome, no screenshot guessing)",
  () => {
    let browser: Browser;
    let page: Page;

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
      const fixturePath = join(mkdtempSync(join(tmpdir(), "wux-d-edges-")), "index.html");
      writeFileSync(fixturePath, FIXTURE(`file://${cssPath}`));
      await page.goto(`file://${fixturePath}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }, 60_000);

    it("at rest the resizer renders an opaque visible background (never fully transparent)", async () => {
      const resizer = await edgeStylesOf(page, "#resizer");
      // Chrome may serialize a resolved color-mix() as rgb(), color(srgb …),
      // oklab(), etc. Any fully-transparent serialization is invisible;
      // anything else paints.
      const transparent = /^(?:rgba?\(\s*0(?:px)?\s*,\s*0\s*,\s*0\s*,\s*0\s*\)|transparent|none)$/i.test(resizer.background.trim())
        || /\/\s*0\s*\)$/.test(resizer.background.trim());
      expect(transparent).toBe(false);
    });

    it("durable message cards render SYMMETRIC borders with the same per-role accent color on both edges", async () => {
      for (const selector of ["#steward-card", "#agent-card"]) {
        const edges = await cardEdges(page, selector);
        expect(edges.leftWidth).toBe("3px");
        expect(edges.rightWidth).toBe("3px");
        expect(edges.rightColor).toBe(edges.leftColor);
        // The mirrored edge must be painted, not transparent.
        expect(edges.leftColor).not.toMatch(/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/);
      }
    });
  },
);
