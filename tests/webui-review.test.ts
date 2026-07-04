import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const publicDir = join(process.cwd(), "public");

async function readPublic(name: string): Promise<string> {
  return readFile(join(publicDir, name), "utf8");
}

describe("WebUI review affordances", () => {
  it("places the model badge below the agent selector with context percentage but no thinking level", async () => {
    const html = await readPublic("index.html");
    const app = await readPublic("app.js");
    expect(html).toMatch(/<select id="agent-select"><\/select>[\s\S]*?<div id="context-indicator"/);
    expect(app).not.toContain('messageCount + " msgs"');
    expect(app).not.toContain('think:" + st.thinkingLevel');
    expect(app).toContain('context-model-line');
    expect(app).toContain('formatContextUsage');
    expect(app).toContain('"ctx " + total + " (" + pct + "% used)"');
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

  it("opens side panels as equal-width resizable panels that stretch the chat", async () => {
    const app = await readPublic("app.js");
    const css = await readPublic("style.css");
    expect(app).toContain('document.getElementById("app").classList.add("vault-open")');
    expect(css).toMatch(/#app\.vault-open\s+#main/);
    const panelBlock = css.match(/\.panel\s*{[\s\S]*?}/)?.[0] || "";
    expect(panelBlock).not.toContain("position: fixed");
    expect(panelBlock).toContain("resize: horizontal");
    expect(css).toContain(".graph-panel { width: min(480px, 42vw); }");
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

  it("adds a new conversation button that clears the chat through the backend", async () => {
    const html = await readPublic("index.html");
    const app = await readPublic("app.js");
    expect(html).toContain('id="new-conversation-btn"');
    expect(app).toContain("startNewConversation");
    expect(app).toContain('apiJson("/api/chat/new"');
    expect(app).toContain('New conversation started.');
  });

  it("adds a minimal read-only knowledge graph surface that opens graph nodes in the vault browser", async () => {
    const html = await readPublic("index.html");
    const app = await readPublic("app.js");
    const css = await readPublic("style.css");

    expect(html).toContain('id="vault-tab-graph"');
    expect(html).toContain('id="vault-graph"');
    expect(html).toContain('id="graph-canvas"');
    expect(html).toContain("No OKF typed documents found.");
    expect(app).toContain('apiJson("/api/vault/graph"');
    expect(app).toContain("renderKnowledgeGraph");
    expect(app).toContain("openVaultFile(node.path)");
    expect(app).toContain('renderMessageMarkdown');
    expect(app).toContain('finalizeAssistantMessage');
    expect(css).toContain(".graph-node");
    expect(css).toContain(".graph-edge");
    expect(css).toContain(".message-assistant.markdown-body");
  });

  it("consolidates the vault browser and knowledge graph into one Vault Explorer with Files/Graph tabs", async () => {
    const html = await readPublic("index.html");
    const app = await readPublic("app.js");

    // One "Vault Explorer" button in the sidebar; the two old buttons are gone.
    expect(html).toContain('id="vault-explorer-btn"');
    expect(html).toContain(">Vault Explorer<");
    expect(html).not.toContain('id="vault-browser-btn"');
    expect(html).not.toContain('id="knowledge-graph-btn"');

    // One panel with a tab bar and two panes; old separate panels are gone.
    expect(html).toContain('id="vault-explorer"');
    expect(html).toContain('id="vault-tab-files"');
    expect(html).toContain('id="vault-tab-graph"');
    expect(html).toContain('id="vault-files"');
    expect(html).toContain('id="vault-graph"');
    expect(html).not.toContain('id="vault-panel"');
    expect(html).not.toContain('id="graph-panel"');

    // app.js exposes a tab selector helper and the consolidated opener.
    expect(app).toContain("selectVaultTab");
    expect(app).toContain("openVaultExplorer");
    expect(app).not.toContain("function openVaultBrowser");
    expect(app).not.toContain("function openKnowledgeGraph");
  });
});
