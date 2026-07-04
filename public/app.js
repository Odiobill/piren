"use strict";

// Piren Gateway frontend. Vanilla JS, no framework, no build step.
// Intentionally minimal per ADR-0012: agent selection, chat, steering,
// approval gates, vault browser, and a read-only context indicator.
// No model or thinking controls: those belong in team/<agent>/config.yml.

const state = {
  token: null,
  authRequired: false,
  agents: [],
  currentAgent: null,
  currentStreamId: null,
  currentAssistantEl: null,
  pendingApproval: null,
  vaultPath: ".",
  activeSessionPath: null,
  notifications: [],
};

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function authHeaders() {
  const headers = { "content-type": "application/json" };
  if (state.token) {
    headers["authorization"] = "Bearer " + state.token;
  }
  return headers;
}

async function apiFetch(path, options) {
  return fetch(path, {
    ...options,
    headers: { ...authHeaders(), ...(options?.headers || {}) },
  });
}

async function apiJson(path, options) {
  const res = await apiFetch(path, options);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function checkAuth() {
  try {
    const info = await apiJson("/api/auth/info");
    state.authRequired = info.authRequired;
    if (!info.authRequired) {
      showApp();
      await initApp();
    } else if (state.token) {
      showApp();
      await initApp();
    } else {
      showAuthOverlay();
    }
  } catch (err) {
    document.getElementById("auth-error").textContent = "Cannot reach gateway: " + err.message;
    showAuthOverlay();
  }
}

function showAuthOverlay() {
  document.getElementById("auth-overlay").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
  document.getElementById("auth-token-input").focus();
}

function showApp() {
  document.getElementById("auth-overlay").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
}

async function submitAuth() {
  const input = document.getElementById("auth-token-input");
  const token = input.value.trim();
  if (!token) return;
  state.token = token;
  try {
    await apiJson("/api/chat/state");
    showApp();
    await initApp();
    document.getElementById("auth-error").textContent = "";
  } catch {
    state.token = null;
    document.getElementById("auth-error").textContent = "Invalid token";
  }
}

// ---------------------------------------------------------------------------
// App initialization
// ---------------------------------------------------------------------------

async function initApp() {
  await Promise.all([
    loadState(),
    loadAgents(),
  ]);
  await loadTranscript();
  await loadSessions();
  await loadNotifications();
}

async function loadState() {
  try {
    const st = await apiJson("/api/chat/state");
    updateContextIndicator(st);
  } catch (err) {
    document.getElementById("context-model-line").textContent = "Error";
    document.getElementById("context-detail-line").textContent = err.message;
  }
}

function updateContextIndicator(st) {
  const model = st.model && st.model.id ? st.model.id : "Connected";
  const badges = [];
  if (st.isStreaming) badges.push("streaming");
  const contextUsage = formatContextUsage(st);
  if (contextUsage) badges.push(contextUsage);
  document.getElementById("context-model-line").textContent = model;
  document.getElementById("context-detail-line").textContent = badges.join(" | ");
}

function getContextWindow(st) {
  return st.contextWindow || st.contextWindowTokens || st.maxContextTokens || (st.model && st.model.contextWindow);
}

function getContextUsed(st) {
  return st.contextUsed || st.contextUsedTokens || st.usedTokens || st.inputTokens;
}

function formatContextUsage(st) {
  const total = getContextWindow(st);
  if (!total) return "";
  const used = getContextUsed(st);
  if (!used) return "ctx " + total;
  const pct = Math.round((Number(used) / Number(total)) * 100);
  return "ctx " + total + " (" + pct + "% used)";
}

async function loadAgents() {
  try {
    const data = await apiJson("/api/chat/agents");
    state.agents = data.agents || [];
    state.currentAgent = data.current;
    const select = document.getElementById("agent-select");
    select.innerHTML = "";
    for (const agent of state.agents) {
      const opt = document.createElement("option");
      opt.value = agent;
      opt.textContent = agent;
      if (agent === state.currentAgent) opt.selected = true;
      select.appendChild(opt);
    }
  } catch (err) {
    console.error("Failed to load agents:", err);
  }
}

// ---------------------------------------------------------------------------
// Transcript and sessions (reconnect + resume)
// ---------------------------------------------------------------------------

/**
 * Repopulate the chat view from the current Pi session transcript. Called on
 * init so a browser refresh reattaches to prior context. Message shapes are
 * provider-specific, so the text is extracted defensively.
 */
async function loadTranscript() {
  try {
    const data = await apiJson("/api/chat/messages");
    const messages = data.messages || [];
    if (messages.length === 0) return;
    const container = document.getElementById("messages");
    container.innerHTML = "";
    for (const msg of messages) {
      const role = msg.role || "assistant";
      const text = extractMessageText(msg);
      if (text) addMessage(role === "user" ? "user" : "assistant", text);
    }
    scrollMessages();
  } catch (err) {
    // Transcript load is best-effort: a fresh session has no messages yet.
    console.warn("Failed to load transcript:", err.message);
  }
}

function extractMessageText(msg) {
  if (typeof msg === "string") return msg;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .filter(Boolean)
      .join("");
  }
  if (typeof msg.text === "string") return msg.text;
  return "";
}

/**
 * Load past session summaries for the current agent from the vault. Populates
 * the sidebar session list so the steward can browse prior conversations.
 */
async function loadSessions() {
  const list = document.getElementById("session-list");
  if (!list) return;
  try {
    const data = await apiJson("/api/chat/sessions");
    list.innerHTML = "";
    const sessions = data.sessions || [];
    if (sessions.length === 0) {
      list.innerHTML = '<div class="session-empty">No past sessions</div>';
      return;
    }
    for (const session of sessions) {
      const div = document.createElement("div");
      div.className = "session-entry";
      if (session.path === state.activeSessionPath) div.classList.add("active");
      div.title = "Resume this session";
      div.onclick = () => resumeSession(session.path);
      const titleEl = document.createElement("div");
      titleEl.className = "session-title";
      titleEl.textContent = session.title || session.name;
      div.appendChild(titleEl);
      if (session.created) {
        const dateEl = document.createElement("div");
        dateEl.className = "session-date";
        dateEl.textContent = formatSessionDate(session.created);
        div.appendChild(dateEl);
      }
      list.appendChild(div);
    }
  } catch (err) {
    // Sessions route requires a vaultRoot; absence is not fatal.
    list.innerHTML = '<div class="session-empty">Sessions unavailable</div>';
  }
}

async function resumeSession(sessionPath) {
  if (!sessionPath) return;
  try {
    const result = await apiJson("/api/chat/resume", {
      method: "POST",
      body: JSON.stringify({ sessionPath }),
    });
    if (result.cancelled) {
      addMessage("tool", "Session resume cancelled.");
      return;
    }
    state.activeSessionPath = sessionPath;
    await loadTranscript();
    await loadState();
    await loadSessions();
    addMessage("tool", "Resumed session: " + sessionPath);
  } catch (err) {
    addMessage("error", "Session resume failed: " + err.message);
  }
}

function formatSessionDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = "message message-" + role;
  if (role === "assistant") {
    div.classList.add("markdown-body");
    div.dataset.rawText = text;
    div.innerHTML = renderMessageMarkdown(text);
  } else {
    div.textContent = text;
  }
  document.getElementById("messages").appendChild(div);
  scrollMessages();
  return div;
}

function renderMessageMarkdown(text) {
  return renderMarkdown(text || "");
}

function finalizeAssistantMessage(div) {
  if (!div) return;
  div.innerHTML = renderMessageMarkdown(div.dataset.rawText || div.textContent || "");
}

function scrollMessages() {
  const msgs = document.getElementById("messages");
  msgs.scrollTop = msgs.scrollHeight;
}

async function sendMessage(mode) {
  const input = document.getElementById("message-input");
  const message = input.value.trim();
  if (!message) return;

  if (mode !== "steer" && mode !== "follow_up") {
    addMessage("user", message);
  }

  input.value = "";
  input.style.height = "auto";

  const body = { message };
  if (mode) body.mode = mode;

  try {
    const data = await apiJson("/api/chat/start", {
      method: "POST",
      body: JSON.stringify(body),
    });
    state.currentStreamId = data.stream_id;
    drainStream(data.stream_id);
  } catch (err) {
    addMessage("error", err.message);
  }
}

/**
 * Abort the active turn. The abort RPC command emits agent_end, which drains
 * the current SSE stream so it closes cleanly. The outcome is observed on the
 * existing stream (no separate abort stream).
 */
async function abortTurn() {
  try {
    await apiJson("/api/chat/abort", { method: "POST" });
  } catch (err) {
    addMessage("error", "Abort failed: " + err.message);
  }
}

async function drainStream(streamId) {
  const headers = {};
  if (state.token) headers["authorization"] = "Bearer " + state.token;

  try {
    const res = await fetch(`/api/chat/stream?stream_id=${streamId}`, { headers });
    if (!res.ok) {
      addMessage("error", `Stream error: ${res.status}`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleSseBlock(block);
      }
    }
    if (buffer.trim()) handleSseBlock(buffer);
  } catch (err) {
    addMessage("error", "Stream failed: " + err.message);
  }
}

function handleSseBlock(block) {
  if (!block.trim() || block.startsWith(":")) return;

  let eventType = "";
  let dataStr = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) eventType = line.slice(7);
    else if (line.startsWith("data: ")) dataStr = line.slice(6);
  }

  if (!eventType || !dataStr) return;

  let data;
  try {
    data = JSON.parse(dataStr);
  } catch {
    return;
  }

  switch (eventType) {
    case "token":
      handleToken(data);
      break;
    case "tool":
      handleTool(data);
      break;
    case "done":
      handleDone(data);
      break;
    case "error":
      addMessage("error", data.message || "Unknown error");
      state.currentStreamId = null;
      break;
    case "queue":
      handleQueue(data);
      break;
    case "approval":
      handleApproval(data);
      break;
    case "model_changed":
    case "thinking_changed":
      loadState();
      break;
  }
}

function handleToken(data) {
  if (!state.currentAssistantEl) {
    state.currentAssistantEl = addMessage("assistant", "");
  }
  const nextText = (state.currentAssistantEl.dataset.rawText || "") + (data.text || "");
  state.currentAssistantEl.dataset.rawText = nextText;
  state.currentAssistantEl.textContent = nextText;
  scrollMessages();
}

function handleTool(data) {
  if (data.phase === "start") {
    const div = addMessage("tool", "");
    const nameSpan = document.createElement("span");
    nameSpan.className = "tool-name";
    nameSpan.textContent = "[tool] " + (data.name || "unknown");
    div.appendChild(nameSpan);
    if (data.args) {
      const argsDiv = document.createElement("div");
      argsDiv.textContent = "  args: " + (typeof data.args === "string" ? data.args : JSON.stringify(data.args));
      div.appendChild(argsDiv);
    }
  } else if (data.phase === "end") {
    addMessage("tool", "  -> " + (data.isError ? "error" : "done"));
  }
}

function handleDone() {
  finalizeAssistantMessage(state.currentAssistantEl);
  state.currentAssistantEl = null;
  state.currentStreamId = null;
  hideQueue();
}

function handleQueue(data) {
  const indicator = document.getElementById("queue-indicator");
  const text = document.getElementById("queue-text");
  const parts = [];
  if (data.steering && data.steering.length > 0) {
    parts.push("Steering: " + data.steering.join("; "));
  }
  if (data.followUp && data.followUp.length > 0) {
    parts.push("Follow-up: " + data.followUp.join("; "));
  }
  if (parts.length > 0) {
    text.textContent = parts.join(" | ");
    indicator.classList.remove("hidden");
  } else {
    hideQueue();
  }
}

function hideQueue() {
  document.getElementById("queue-indicator").classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Approval gates
// ---------------------------------------------------------------------------

function handleApproval(data) {
  state.pendingApproval = data;
  const panel = document.getElementById("approval-panel");
  const title = document.getElementById("approval-title");
  const message = document.getElementById("approval-message");
  const inputGroup = document.getElementById("approval-input-group");

  title.textContent = data.title || "Approval Required";
  message.textContent = "";

  if (data.method === "input" || data.method === "select") {
    inputGroup.classList.remove("hidden");
    const input = document.getElementById("approval-input");
    input.value = "";
    input.placeholder = data.method === "select" ? "Enter choice" : "Enter value";
    input.focus();
  } else {
    inputGroup.classList.add("hidden");
  }

  if (data.message) {
    message.textContent = data.message;
  }

  panel.classList.remove("hidden");
  scrollMessages();
}

async function submitApproval(confirmed) {
  if (!state.pendingApproval) return;
  const id = state.pendingApproval.id;
  const panel = document.getElementById("approval-panel");
  const body = { id };

  if (confirmed) {
    if (state.pendingApproval.method === "input" || state.pendingApproval.method === "select") {
      body.value = document.getElementById("approval-input").value;
    } else {
      body.confirmed = true;
    }
  } else {
    body.cancelled = true;
  }

  try {
    await apiJson("/api/chat/approve", {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (err) {
    addMessage("error", "Approval failed: " + err.message);
  }

  panel.classList.add("hidden");
  state.pendingApproval = null;
}

// ---------------------------------------------------------------------------
// Agent switching
// ---------------------------------------------------------------------------

async function switchAgent() {
  const agent = document.getElementById("agent-select").value;
  if (!agent || agent === state.currentAgent) return;
  try {
    await apiJson("/api/chat/switch", {
      method: "POST",
      body: JSON.stringify({ agent }),
    });
    state.currentAgent = agent;
    await initApp();
  } catch (err) {
    addMessage("error", "Agent switch failed: " + err.message);
    loadAgents();
  }
}

async function startNewConversation() {
  try {
    await apiJson("/api/chat/new", { method: "POST" });
    state.activeSessionPath = null;
    state.currentAssistantEl = null;
    state.currentStreamId = null;
    document.getElementById("messages").innerHTML = "";
    addMessage("tool", "New conversation started.");
    await loadState();
    await loadSessions();
  } catch (err) {
    addMessage("error", "New conversation failed: " + err.message);
  }
}

// ---------------------------------------------------------------------------
// Vault Explorer (Files + Graph tabs)
// ---------------------------------------------------------------------------

const VAULT_TABS = ["files", "graph"];

function selectVaultTab(tab) {
  if (!VAULT_TABS.includes(tab)) return;
  const panel = document.getElementById("vault-explorer");
  if (!panel) return;
  document.getElementById("vault-tab-files").classList.toggle("active", tab === "files");
  document.getElementById("vault-tab-graph").classList.toggle("active", tab === "graph");
  document.getElementById("vault-files").classList.toggle("hidden", tab !== "files");
  document.getElementById("vault-graph").classList.toggle("hidden", tab !== "graph");
}

async function openVaultExplorer(tab) {
  const panel = document.getElementById("vault-explorer");
  // Toggle: if already open on the requested tab, close instead of re-opening.
  if (!panel.classList.contains("hidden") &&
      document.getElementById("vault-tab-" + tab)?.classList.contains("active")) {
    closeVaultExplorer();
    return;
  }
  panel.classList.remove("hidden");
  document.getElementById("app").classList.add("vault-open");
  if (state.vaultWidth) applyVaultWidth(state.vaultWidth);
  selectVaultTab(tab);
  if (tab === "files") {
    state.vaultPath = ".";
    await browseVault(".");
  } else if (tab === "graph") {
    await loadKnowledgeGraph();
  }
}

function closeVaultExplorer() {
  const panel = document.getElementById("vault-explorer");
  if (!panel) return;
  panel.classList.add("hidden");
  document.getElementById("app").classList.remove("vault-open");
  document.getElementById("vault-content").classList.add("hidden");
}

async function browseVault(path) {
  state.vaultPath = path;
  document.getElementById("vault-content").classList.add("hidden");
  const breadcrumb = document.getElementById("vault-breadcrumb");
  breadcrumb.innerHTML = "";
  const backBtn = document.createElement("span");
  backBtn.className = "vault-back";
  backBtn.textContent = "\u2190 /";
  backBtn.onclick = () => browseVault(".");
  breadcrumb.appendChild(backBtn);
  if (path !== ".") {
    const pathSpan = document.createElement("span");
    pathSpan.textContent = " / " + path;
    breadcrumb.appendChild(pathSpan);
  }

  try {
    const data = await apiJson("/api/vault/list?path=" + encodeURIComponent(path));
    const list = document.getElementById("vault-list");
    list.innerHTML = "";

    if (path !== ".") {
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
      const parentEntry = document.createElement("div");
      parentEntry.className = "vault-entry";
      parentEntry.innerHTML = '<span class="entry-icon entry-dir">\ud83d\udcc1</span><span class="entry-dir">..</span>';
      parentEntry.onclick = () => browseVault(parent);
      list.appendChild(parentEntry);
    }

    for (const entry of data.entries || []) {
      const div = document.createElement("div");
      div.className = "vault-entry";
      const isDir = entry.type === "directory";
      const icon = isDir ? "\ud83d\udcc1" : "\ud83d\udcc4";
      const cls = isDir ? "entry-dir" : "entry-file";
      div.innerHTML = '<span class="entry-icon ' + cls + '">' + icon + "</span><span class=\"" + cls + "\">" + entry.name + "</span>";
      if (isDir) {
        const childPath = path === "." ? entry.name : path + "/" + entry.name;
        div.onclick = () => browseVault(childPath);
      } else {
        div.onclick = () => readVaultFile(path === "." ? entry.name : path + "/" + entry.name);
      }
      list.appendChild(div);
    }
  } catch (err) {
    document.getElementById("vault-list").innerHTML = '<div class="error-text">' + err.message + "</div>";
  }
}

async function openVaultFile(path) {
  const panel = document.getElementById("vault-explorer");
  panel.classList.remove("hidden");
  document.getElementById("app").classList.add("vault-open");
  selectVaultTab("files");
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
  state.vaultPath = parent;
  await readVaultFile(path);
}

async function readVaultFile(path) {
  try {
    const data = await apiJson("/api/vault/read?path=" + encodeURIComponent(path));
    const content = data.content || "";
    const pre = document.getElementById("vault-content-pre");
    const rendered = document.getElementById("vault-content-rendered");
    const toggle = document.getElementById("vault-view-toggle");

    pre.textContent = content;

    // Render Markdown for .md/.markdown files; show a toggle. Other files
    // stay raw-only (frontmatter-heavy YAML, JSON, etc. render poorly).
    const isMarkdown = /\.(md|markdown)$/i.test(path);
    if (isMarkdown) {
      rendered.innerHTML = renderMarkdown(stripFrontmatter(content));
      toggle.classList.remove("hidden");
      setVaultView("rendered");
    } else {
      rendered.innerHTML = "";
      toggle.classList.add("hidden");
      pre.classList.remove("hidden");
      rendered.classList.add("hidden");
    }

    document.getElementById("vault-content").classList.remove("hidden");

    const breadcrumb = document.getElementById("vault-breadcrumb");
    breadcrumb.innerHTML = "";
    const backBtn = document.createElement("span");
    backBtn.className = "vault-back";
    backBtn.textContent = "\u2190 back to " + state.vaultPath;
    backBtn.onclick = () => browseVault(state.vaultPath);
    breadcrumb.appendChild(backBtn);
  } catch (err) {
    document.getElementById("vault-content-pre").textContent = "Error: " + err.message;
    document.getElementById("vault-content-rendered").innerHTML = "";
    document.getElementById("vault-view-toggle").classList.add("hidden");
    document.getElementById("vault-content").classList.remove("hidden");
  }
}

/**
 * Switch the vault content area between rendered Markdown and raw source.
 */
function setVaultView(view) {
  const pre = document.getElementById("vault-content-pre");
  const rendered = document.getElementById("vault-content-rendered");
  const btnRendered = document.getElementById("vault-view-rendered");
  const btnRaw = document.getElementById("vault-view-raw");
  if (view === "rendered") {
    pre.classList.add("hidden");
    rendered.classList.remove("hidden");
    btnRendered.classList.add("active");
    btnRaw.classList.remove("active");
  } else {
    pre.classList.remove("hidden");
    rendered.classList.add("hidden");
    btnRendered.classList.remove("active");
    btnRaw.classList.add("active");
  }
}

/**
 * Remove a leading YAML frontmatter block for human-friendly rendering. The
 * raw "Source" view preserves it. Returns the body after the closing ---.
 */
function stripFrontmatter(content) {
  const match = content.match(/^---\n[\s\S]*?\n---\n/);
  return match ? content.slice(match[0].length) : content;
}

/**
 * Minimal, dependency-free Markdown renderer. Handles headings, bold, italic,
 * inline code, fenced code blocks, unordered/ordered lists, blockquotes,
 * horizontal rules, links, and paragraphs.
 *
 * XSS safety: structural detection runs on the RAW text (so markers like `>`
 * for blockquotes are not pre-escaped), but every fragment that becomes HTML
 * text is escaped via escapeHtml() either inside inline() or explicitly for
 * code blocks. Inline formatting (bold/italic/links) is applied AFTER
 * escaping, so markers in file content can never inject HTML.
 */
function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let inUl = false;
  let inOl = false;

  function closeLists() {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  }

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      closeLists();
      const lang = (fence[1] || "").replace(/[^a-z0-9-]/gi, "");
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      out.push('<pre><code class="lang-' + lang + '">' + escapeHtml(code.join("\n")) + "</code></pre>");
      continue;
    }

    // Blank line
    if (/^\s*$/.test(line)) {
      closeLists();
      i++;
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeLists();
      const level = heading[1].length;
      out.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">");
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\1\1[-*_\s]*$/.test(line)) {
      closeLists();
      out.push("<hr>");
      i++;
      continue;
    }

    // Blockquote
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      closeLists();
      const block = [quote[1]];
      i++;
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        block.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push("<blockquote>" + inline(block.join(" ")) + "</blockquote>");
      continue;
    }

    // Ordered list item
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (!inOl) { out.push("<ol>"); inOl = true; }
      out.push("<li>" + inline(ol[1]) + "</li>");
      i++;
      continue;
    }

    // Unordered list item
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (inOl) { out.push("</ol>"); inOl = false; }
      if (!inUl) { out.push("<ul>"); inUl = true; }
      out.push("<li>" + inline(ul[1]) + "</li>");
      i++;
      continue;
    }

    // Paragraph (collect consecutive non-blank, non-special lines)
    closeLists();
    const para = [line];
    i++;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*\d+\.\s/.test(lines[i]) &&
      !/^\s*[-*+]\s/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push("<p>" + inline(para.join(" ")) + "</p>");
  }
  closeLists();
  return out.join("\n");

  // Inline formatting: escape first, then apply code stash, links, bold,
  // italic. Applied AFTER escaping so the markers in file content cannot
  // inject HTML.
  function inline(text) {
    let s = escapeHtml(text);
    // Inline code first to protect its content from other substitutions.
    const codeStash = [];
    s = s.replace(/`([^`]+)`/g, (_m, code) => {
      codeStash.push(code);
      return "\u0000CODE" + (codeStash.length - 1) + "\u0000";
    });
    // Links [text](url) — url restricted to safe schemes to avoid javascript: URIs.
    s = s.replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_m, label, url) => {
        if (!/^(https?:|mailto:|#|\.\/|\.\.\/|\/)/i.test(url)) return label;
        return '<a href="' + url + '" target="_blank" rel="noopener">' + label + "</a>";
      },
    );
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
    // Restore inline code.
    s = s.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx) => "<code>" + codeStash[Number(idx)] + "</code>");
    return s;
  }
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function openInboxModal() {
  if (!state.currentAgent) {
    addMessage("error", "No agent selected.");
    return;
  }
  document.getElementById("inbox-modal-title").textContent = "Create Inbox Task for " + state.currentAgent;
  document.getElementById("inbox-title-input").value = "";
  document.getElementById("inbox-body-input").value = "";
  document.getElementById("inbox-modal-error").textContent = "";
  document.getElementById("inbox-modal").classList.remove("hidden");
  document.getElementById("inbox-title-input").focus();
}

function closeInboxModal() {
  document.getElementById("inbox-modal").classList.add("hidden");
}

async function submitInboxTask() {
  const title = document.getElementById("inbox-title-input").value.trim();
  const body = document.getElementById("inbox-body-input").value.trim();
  if (!title) {
    document.getElementById("inbox-modal-error").textContent = "Title is required.";
    return;
  }
  try {
    const result = await apiJson("/api/vault/inbox", {
      method: "POST",
      body: JSON.stringify({ to: state.currentAgent, title, body }),
    });
    closeInboxModal();
    addMessage("tool", "Created inbox task: " + result.path + " for " + state.currentAgent);
  } catch (err) {
    document.getElementById("inbox-modal-error").textContent = "Inbox task failed: " + err.message;
  }
}

async function loadNotifications() {
  try {
    const data = await apiJson("/api/vault/list?path=" + encodeURIComponent("steward-inbox/alerts"));
    const alerts = (data.entries || []).filter((entry) => entry.type === "file");
    state.notifications = alerts;
    updateNotificationsBadge(alerts.length);
  } catch {
    state.notifications = [];
    updateNotificationsBadge(0);
  }
}

function updateNotificationsBadge(count) {
  const badge = document.getElementById("notifications-badge");
  badge.textContent = String(count);
  badge.classList.toggle("hidden", count === 0);
}

function openNotificationsModal() {
  const modal = document.getElementById("notifications-modal");
  const list = document.getElementById("notifications-list");
  list.innerHTML = "";
  if (state.notifications.length === 0) {
    list.innerHTML = '<div class="session-empty">No steward alerts.</div>';
  } else {
    for (const alert of state.notifications) {
      const div = document.createElement("div");
      div.className = "notification-entry";
      div.textContent = alert.name;
      div.onclick = async () => {
        closeNotificationsModal();
        await openVaultFile(alert.path);
      };
      list.appendChild(div);
    }
  }
  modal.classList.remove("hidden");
}

function closeNotificationsModal() {
  document.getElementById("notifications-modal").classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Knowledge graph
// ---------------------------------------------------------------------------

async function loadKnowledgeGraph() {
  document.getElementById("graph-summary").textContent = "Loading graph...";
  document.getElementById("graph-empty").classList.add("hidden");
  try {
    const graph = await apiJson("/api/vault/graph");
    renderKnowledgeGraph(graph);
  } catch (err) {
    document.getElementById("graph-summary").textContent = "Graph unavailable: " + err.message;
    document.getElementById("graph-canvas").innerHTML = "";
  }
}

function renderKnowledgeGraph(graph) {
  const svg = document.getElementById("graph-canvas");
  const summary = document.getElementById("graph-summary");
  const empty = document.getElementById("graph-empty");
  const partial = document.getElementById("graph-partial");
  svg.innerHTML = "";

  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  empty.classList.add("hidden");
  if (partial) partial.classList.add("hidden");

  summary.textContent = nodes.length + " nodes, " + edges.length + " links" + (graph.truncated ? " (truncated)" : "");
  if (nodes.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  if (nodes.length > 0 && nodes.length <= 4 && partial) {
    partial.classList.remove("hidden");
  }

  const width = 420;
  const height = 360;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.max(80, Math.min(width, height) / 2 - 58);
  svg.setAttribute("viewBox", "0 0 " + width + " " + height);

  const positions = new Map();
  nodes.forEach((node, index) => {
    const angle = nodes.length === 1 ? -Math.PI / 2 : (Math.PI * 2 * index) / nodes.length - Math.PI / 2;
    positions.set(node.id, {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    });
  });

  for (const edge of edges) {
    const from = positions.get(edge.source);
    const to = positions.get(edge.target);
    if (!from || !to) continue;
    const line = svgEl("line");
    line.setAttribute("class", "graph-edge");
    line.setAttribute("x1", String(from.x));
    line.setAttribute("y1", String(from.y));
    line.setAttribute("x2", String(to.x));
    line.setAttribute("y2", String(to.y));
    svg.appendChild(line);
  }

  for (const node of nodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;
    const group = svgEl("g");
    group.setAttribute("class", "graph-node");
    group.setAttribute("tabindex", "0");
    group.setAttribute("role", "button");
    group.setAttribute("aria-label", "Open " + node.title);
    group.addEventListener("click", () => { selectVaultTab("files"); openVaultFile(node.path); });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { selectVaultTab("files"); openVaultFile(node.path); }
    });

    const circle = svgEl("circle");
    circle.setAttribute("cx", String(pos.x));
    circle.setAttribute("cy", String(pos.y));
    circle.setAttribute("r", node.type === "Entity" ? "18" : node.type === "Concept" ? "22" : "16");
    circle.setAttribute("class", node.type === "Entity" ? "graph-node-entity" : node.type === "Concept" ? "graph-node-concept" : "graph-node-document");
    group.appendChild(circle);

    const label = svgEl("text");
    label.setAttribute("x", String(pos.x));
    label.setAttribute("y", String(pos.y + 36));
    label.textContent = node.title;
    group.appendChild(label);
    svg.appendChild(group);
  }
}

function svgEl(name) {
  return document.createElementNS("http://www.w3.org/2000/svg", name);
}

// ---------------------------------------------------------------------------
// Vault Explorer divider (drag to resize chat vs. explorer)
// ---------------------------------------------------------------------------

/**
 * Clamp the Vault Explorer width to a sensible range so the chat area never
 * collapses and the explorer never escapes the viewport.
 */
function clampVaultWidth(px) {
  const max = Math.max(420, window.innerWidth - 580);
  return Math.min(max, Math.max(360, px));
}

/**
 * Apply a pixel width to --vault-width and remember it so re-opening the
 * explorer restores the steward's last choice.
 */
function applyVaultWidth(px) {
  const clamped = clampVaultWidth(px);
  state.vaultWidth = clamped;
  document.documentElement.style.setProperty("--vault-width", clamped + "px");
}
function initVaultDivider() {
  const divider = document.getElementById("vault-divider");
  if (!divider) return;
  let dragging = false;

  divider.addEventListener("pointerdown", (event) => {
    if (!document.getElementById("app").classList.contains("vault-open")) return;
    dragging = true;
    divider.classList.add("dragging");
    divider.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  divider.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const explorer = document.getElementById("vault-explorer");
    const rect = explorer.getBoundingClientRect();
    // New width = distance from viewport right edge back to the divider.
    const newWidth = window.innerWidth - event.clientX - (window.innerWidth - rect.right);
    applyVaultWidth(newWidth);
  });

  const stopDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove("dragging");
    try { divider.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  };
  divider.addEventListener("pointerup", stopDrag);
  divider.addEventListener("pointercancel", stopDrag);
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function autoGrowTextarea(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 150) + "px";
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("auth-submit").addEventListener("click", submitAuth);
  document.getElementById("auth-token-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitAuth();
  });

  document.getElementById("send-btn").addEventListener("click", () => sendMessage(null));
  document.getElementById("steer-btn").addEventListener("click", () => sendMessage("steer"));
  document.getElementById("followup-btn").addEventListener("click", () => sendMessage("follow_up"));
  document.getElementById("abort-btn").addEventListener("click", abortTurn);

  const input = document.getElementById("message-input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(null);
    }
  });
  input.addEventListener("input", () => autoGrowTextarea(input));

  document.getElementById("agent-switch-btn").addEventListener("click", switchAgent);
  document.getElementById("new-conversation-btn").addEventListener("click", startNewConversation);

  document.getElementById("vault-explorer-btn").addEventListener("click", () => openVaultExplorer("files"));
  document.getElementById("vault-explorer-close").addEventListener("click", closeVaultExplorer);
  document.getElementById("vault-tab-files").addEventListener("click", () => selectVaultTab("files"));
  document.getElementById("vault-tab-graph").addEventListener("click", () => {
    selectVaultTab("graph");
    loadKnowledgeGraph();
  });
  document.getElementById("vault-view-rendered").addEventListener("click", () => setVaultView("rendered"));
  document.getElementById("vault-view-raw").addEventListener("click", () => setVaultView("raw"));
  document.getElementById("inbox-create-btn").addEventListener("click", openInboxModal);
  document.getElementById("inbox-submit").addEventListener("click", submitInboxTask);
  document.getElementById("inbox-modal-close").addEventListener("click", closeInboxModal);
  document.getElementById("inbox-cancel").addEventListener("click", closeInboxModal);
  document.getElementById("notifications-btn").addEventListener("click", openNotificationsModal);
  document.getElementById("notifications-modal-close").addEventListener("click", closeNotificationsModal);

  initVaultDivider();

  document.getElementById("approval-confirm").addEventListener("click", () => submitApproval(true));
  document.getElementById("approval-cancel").addEventListener("click", () => submitApproval(false));
  document.getElementById("approval-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitApproval(true);
  });

  checkAuth();
});
