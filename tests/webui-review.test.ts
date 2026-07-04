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
    expect(html).toContain("knowledge graph nodes");
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

  it("orders sidebar sections by authority scope with New Conversation above Past Sessions", async () => {
    const html = await readPublic("index.html");
    // Assert the sidebar sections appear in scope order:
    // logo -> steward controls -> agent -> vault explorer -> new conversation -> sessions
    expect(html).toMatch(
      /class="sidebar-header"[\s\S]*?id="notifications-btn"[\s\S]*?id="inbox-create-btn"[\s\S]*?id="agent-select"[\s\S]*?id="vault-explorer-btn"[\s\S]*?id="new-conversation-btn"[\s\S]*?sidebar-sessions/
    );
  });

  it("provides steward-facing graph empty/partial-state copy without tool syntax", async () => {
    const html = await readPublic("index.html");
    const app = await readPublic("app.js");

    // The default #graph-empty text must NOT lead with "wiki_update_concept"
    expect(html).toContain('id="graph-empty"');
    const emptyMatch = html.match(/id="graph-empty"[^>]*>([^<]*)</);
    expect(emptyMatch).not.toBeNull();
    const emptyText = emptyMatch![1] || "";
    expect(emptyText).not.toContain("wiki_update_concept");
    // Must contain steward-facing words
    expect(emptyText).toContain("knowledge");
    expect(emptyText).toContain("concept");

    // app.js must not contain "wiki_update_concept" (tool syntax not leaked anywhere)
    expect(app).not.toContain("wiki_update_concept");

    // A separate partial-state branch exists: #graph-partial element in HTML
    expect(html).toContain('id="graph-partial"');
    // JS references it with a nodes.length check
    expect(app).toContain('graph-partial');
    expect(app).toMatch(/nodes\.length\s*>\s*0/);
  });

  it("adds a full-height draggable divider between chat and Vault Explorer", async () => {
    const html = await readPublic("index.html");
    const css = await readPublic("style.css");
    const app = await readPublic("app.js");

    // A dedicated divider element sits between #main and #vault-explorer.
    expect(html).toContain('id="vault-divider"');
    expect(html).toMatch(/<\/main>[\s\S]*?<div id="vault-divider"[\s\S]*?<div id="vault-explorer"/);
    // CSS owns the divider look and exposes a --vault-width CSS variable.
    expect(css).toContain("#vault-divider");
    expect(css).toContain("--vault-width");
    // The frontend wires a Pointer Events drag handler that updates the vault width.
    // Pointer Events are the sole drag mechanism; there is no legacy mousemove fallback.
    expect(app).toContain("vault-divider");
    expect(app).toContain("pointerdown");
    expect(app).not.toMatch(/document\.addEventListener\("mousemove"/);
    expect(app).not.toMatch(/document\.addEventListener\("mouseup"/);
  });

  it("switches to the Files tab when a graph node is clicked", async () => {
    const app = await readPublic("app.js");
    // The graph-node click handler must switch to the Files tab before opening the file.
    expect(app).toContain('selectVaultTab("files")');
    // Both calls must appear in the same line or adjacent lines within the handler.
    const clickHandler = app.match(
      /addEventListener\("click".*selectVaultTab\("files"\).*openVaultFile\(node\.path\)/s
    );
    expect(clickHandler).not.toBeNull();
    // The keydown handler must also switch tabs.
    const keydownHandler = app.match(
      /addEventListener\("keydown".*selectVaultTab\("files"\).*openVaultFile\(node\.path\)/s
    );
    expect(keydownHandler).not.toBeNull();
  });
});
