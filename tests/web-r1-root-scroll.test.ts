// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { rootScrollTarget, type ConversationScrollTarget } from "../web/src/conversation-scroll-wiring.js";

/**
 * R1 (accepted `workbench-conversation-canvas-refinement-contract.md`) — the
 * browser/document ROOT is the sole Conversation scroll host. The active and
 * draft Conversation render one document-level chronological scroll surface
 * (no inner `.conversation-scroll` / main-pane scroll owner), the composer/
 * details action row is a stable sticky bottom dock with opaque clearance,
 * and the surface is full-width and uncarded (no artificial content margins).
 * The pure pre-commit anchor core keeps its exact P8 semantics but is wired
 * to `document.scrollingElement` instead of a ref'd inner transcript box.
 *
 * This module's target structure does not exist yet: RED.
 */

const webSrc = join(process.cwd(), "web", "src");

describe("R1 root-scroll structure (static)", () => {
  it("the navigator removes the inner .conversation-scroll owner and wires the BROWSER root as the sole Conversation scroll host", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    const wiring = await readFile(join(webSrc, "conversation-scroll-wiring.ts"), "utf8");
    // No inner transcript/main-pane scroll wrapper element may exist anymore
    // (the wiring module import name is untouched — only the DOM owner is gone).
    expect(navigator).not.toContain('className="conversation-scroll"');
    expect(navigator).not.toContain("ref={scrollRef}");
    // The commit-time anchor decision targets the browser root document.
    expect(navigator).toContain("rootScrollTarget");
    expect(navigator).toContain("document");
    expect(wiring).toContain("rootScrollTarget");
    expect(wiring).toContain("scrollingElement");
  });

  it("the shell applies a conversation modifier and the CSS makes the document root the scroll host (no viewport clip)", async () => {
    const shell = await readFile(join(webSrc, "AppShell.tsx"), "utf8");
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    // The shell marks the conversations page so its layout may switch the
    // scroll host to the browser document.
    expect(shell).toContain("shell-conversation");
    expect(shell).toContain('nav.page === "conversations"');
    // The base shell rule keeps the fixed desktop chrome; the conversation
    // modifier unclips it (height auto + overflow visible) so the BROWSER
    // document scrolls — never a dedicated inner scroll area.
    expect(styles).toMatch(/\.shell\s*\{[\s\S]*height:\s*100dvh/);
    expect(styles).toMatch(/\.shell\.shell-conversation\s*\{[\s\S]*height:\s*auto/);
    expect(styles).toMatch(/\.shell\.shell-conversation\s*\{[\s\S]*overflow:\s*visible/);
    expect(styles).toMatch(/\.shell\.shell-conversation \.shell-main\s*\{[\s\S]*overflow:\s*visible/);
    // The obsolete inner transcript scroll owner is gone from the stylesheet.
    expect(styles).not.toContain(".conversation-scroll");
  });

  it("the composer/details dock is a stable sticky bottom dock with opaque clearance; the workspace is uncarded", async () => {
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    // The dock sticks to the viewport bottom while the reader scrolls the
    // document, and carries an opaque background + top border so content is
    // neither hidden nor visually confused with the dock.
    expect(styles).toMatch(/\.composer-action-row\s*\{[\s\S]*position:\s*sticky/);
    expect(styles).toMatch(/\.composer-action-row\s*\{[\s\S]*bottom:\s*0/);
    expect(styles).toMatch(/\.composer-action-row\s*\{[\s\S]*background:/);
    expect(styles).toMatch(/\.composer-action-row\s*\{[\s\S]*border-top:/);
    // The conversation workspace is full-width and uncarded: no artificial
    // padding/margins around the timeline content.
    expect(styles).not.toMatch(/\.conversation-workspace\s*\{[^}]*padding:/);
  });

  it("the root-scroll wiring keeps the pure pre-commit anchor semantics (no scrollIntoView, no forced jumps)", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    const wiring = await readFile(join(webSrc, "conversation-scroll-wiring.ts"), "utf8");
    // The commit-time layout-effect wiring (P8 §5 semantics) stays; only the
    // scroll target moved from an inner ref to the browser root.
    expect(wiring).toContain("applyConversationScrollWiring");
    expect(wiring).toContain("EMPTY_CONVERSATION_SCROLL_WIRING");
    expect(navigator).toContain("useLayoutEffect");
    expect(navigator).toContain("contentVersion");
    expect(navigator).not.toContain("scrollIntoView");
    expect(navigator).not.toContain(".sort(");
  });

  it("R1 changes no gateway/SSE/storage/polling surface in the touched files", async () => {
    for (const name of ["AppShell.tsx", "ConversationNavigator.tsx", "conversation-scroll-wiring.ts"]) {
      const content = await readFile(join(webSrc, name), "utf8");
      for (const forbidden of [
        "localStorage",
        "sessionStorage",
        "setInterval",
        "new EventSource",
        "/api/chat",
        "/api/vault",
        "WebSocket",
        "dangerouslySetInnerHTML",
      ]) {
        expect(content, `${name} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe("R1 rootScrollTarget (pure)", () => {
  it("returns null when the document exposes no scrolling element", () => {
    expect(rootScrollTarget({ scrollingElement: null } as unknown as Document)).toBeNull();
  });

  it("forwards the live scrolling element as the anchor target", () => {
    const scrollTo = vi.fn();
    const el = {
      scrollTop: 1000,
      clientHeight: 600,
      scrollHeight: 3000,
      scrollTo,
    };
    const target = rootScrollTarget({ scrollingElement: el } as unknown as Document);
    expect(target).not.toBeNull();
    const typed = target as ConversationScrollTarget;
    expect(typed.scrollTop).toBe(1000);
    expect(typed.clientHeight).toBe(600);
    expect(typed.scrollHeight).toBe(3000);
    typed.scrollTo({ top: 3000, behavior: "auto" });
    expect(scrollTo).toHaveBeenCalledWith({ top: 3000, behavior: "auto" });
  });
});
