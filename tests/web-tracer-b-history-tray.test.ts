// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  conversationScrollTarget,
  shouldApplyConversationScroll,
  type ConversationScrollTarget,
} from "../web/src/conversation-scroll-wiring.js";

/**
 * ADR-0044 Tracer B — active Conversation viewport: the named history region
 * is the SOLE Conversation scroll host, and the bottom interaction tray
 * (compact live-run/abort state, exact approval cards, composer/details) is a
 * natural flex child OUTSIDE it. Transcript content and the tray share one
 * explicit horizontal inset. R1 browser-root scrolling is superseded ONLY for
 * the active Conversation scroll-host placement; read-only inspection and the
 * no-selection/Dashboard surfaces keep their existing behavior.
 */

const webSrc = join(process.cwd(), "web", "src");

describe("Tracer B active DOM separation (static)", () => {
  it("the active workspace renders the timeline inside .conversation-history and the controls inside a sibling .interaction-tray", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    const activeBranch = navigator.slice(navigator.indexOf("active ? ("), navigator.indexOf(") : ("));
    expect(activeBranch).toContain('className="conversation-history"');
    expect(activeBranch).toContain('className="interaction-tray"');
    // Order: history region first, tray after it.
    expect(activeBranch.indexOf('className="conversation-history"')).toBeLessThan(activeBranch.indexOf('className="interaction-tray"'));
    // The history region contains the durable timeline.
    const history = activeBranch.slice(activeBranch.indexOf('className="conversation-history"'), activeBranch.indexOf('className="interaction-tray"'));
    expect(history).toContain("<ConversationTimeline");
    expect(history).not.toContain("ConversationApprovalCards");
    expect(history).not.toContain("ConversationComposer");
    // The tray contains the existing approval cards, compact live-run state,
    // and the composer/details controls.
    const tray = activeBranch.slice(activeBranch.indexOf('className="interaction-tray"'));
    expect(tray).toContain("ConversationApprovalCards");
    expect(tray).toContain("dock-run-status");
    expect(tray).toContain("composer-action-row");
    expect(tray).toContain("ConversationComposer");
    expect(tray).toContain("DetailsToggleButton");
    // The approval cards are NOT rendered as durable transcript entries: they
    // live only in the tray, never inside the history region.
    expect(history).not.toContain("approval");
  });

  it("the history region is one named, keyboard-accessible region", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    const host = navigator.slice(navigator.indexOf('className="conversation-history"') - 200, navigator.indexOf('className="conversation-history"') + 400);
    expect(host).toContain('role="region"');
    expect(host).toContain('aria-label="Conversation history"');
    expect(host).toContain("tabIndex={0}");
  });

  it("read-only inspection has no interaction tray, composer, or tray controls", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    const readOnly = navigator.slice(navigator.indexOf("attach-banner"), navigator.indexOf("detailsOpen &&"));
    expect(readOnly).not.toContain("interaction-tray");
    expect(readOnly).not.toContain("ConversationComposer");
    expect(readOnly).not.toContain("ConversationApprovalCards");
    expect(readOnly).not.toContain("dock-run-status");
  });
});

describe("Tracer B scroll wiring (pure + static)", () => {
  it("conversationScrollTarget resolves the named history host inside the surface when present", () => {
    const surface = document.createElement("section");
    const history = document.createElement("div");
    history.className = "conversation-history";
    surface.append(history);
    document.body.append(surface);
    try {
      const target = conversationScrollTarget(surface, document);
      expect(target).toBe(history);
    } finally {
      surface.remove();
    }
  });

  it("conversationScrollTarget falls back to the document scrolling element only when the surface has no history host (read-only/no-selection R1 behavior)", () => {
    const surface = document.createElement("section");
    document.body.append(surface);
    try {
      const target = conversationScrollTarget(surface, document);
      expect(target).toBe(document.scrollingElement);
    } finally {
      surface.remove();
    }
  });

  it("a null surface without a history host still resolves only the document element (never fabricates a host)", () => {
    const target = conversationScrollTarget(null, document);
    expect(target).toBe(document.scrollingElement);
  });

  it("the visibility gate keeps hidden/unselected surfaces unscrollable", () => {
    const surface = document.createElement("section");
    const panel = document.createElement("div");
    panel.className = "workspace-panel";
    panel.hidden = true;
    panel.append(surface);
    document.body.append(panel);
    try {
      expect(shouldApplyConversationScroll(surface)).toBe(false);
    } finally {
      panel.remove();
    }
    const visible = document.createElement("section");
    const visiblePanel = document.createElement("div");
    visiblePanel.className = "workspace-panel";
    visiblePanel.append(visible);
    document.body.append(visiblePanel);
    try {
      expect(shouldApplyConversationScroll(visible)).toBe(true);
    } finally {
      visiblePanel.remove();
    }
  });

  it("the navigator wires the actual history host, never document.scrollingElement directly, and the R1 root resolver is gone", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    const wiring = await readFile(join(webSrc, "conversation-scroll-wiring.ts"), "utf8");
    expect(navigator).toContain("conversationScrollTarget(surfaceRef.current, document)");
    expect(navigator).toContain("shouldApplyConversationScroll(surfaceRef.current)");
    expect(navigator).not.toContain("rootScrollTarget");
    expect(wiring).not.toContain("rootScrollTarget");
    expect(wiring).toContain("conversation-history");
    // The commit-time anchor semantics are preserved.
    expect(navigator).toContain("useLayoutEffect");
    expect(navigator).toContain("applyConversationScrollWiring");
    expect(navigator).not.toContain("scrollIntoView");
  });

  it("the shell marks the active Conversation so the active viewport clips while read-only/no-selection keep R1 document flow", async () => {
    const shell = await readFile(join(webSrc, "AppShell.tsx"), "utf8");
    expect(shell).toContain("shell-conversation-active");
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    // The navigator reports the selection mode so the shell can clip only the
    // ACTIVE surface (read-only keeps the R1 document flow).
    expect(navigator).toContain('onSelectionChange?.(selection.conversation.title, selection.phase === "active")');
  });
});

describe("Tracer B layout styles (static)", () => {
  it("the history region is the sole Conversation scroll host; the tray is a non-scrolling flex child outside it", async () => {
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    expect(styles).toMatch(/\.conversation-history\s*\{[\s\S]*flex:\s*1/);
    expect(styles).toMatch(/\.conversation-history\s*\{[\s\S]*min-height:\s*0/);
    expect(styles).toMatch(/\.conversation-history\s*\{[\s\S]*overflow-y:\s*auto/);
    expect(styles).toMatch(/\.interaction-tray\s*\{[\s\S]*flex:\s*none/);
    // The tray never becomes a second conversation scroll area.
    const trayRule = styles.slice(styles.indexOf(".interaction-tray"), styles.indexOf(".interaction-tray") + 400);
    expect(trayRule).not.toMatch(/overflow(-y)?:\s*(auto|scroll)/);
    // The obsolete inner transcript owner stays absent.
    expect(styles).not.toContain(".conversation-scroll");
  });

  it("the telemetry details popup never becomes an inner scroll region (no overflow auto/scroll, no max-height clip)", async () => {
    // Accepted context-cards design §4/§2.1: no new scroll region — the
    // document remains the single scroll owner. The popup content is strictly
    // bounded (state line, one bar, <=6 permitted fields, one action row, one
    // bounded error), so the rule needs no overflow or max-height at all.
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    const start = styles.indexOf(".telemetry-popup {");
    expect(start).toBeGreaterThan(-1);
    const rule = styles.slice(start, styles.indexOf("}", start));
    expect(rule).not.toMatch(/overflow(-y|-x)?:\s*(auto|scroll)/);
    expect(rule).not.toMatch(/max-height/);
  });

  it("the active Conversation shell clips to the viewport (no root-document workaround for the active layout)", async () => {
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    expect(styles).toMatch(/\.shell\.shell-conversation-active\s*\{[\s\S]*height:\s*100dvh/);
    expect(styles).toMatch(/\.shell\.shell-conversation-active\s*\{[\s\S]*overflow:\s*hidden/);
    expect(styles).toMatch(/\.shell-conversation-active \.shell-main\s*\{[\s\S]*overflow:\s*hidden/);
  });

  it("one shared horizontal inset token drives both the transcript content and the tray", async () => {
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    expect(styles).toContain("--conversation-inline-inset");
    expect(styles).toMatch(/\.conversation-history\s*\{[\s\S]*padding-inline:\s*var\(--conversation-inline-inset\)/);
    expect(styles).toMatch(/\.interaction-tray\s*\{[\s\S]*padding-inline:\s*var\(--conversation-inline-inset\)/);
  });

  it("the composer action row inside the tray is a plain flex row (no sticky/root workaround remains for the active layout)", async () => {
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    expect(styles).not.toMatch(/\.composer-action-row\s*\{[\s\S]*position:\s*sticky/);
    expect(styles).toMatch(/\.composer-action-row\s*\{[\s\S]*flex:\s*none/);
    expect(styles).toMatch(/\.composer-action-row\s*\{[\s\S]*align-items:\s*flex-end/);
  });
});
