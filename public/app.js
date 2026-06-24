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
}

async function loadState() {
  try {
    const st = await apiJson("/api/chat/state");
    updateContextIndicator(st);
  } catch (err) {
    document.getElementById("context-text").textContent = "Error: " + err.message;
  }
}

function updateContextIndicator(st) {
  const parts = [];
  if (st.model && st.model.id) parts.push(st.model.id);
  if (st.thinkingLevel) parts.push("think:" + st.thinkingLevel);
  if (st.isStreaming) parts.push("streaming");
  if (st.messageCount !== undefined) parts.push(st.messageCount + " msgs");
  document.getElementById("context-text").textContent = parts.length ? parts.join(" | ") : "Connected";
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
  div.textContent = text;
  document.getElementById("messages").appendChild(div);
  scrollMessages();
  return div;
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
  state.currentAssistantEl.textContent += data.text || "";
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

// ---------------------------------------------------------------------------
// Vault browser
// ---------------------------------------------------------------------------

async function openVaultBrowser() {
  document.getElementById("vault-panel").classList.remove("hidden");
  state.vaultPath = ".";
  await browseVault(".");
}

function closeVaultBrowser() {
  document.getElementById("vault-panel").classList.add("hidden");
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

async function readVaultFile(path) {
  try {
    const data = await apiJson("/api/vault/read?path=" + encodeURIComponent(path));
    document.getElementById("vault-content-pre").textContent = data.content || "";
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
    document.getElementById("vault-content").classList.remove("hidden");
  }
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

  document.getElementById("vault-browser-btn").addEventListener("click", openVaultBrowser);
  document.getElementById("vault-close").addEventListener("click", closeVaultBrowser);

  document.getElementById("approval-confirm").addEventListener("click", () => submitApproval(true));
  document.getElementById("approval-cancel").addEventListener("click", () => submitApproval(false));
  document.getElementById("approval-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitApproval(true);
  });

  checkAuth();
});
