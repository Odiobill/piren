// @vitest-environment jsdom
import { mkdtempSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GatewayServer, type GatewayHandle } from "../src/gateway-http.js";
import { initVault } from "../src/init.js";
import { readConversationEvents } from "../src/conversations.js";
import { ConversationNavigator } from "../web/src/ConversationNavigator.js";

/**
 * VR-5 (mounted panel layer) — the REAL ConversationNavigator mounted against
 * a REAL GatewayServer over real HTTP/SSE (fake Pi, temp vault). This proves
 * the delivered VR-1/VR-3/VR-4 browser surfaces compose with the gateway:
 * immediate composer clear (durable event is sole evidence), a bounded
 * transient work card with plain-text tail + safe tool lines that clears on
 * the durable reply, settle-time Context, memory rehydration across switching
 * WITHOUT a telemetry fetch, and no transient surface on read-only/archived
 * inspection. No live credentials or Davide config.
 */

const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");

function fakePiTarget() {
  return {
    command: process.execPath,
    args: [fakePiScript],
    cwd: process.cwd(),
    env: process.env,
  };
}

const realFetch = globalThis.fetch.bind(globalThis);

let vault: string;
let server: GatewayServer;
let handle: GatewayHandle;
let base = "";
const token = "vr5-panel";
const telemetryFetches: string[] = [];

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), "piren-vr5-panel-"));
  mkdirSync(join(vault, "team", "sam"), { recursive: true });
  mkdirSync(join(vault, "team", "zai"), { recursive: true });
  await initVault({ vaultRoot: vault, agentName: "piren" });
  server = new GatewayServer({
    target: fakePiTarget(),
    authToken: token,
    vaultRoot: vault,
    runnableAgents: ["sam", "zai"],
    targetBuilder: async () => fakePiTarget(),
  });
  handle = await server.start();
  base = `http://${handle.hostname}:${handle.port}`;
  telemetryFetches.length = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/telemetry")) telemetryFetches.push(url);
    const target = typeof input === "string" && input.startsWith("/") ? `${base}${input}` : input;
    return realFetch(target, init);
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await server.close().catch(() => {});
  await rm(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function typeText(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.setSelectionRange(value.length, value.length);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function key(input: HTMLTextAreaElement, keyValue: string): void {
  input.dispatchEvent(new KeyboardEvent("keydown", { key: keyValue, bubbles: true }));
}

async function waitFor(what: string, condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("VR-5 mounted panel capture-readiness (fake Pi, real gateway)", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onUnauthorized = vi.fn();

  beforeEach(() => {
    (Element.prototype as unknown as Record<string, unknown>).scrollTo = () => {};
    container = document.createElement("div");
    document.body.appendChild(container);
    onUnauthorized.mockClear();
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    window.location.hash = "";
  });

  it("composer clears immediately, a bounded work card clears on the durable reply, and read-only inspection has none", { timeout: 30_000 }, async () => {
    // Create the conversation with audience [sam] and attach via the panel.
    const created = await post("/api/conversations", { text: "Seed no mention" });
    const id = ((await created.json()) as { conversation?: { id: string } }).conversation?.id ?? "";
    expect(id).not.toBe("");

    window.location.hash = `#conversation/${id}`;
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(ConversationNavigator, { token, onUnauthorized, onValidated: () => {}, onConversationsChanged: () => {} }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Wait for the live surface (composer) to attach over real HTTP/SSE.
    await waitFor("composer", () => container.querySelector<HTMLTextAreaElement>("textarea") !== null);
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;

    // VR-1: send a toolwork message; the composer clears IMMEDIATELY.
    await act(async () => typeText(textarea, "@sam do toolwork please"));
    act(() => key(textarea, "Enter"));
    // Composer is empty immediately, before the durable event necessarily lands.
    expect(textarea.value).toBe("");

    // A bounded transient work card appears while sam runs (plain-text tail +
    // safe tool lines), then clears on the durable reply.
    await waitFor(
      "work card tail",
      () => container.querySelector(".activity-card")?.textContent?.includes("Working on it.") === true,
    );
    const card = container.querySelector(".activity-card")!;
    expect(card.textContent).toContain("Working on it.");
    const toolLines = Array.from(card.querySelectorAll(".activity-card-tools li")).map((n) => n.textContent);
    expect(toolLines.length).toBeGreaterThanOrEqual(2);
    expect(toolLines.join(" ")).toContain("vault_read");
    // No raw tool payload leaks.
    expect(card.textContent).not.toContain("/secret.md");
    expect(card.textContent).not.toContain("permission denied");

    // Durable reply is the sole evidence; the card clears once sam settles.
    await waitFor("work card cleared", () => container.querySelector(".activity-card") === null, 20_000);
    const events = await readConversationEvents({ vaultRoot: vault, conversationId: id });
    expect(events.some((e) => e.kind === "agent_message" && e.author === "sam")).toBe(true);

    // Read-only/archived inspection: switching away and re-attaching to an
    // ARCHIVED view has no composer/work-card transient surface. (Archive the
    // conversation, then reload the navigator hash and assert no composer.)
    await post(`/api/conversations/${id}/archive`, {});
    // A same-hash assignment fires no hashchange; switch away and back so the
    // navigator fresh-attaches the now-archived conversation.
    await act(async () => {
      window.location.hash = "#dashboard";
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      window.location.hash = `#conversation/${id}`;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor("read-only inspection", () => container.querySelector("textarea") === null);
    expect(container.querySelector(".activity-card")).toBeNull();
  });

  it("settle-time Context rehydrates across switching from memory without a telemetry fetch", { timeout: 30_000 }, async () => {
    const created = await post("/api/conversations", { text: "Seed telemetry" });
    const id = ((await created.json()) as { conversation?: { id: string } }).conversation?.id ?? "";

    window.location.hash = `#conversation/${id}`;
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(ConversationNavigator, { token, onUnauthorized, onValidated: () => {}, onConversationsChanged: () => {} }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor("composer", () => container.querySelector<HTMLTextAreaElement>("textarea") !== null);
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => typeText(textarea, "@zai do toolwork please"));
    act(() => key(textarea, "Enter"));

    // The settled run's Context card appears (30.00% from the fake settle stats).
    await waitFor("context card", () => container.querySelector(".context-card") !== null, 20_000);
    expect(container.querySelector(".context-card-state")?.textContent).toBe("30.00%");

    // Switch to the Dashboard, then back: rehydrated from memory, no fetch.
    await act(async () => {
      window.location.hash = "#dashboard";
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      window.location.hash = `#conversation/${id}`;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor("rehydrated context card", () => container.querySelector(".context-card") !== null);
    expect(container.querySelector(".context-card-state")?.textContent).toBe("30.00%");
    // VR-4: rehydration never fetches telemetry.
    expect(telemetryFetches).toEqual([]);
  });
});
