// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * R1 (accepted `workbench-conversation-canvas-refinement-contract.md`) as
 * narrowed by ADR-0044 Tracer B: the browser/document ROOT scroll host and
 * the document-flow canvas remain ONLY for the read-only inspection and
 * no-selection surfaces (which have no interaction tray). The ACTIVE
 * Conversation viewport is owned by Tracer B — the named
 * `.conversation-history` region is the sole Conversation scroll host with
 * the bottom interaction tray outside it; see
 * tests/web-tracer-b-history-tray.test.ts for the active pins. The obsolete
 * inner `.conversation-scroll` wrapper stays removed everywhere.
 */

const webSrc = join(process.cwd(), "web", "src");

describe("R1 retained document-flow scope (static)", () => {
  it("the obsolete inner .conversation-scroll owner remains absent everywhere", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    expect(navigator).not.toContain('className="conversation-scroll"');
    expect(navigator).not.toContain("ref={scrollRef}");
    expect(styles).not.toContain(".conversation-scroll");
  });

  it("the shell keeps the conversations-page modifier and the R1 document-flow rules for non-active surfaces", async () => {
    const shell = await readFile(join(webSrc, "AppShell.tsx"), "utf8");
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    expect(shell).toContain("shell-conversation");
    expect(shell).toContain('nav.page === "conversations"');
    // The R1 unclip remains for read-only/no-selection (document flow);
    // the ACTIVE surface overrides it via the Tracer B clip modifier.
    expect(styles).toMatch(/\.shell\.shell-conversation\s*\{[\s\S]*height:\s*auto/);
    expect(styles).toMatch(/\.shell\.shell-conversation-active\s*\{[\s\S]*height:\s*100dvh/);
  });

  it("the commit-time anchor wiring keeps the pure pre-commit semantics (no scrollIntoView, no forced jumps)", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    const wiring = await readFile(join(webSrc, "conversation-scroll-wiring.ts"), "utf8");
    expect(wiring).toContain("applyConversationScrollWiring");
    expect(wiring).toContain("EMPTY_CONVERSATION_SCROLL_WIRING");
    expect(navigator).toContain("useLayoutEffect");
    expect(navigator).toContain("contentVersion");
    expect(navigator).toContain("shouldApplyConversationScroll(surfaceRef.current)");
    expect(navigator).not.toContain("scrollIntoView");
    expect(navigator).not.toContain(".sort(");
  });

  it("no gateway/SSE/storage/polling surface in the touched files", async () => {
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
