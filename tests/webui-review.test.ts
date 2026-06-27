import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const publicDir = join(process.cwd(), "public");

async function readPublic(name: string): Promise<string> {
  return readFile(join(publicDir, name), "utf8");
}

describe("WebUI review affordances", () => {
  it("places the model badge directly below the agent selector and removes message count from it", async () => {
    const html = await readPublic("index.html");
    const app = await readPublic("app.js");
    expect(html).toMatch(/<select id="agent-select"><\/select>[\s\S]*?<div id="context-indicator"/);
    expect(app).not.toContain('messageCount + " msgs"');
    expect(app).toContain('context-model-line');
  });

  it("uses an in-page modal for inbox task creation instead of browser prompt popups", async () => {
    const html = await readPublic("index.html");
    const app = await readPublic("app.js");
    expect(html).toContain('id="inbox-modal"');
    expect(html).toContain('id="inbox-title-input"');
    expect(html).toContain('id="inbox-body-input"');
    expect(app).not.toContain("window.prompt");
    expect(app).toContain("openInboxModal");
  });

  it("opens the vault browser as a layout panel that resizes chat instead of covering it", async () => {
    const app = await readPublic("app.js");
    const css = await readPublic("style.css");
    expect(app).toContain('document.getElementById("app").classList.add("vault-open")');
    expect(css).toMatch(/#app\.vault-open\s+#main/);
    const panelBlock = css.match(/\.panel\s*{[\s\S]*?}/)?.[0] || "";
    expect(panelBlock).not.toContain("position: fixed");
  });

  it("makes past sessions clickable with an active visual indicator", async () => {
    const app = await readPublic("app.js");
    const css = await readPublic("style.css");
    expect(app).toContain("resumeSession(session.path)");
    expect(app).toContain("state.activeSessionPath");
    expect(css).toContain(".session-entry.active");
  });

  it("adds a steward notification badge and modal that opens alert files in the vault browser", async () => {
    const html = await readPublic("index.html");
    const app = await readPublic("app.js");
    expect(html).toContain('id="notifications-btn"');
    expect(html).toContain('id="notifications-badge"');
    expect(html).toContain('id="notifications-modal"');
    expect(app).toContain("loadNotifications");
    expect(app).toContain("steward-inbox/alerts");
    expect(app).toContain("openVaultFile(alert.path)");
  });
});
