import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKBENCH_MODULES, getModuleById, moduleForPage } from "../web/src/registry.js";
import { initialNavState, type Page } from "../web/src/nav.js";

/**
 * C3-A: static contract for the Conversation Workbench surface (over the
 * accepted C2 Conversation API). Pins:
 *   - the minimal first-party registry entry (identity + capabilities);
 *   - the nav page replacing the Rooms presentation;
 *   - the declared C2 endpoints the Conversation surface consumes;
 *   - the raw-text composer (never a derived recipient);
 *   - the C1/runnable-roster-gated attach (active vs read-only inspection);
 *   - no storage / dynamic imports / eval / forbidden control+API strings.
 */
const webSrc = join(process.cwd(), "web", "src");

async function readAllTs(): Promise<Map<string, string>> {
  const files = await readdir(webSrc, { recursive: true });
  const sources = new Map<string, string>();
  for (const f of files) {
    if (typeof f === "string" && (f.endsWith(".ts") || f.endsWith(".tsx"))) {
      sources.set(f, await readFile(join(webSrc, f), "utf8"));
    }
  }
  return sources;
}

function conversationModuleFiles(): string[] {
  return [
    "ConversationNavigator.tsx",
    "ConversationTimeline.tsx",
    "ConversationComposer.tsx",
    "ConversationDetailsModal.tsx",
    "conversations.ts",
    "attach.ts",
    "conversation-composer.ts",
    "conversation-timeline.ts",
    "conversation-details.ts",
    "conversation-lifecycle.ts",
    "hash-route.ts",
  ];
}

describe("first-party Conversation registry entry (minimal W0 wiring)", () => {
  it("the registry is a compile-time const array with exactly the Conversation module", () => {
    expect(Array.isArray(WORKBENCH_MODULES)).toBe(true);
    expect(WORKBENCH_MODULES).toHaveLength(1);
    expect(WORKBENCH_MODULES[0]).toEqual({
      id: "conversations",
      label: "Conversations",
      navOrder: 0,
      page: "conversations",
      consumes: ["conversations", "room-agents"],
      emits: [],
    });
  });

  it("lookup helpers resolve the Conversation module by id and page", () => {
    expect(getModuleById("conversations")?.label).toBe("Conversations");
    expect(getModuleById("rooms")).toBeUndefined();
    expect(getModuleById("chat")).toBeUndefined();
    expect(moduleForPage("conversations")?.id).toBe("conversations");
    expect(moduleForPage("agents")).toBeUndefined();
    expect(moduleForPage("about")).toBeUndefined();
  });

  it("every registered module page is a real nav page and the nav replaces Rooms", () => {
    for (const module of WORKBENCH_MODULES) {
      expect(["conversations", "agents", "about"]).toContain(module.page);
    }
    const pages: readonly Page[] = ["conversations", "agents", "about"];
    expect(pages).toEqual(["conversations", "agents", "about"]);
    expect(initialNavState().page).toBe("conversations");
  });

  it("the registry module never imports React or performs dynamic discovery", async () => {
    const registry = await readFile(join(webSrc, "registry.ts"), "utf8");
    expect(registry).not.toContain("react");
    expect(registry).not.toMatch(/import\s*\(/);
  });
});

describe("declared C2 endpoints (static)", () => {
  it("api.ts declares the conversation transport family and keeps the roster probe", async () => {
    const api = await readFile(join(webSrc, "api.ts"), "utf8");
    expect(api).toContain("/api/conversations");
    expect(api).toContain("/attach");
    expect(api).toContain("/messages");
    expect(api).toContain("/events/stream");
    expect(api).toContain("/api/room-agents");
  });

  it("the Conversation surface files never reference room/chat/vault endpoints (C3-C3 authorizes approve/abort)", async () => {
    const sources = await readAllTs();
    for (const name of conversationModuleFiles()) {
      const content = sources.get(name) ?? "";
      expect(content.length).toBeGreaterThan(0);
      // C3-C3 (2026-08-07) authorizes the two conversation control
      // endpoints; rooms/chat/vault/generic-API references stay forbidden.
      for (const forbidden of ["/api/rooms", "/api/chat", "/api/vault", "/api/v1/"]) {
        expect(content, `${name} must not reference ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("no storage, native SSE, eval, or forbidden control strings anywhere", async () => {
    const sources = await readAllTs();
    for (const [name, content] of sources) {
      for (const forbidden of ["localStorage", "sessionStorage", "new EventSource", "eval(", "new Function"]) {
        expect(content, `${name} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("no dynamic module loading in the registry or conversation modules", async () => {
    const sources = await readAllTs();
    for (const name of [...conversationModuleFiles(), "registry.ts"]) {
      const content = sources.get(name) ?? "";
      expect(content, `${name} must not contain a dynamic import`).not.toMatch(/import\s*\(/);
    }
  });

  it("no model/thinking/provider/secret UI strings in the Conversation surface", async () => {
    const sources = await readAllTs();
    for (const name of conversationModuleFiles()) {
      const content = sources.get(name) ?? "";
      for (const forbidden of ["thinking", "provider", "secret"]) {
        expect(content, `${name} must not contain '${forbidden}'`).not.toContain(forbidden);
      }
    }
  });
});

describe("raw-text composer (browser never derives recipients)", () => {
  it("the composer core builds a raw {text} body and never scans @mentions", async () => {
    const composerCore = await readFile(join(webSrc, "conversation-composer.ts"), "utf8");
    const component = await readFile(join(webSrc, "ConversationComposer.tsx"), "utf8");
    // The request body is exactly {text}; the component never builds a body
    // with a recipient/agent field and has no participant selection.
    expect(composerCore).toContain("text: text.trim()");
    expect(component).not.toMatch(/agent\s*:/);
    expect(component).not.toContain("participants");
    // The UI copy states the gateway resolves mentions; no scanning happens.
    expect(component).toContain("gateway");
    expect(component).toMatch(/textarea/);
  });

  it("no web source scans or resolves steward mentions from text", async () => {
    const sources = await readAllTs();
    for (const [name, content] of sources) {
      expect(content, `${name} must not implement mention scanning`).not.toContain("scanStewardMentions");
      expect(content, `${name} must not implement recipient resolution`).not.toContain("resolveRecipients");
      expect(content, `${name} must not extract @mentions from text`).not.toMatch(/match\(\s*\/@/);
    }
  });
});

describe("C1/runnable-roster-gated attach surface (static)", () => {
  it("the navigator performs the attach gate and renders a read-only inspection state", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    expect(navigator).toContain("attachConversation");
    expect(navigator).toContain("response.attached");
    expect(navigator).toContain("Read-only inspection");
    expect(navigator).toContain("ConversationComposer");
    expect(navigator).toContain("ConversationTimeline");
  });

  it("the timeline only subscribes to the live stream after a successful attach", async () => {
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    expect(timeline).toContain("live");
    expect(timeline).toContain("streamConversationEvents");
    expect(timeline).toContain("streamEnded");
    expect(timeline).toContain("no live stream");
  });

  it("offline audience members are labelled truthfully (U2: in the details modal)", async () => {
    // U2 moved the audience roster into the details modal; the truthful
    // runnable/offline labels now live there (the navigator imports it).
    const modal = await readFile(join(webSrc, "ConversationDetailsModal.tsx"), "utf8");
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    expect(modal).toContain("classifyAudienceMembers");
    expect(modal).toContain("Offline");
    expect(navigator).toContain("ConversationDetailsModal");
  });
});

describe("C4-A hash deep links (static)", () => {
  it("the hash-route core is pure: no window/document/storage/network", async () => {
    const hashRoute = await readFile(join(webSrc, "hash-route.ts"), "utf8");
    expect(hashRoute).toContain("export function parseHashRoute");
    expect(hashRoute).toContain("export function formatConversationHash");
    expect(hashRoute).toContain("export function urlWithoutHash");
    expect(hashRoute).toContain("export function routeToIntent");
    for (const forbidden of ["window", "document", "localStorage", "sessionStorage", "fetch(", "XMLHttpRequest", "/api/"]) {
      expect(hashRoute, `hash-route.ts must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("the sidebar selection drives a hashchange and the navigator always fresh-attaches it", async () => {
    const [navigator, sidebar] = await Promise.all([
      readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8"),
      readFile(join(webSrc, "Sidebar.tsx"), "utf8"),
    ]);
    // Sidebar-owned selection writes the durable hash route; the navigator
    // remains the single attach gate and re-reads before any active surface.
    expect(sidebar).toContain("window.location.hash");
    expect(sidebar).toContain("formatConversationHash");
    expect(navigator).toContain("hashchange");
    expect(navigator).toContain("parseHashRoute");
    expect(navigator).toContain("routeToIntent");
    expect(navigator).toContain("fetchConversation");
    expect(navigator).toContain("attachConversation");
  });

  it("active deep links open live SSE only after attach; rejected/archived links are inspection-only", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    // The active branch subscribes the timeline live; the read-only branch
    // renders history without a composer or live stream.
    expect(navigator).toContain("live={true}");
    expect(navigator).toContain("live={false}");
    expect(navigator).toContain("Read-only inspection");
    // Unknown/malformed routes fail truthfully to the list with a non-secret
    // message and never perform a request (no draft/dispatch/mutation).
    expect(navigator).toContain("Unknown route");
  });
});

describe("U1 local draft surface (static)", () => {
  it("the default Conversation main surface is the local new-conversation draft template, not the workspace greeting", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    // The old "Your workspace" greeting is gone.
    expect(navigator).not.toContain("Your workspace");
    // The home surface is the draft template: a heading, a first-message
    // textarea, and the existing first-message activation call.
    expect(navigator).toContain("New conversation");
    expect(navigator).toContain("First message");
    expect(navigator).toContain("createConversation");
    expect(navigator).toContain("formatConversationHash");
    // Ephemeral by contract: the draft lives only in this window and is
    // persisted only when its first message is sent (no storage anywhere).
    expect(navigator).toContain("only in this window");
  });
});
