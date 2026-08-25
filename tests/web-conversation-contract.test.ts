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
    "conversation-autocomplete.ts",
    "conversation-activity.ts",
    "conversation-reactions.ts",
    "conversation-timeline.ts",
    "conversation-transcript.ts",
    "conversation-details.ts",
    "conversation-lifecycle.ts",
    "hash-route.ts",
    "safe-markdown.ts",
    "SafeMarkdown.tsx",
  ];
}

describe("first-party Conversation registry entry (minimal W0 wiring)", () => {
  it("the registry is a compile-time const array with the Conversation page module, the W2 companion, and the W3 Settings page", () => {
    expect(Array.isArray(WORKBENCH_MODULES)).toBe(true);
    expect(WORKBENCH_MODULES).toHaveLength(3);
    expect(WORKBENCH_MODULES[0]).toEqual({
      id: "conversations",
      label: "Conversations",
      navOrder: 0,
      page: "conversations",
      placement: "page",
      consumes: ["conversations", "conversation-agents"],
      emits: [],
    });
    // W2: the first companion module is the read-only Vault Explorer.
    expect(WORKBENCH_MODULES[1]).toEqual({
      id: "vault-explorer",
      label: "Vault Explorer",
      navOrder: 1,
      page: "conversations",
      placement: "companion",
      consumes: ["vault-list", "vault-read"],
      emits: [],
    });
    // W5: the Settings module consumes only the narrow transport settings
    // family (typed Telegram/Discord read/write routes; W3 was zero-consumption).
    expect(WORKBENCH_MODULES[2]).toEqual({
      id: "settings",
      label: "Settings",
      navOrder: 2,
      page: "settings",
      placement: "page",
      consumes: ["settings-transports", "settings-scheduler", "settings-agents"],
      emits: [],
    });
  });

  it("lookup helpers resolve the Conversation module by id and page", () => {
    expect(getModuleById("conversations")?.label).toBe("Conversations");
    expect(getModuleById("rooms")).toBeUndefined();
    expect(getModuleById("chat")).toBeUndefined();
    expect(getModuleById("vault-explorer")?.placement).toBe("companion");
    expect(moduleForPage("conversations")?.id).toBe("conversations");
    expect(moduleForPage("dashboard")).toBeUndefined();
  });

  it("every registered module page is a real nav page and the nav replaces Rooms", () => {
    for (const module of WORKBENCH_MODULES) {
      expect(["conversations", "dashboard", "settings"]).toContain(module.page);
      expect(["page", "companion"]).toContain(module.placement);
    }
    const pages: readonly Page[] = ["dashboard", "conversations", "settings"];
    expect(pages).toEqual(["dashboard", "conversations", "settings"]);
    expect(initialNavState().page).toBe("dashboard");
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
    expect(api).toContain("/api/conversation-agents");
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
      for (const forbidden of ["thinking", "provider"]) {
        expect(content, `${name} must not contain '${forbidden}'`).not.toContain(forbidden);
      }
      // VR-3: "secret" is only permitted as a fail-closed TOOL_FORBIDDEN_KEYS
      // denylist entry (a payload field name to REJECT), never as a UI string.
      const withoutDenylist = content.replace(
        /TOOL_FORBIDDEN_KEYS: readonly string\[\] = \[[\s\S]*?\];/,
        "",
      );
      expect(withoutDenylist, `${name} must not contain 'secret'`).not.toContain("secret");
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
    // P1 removed the gateway/mention-authority tutorial copy from the app
    // (it remains documented); the routine surface must not repeat it.
    expect(component).not.toContain("Mentions are resolved by the gateway");
    expect(component).not.toContain("The browser never reads recipient names");
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

describe("U1 no-selection surface (ADR-0044)", () => {
  it("the home Conversation surface is a truthful no-selection placeholder, never a creation entry", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    const composer = await readFile(join(webSrc, "ConversationComposer.tsx"), "utf8");
    // The old "Your workspace" greeting and the retired draft template are gone.
    expect(navigator).not.toContain("Your workspace");
    expect(navigator).not.toContain('aria-label="New conversation"');
    expect(navigator).toContain("conversation-workspace");
    expect(navigator).toContain("No conversation selected");
    expect(navigator).not.toContain("conversation-draft");
    expect(navigator).not.toContain("only in this window");
    expect(composer).not.toContain("First message");
    expect(composer).not.toContain("createConversation");
  });
});

describe("U3 Discord-like composer surface (static)", () => {
  it("the composer core keeps the raw {text} body and never scans/resolves mentions", async () => {
    const composerCore = await readFile(join(webSrc, "conversation-composer.ts"), "utf8");
    const autocomplete = await readFile(join(webSrc, "conversation-autocomplete.ts"), "utf8");
    expect(composerCore).toContain("text: text.trim()");
    // The autocomplete convenience list never parses or resolves mentions for
    // dispatch: no regex match call and no recipient resolution anywhere.
    for (const content of [composerCore, autocomplete]) {
      expect(content).not.toMatch(/match\(\s*\/@/);
      expect(content).not.toContain("scanStewardMentions");
      expect(content).not.toContain("resolveRecipients");
    }
  });

  it("the autocomplete sources ONLY the locally runnable roster with keyboard/a11y affordances", async () => {
    const autocomplete = await readFile(join(webSrc, "conversation-autocomplete.ts"), "utf8");
    const composer = await readFile(join(webSrc, "ConversationComposer.tsx"), "utf8");
    // Runnable-only source (local policy `online`), never a client membership
    // or dispatch derivation.
    expect(autocomplete).toContain("online");
    expect(composer).toContain("ArrowDown");
    expect(composer).toContain("ArrowUp");
    expect(composer).toContain('"Escape"');
    expect(composer).toContain('"Tab"');
    expect(composer).toContain('role="listbox"');
    expect(composer).toContain("aria-activedescendant");
  });

  it("the disabled + upload affordance is genuinely disabled with no file capability", async () => {
    const sources = await readAllTs();
    const composer = sources.get("ConversationComposer.tsx") ?? "";
    expect(composer).toContain("composer-upload-placeholder");
    expect(composer).toMatch(/disabled[^>]*aria-label|aria-label[^>]*disabled/);
    for (const [name, content] of sources) {
      expect(content, `${name} must not reference file picking`).not.toMatch(/type="file"|FileReader|accept=/);
    }
  });

  it("the active composer sits in the bottom interaction tray outside the named history scroll host (B)", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    expect(navigator).toContain("conversation-workspace");
    // Tracer B — the named .conversation-history region is the sole
    // Conversation scroll host; the composer lives in the .interaction-tray
    // outside it; the R1 sticky dock and inner transcript owner are gone.
    expect(navigator).toContain('className="conversation-history"');
    expect(navigator).toContain('className="interaction-tray"');
    expect(navigator).not.toContain('className="conversation-scroll"');
    expect(styles).not.toContain(".conversation-scroll");
    expect(styles).not.toMatch(/\.composer-action-row\s*\{[\s\S]*position:\s*sticky/);
    expect(styles).toMatch(/\.composer-action-row\s*\{[\s\S]*flex:\s*none/);
    expect(styles).toMatch(/\.interaction-tray\s*\{[\s\S]*flex:\s*none/);
  });

  it("read-only inspection keeps no composer and the details action stays composer-right on active", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    // The composer appears only in the active branch; the read-only
    // attach-banner section never renders it.
    const banner = navigator.slice(navigator.indexOf("attach-banner"), navigator.indexOf("inspection-actions"));
    expect(banner).not.toContain("ConversationComposer");
    // U2's composer-right details placement is preserved on the active surface.
    expect(navigator).toContain("composer-action-row");
    expect(navigator).toContain("DetailsToggleButton");
  });
});

describe("U4 transient live activity surface (static)", () => {
  it("the truthful working/typing language lives in the pure activity core and the compact dock (R2: no partial-reply panel in the transcript)", async () => {
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    const activity = await readFile(join(webSrc, "conversation-activity.ts"), "utf8");
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    // R2 — the labels are rendered in the history-region status-only cards
    // via the pure core; the transcript no longer hosts a transient panel or
    // partial work content. U1 replaced the D4 dock row with these cards.
    expect(activity).toContain('"is working…"');
    expect(activity).toContain('"is typing…"');
    expect(navigator).toContain("conversationActivityRunStateLabel(run.phase)");
    expect(navigator).toContain("conversation-activity-cards");
    expect(navigator).not.toContain("dock-run-status");
    expect(timeline).not.toContain("transient-run-panel");
    expect(timeline).not.toContain("is working");
    expect(timeline).not.toContain("is typing");
    // Never a read/seen/delivery-to-model claim and never a durable event
    // per token or activity replay from history.
    expect(timeline).not.toMatch(/has read|read receipt|seen by|delivered to model/i);
    expect(activity).not.toMatch(/localStorage|sessionStorage|new EventSource|fetch\(/);
  });

  it("activity is parsed strictly and never promoted to a durable timeline record", async () => {
    const activity = await readFile(join(webSrc, "conversation-activity.ts"), "utf8");
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    // The pure core is fail-closed and bounded.
    expect(activity).toContain("parseConversationActivityFrame");
    expect(activity).toContain("4096");
    expect(activity).toContain("16384");
    // The timeline reconciles transient state with durable evidence (it never
    // reconstructs activity from history).
    expect(timeline).toContain("reconcileConversationActivity");
    expect(timeline).toContain("conversation_activity");
  });

  it("read-only inspection never opens the live stream, so it can never show activity", async () => {
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    // The live subscription is gated by the `live` prop; the inspection phase
    // renders history only with an explicit no-live-stream notice.
    expect(timeline).toContain("!live");
    expect(timeline).toContain("no live stream");
  });

  it("invalid/stale/contradictory activity frames fail closed (clear transient state, never resurrect settled runs)", async () => {
    const activity = await readFile(join(webSrc, "conversation-activity.ts"), "utf8");
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    // Malformed/foreign/contradictory frames clear the transient surface.
    expect(timeline).toContain("clearConversationActivity");
    expect(activity).toContain("export function clearConversationActivity");
    // Settled-run tombstones are bounded and in-memory only.
    expect(activity).toContain("CONVERSATION_ACTIVITY_SETTLED_TOMBSTONES_MAX");
    expect(activity).toContain("settled");
  });
});

describe("U5 bounded lifecycle/status reactions (static)", () => {
  it("the reaction core is pure, durable-only, and never a read/seen/picker surface", async () => {
    const reactions = await readFile(join(webSrc, "conversation-reactions.ts"), "utf8");
    expect(reactions).toContain("export function conversationReactionForEvent");
    expect(reactions).toContain("runAgent");
    // Bounded vocabulary only: no picker/selection surface, no actual emoji
    // characters, and no read/seen/delivery claim.
    for (const forbidden of ["picker", "has read", "read receipt", "seen by", "delivered to"]) {
      expect(reactions, `must not contain ${forbidden}`).not.toContain(forbidden);
    }
    expect(reactions).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it("the transcript groups durable run status into requester clusters (never activity/transient state)", async () => {
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    const transcript = await readFile(join(webSrc, "conversation-transcript.ts"), "utf8");
    // The P3 message-first transcript renders through the pure durable
    // grouping core; the cluster is derived ONLY from durable evidence.
    expect(timeline).toContain("groupConversationTranscript");
    expect(timeline).toContain("status-cluster");
    expect(transcript).toContain("conversationReactionForEvent");
    expect(transcript).not.toMatch(/activity\.runs|setActivity|applyConversationActivityFrame/);
    expect(transcript).not.toMatch(/localStorage|sessionStorage|new EventSource|fetch\(/);
  });

  it("inspection mode stays read-only: reactions come only from the durable whole-history reread", async () => {
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    // Read-only inspection renders replaceConversationHistoric events; the
    // same shared entry renders durable-derived reaction chips. No live
    // stream, so no live/transient state can manufacture status.
    expect(timeline).toContain("no live stream");
    expect(timeline).toContain("replaceConversationHistoric");
  });
});
