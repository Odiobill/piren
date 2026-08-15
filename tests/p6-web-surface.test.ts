import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * P6 — web surface corrections (accepted `conversation-p6-pilot-correction-contract.md`):
 * (2) composer dock geometry driven by one shared token set; (3) the single
 * transcript scroll is bottom-anchored via the pure anchor core, preserving an
 * upward reader's position; (4) no new storage/polling/endpoints/SSE surface.
 * ADR-0044 removed the empty-draft shared surface (item 1), so those pins
 * moved to the removal pins in tests/web-dashboard.test.ts.
 */

const webSrc = join(process.cwd(), "web", "src");

describe("P6 no-selection surface (ADR-0044)", () => {
  it("the no-selection surface has no timeline, no composer, and no details action", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    const placeholder = navigator.slice(navigator.indexOf("No conversation selected"));
    expect(placeholder.length).toBeGreaterThan(0);
    expect(navigator).not.toContain('aria-label="New conversation"');
    expect(navigator).not.toContain('mode="draft"');
    expect(navigator).not.toContain("conversation-draft");
    expect(navigator).not.toContain('className="conversation-scroll"');
  });

  it("the timeline has no draft mode (no zero-history early return)", async () => {
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    expect(timeline).not.toContain("if (draft) {");
    expect(timeline).not.toContain('stream: "draft"');
    expect(timeline).not.toContain("draft");
  });

  it("the details action is always enabled (no disabled draft variant)", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    const button = navigator.slice(navigator.indexOf("function DetailsToggleButton"), navigator.indexOf("function ConversationApprovalCards"));
    expect(button).toContain('aria-label="Conversation details"');
    expect(button).not.toContain("disabled={disabled}");
    expect(button).not.toContain("title={title}");
  });
});

describe("P6+R1 single bottom-anchored scroll host (static)", () => {
  it("the navigator wires the pure anchor core to the BROWSER ROOT document at COMMIT time (P8 §5 semantics on the R1 root host)", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    // P8: the anchor decision runs in a commit-time layout effect via the
    // wiring module, using the pure core's pre-commit metrics semantics.
    expect(navigator).toContain('from "./conversation-scroll-wiring"');
    expect(navigator).toContain("applyConversationScrollWiring");
    expect(navigator).toContain("EMPTY_CONVERSATION_SCROLL_WIRING");
    expect(navigator).toContain("useLayoutEffect");
    expect(navigator).toContain("contentVersion");
    // R1 — the anchor decision targets the browser root document, not an
    // inner transcript ref (no inner scroll owner exists).
    expect(navigator).toContain("rootScrollTarget");
    expect(navigator).toContain("document");
    expect(navigator).not.toContain("ref={scrollRef}");
    expect(navigator).toContain("onAppend={bumpContentVersion}");
    expect(navigator).toContain("initialAnchor: true");
    // No forced jump and no reorder/invention: the anchor core is the only
    // scroll mechanism and the transcript order stays server-durable.
    expect(navigator).not.toContain("scrollIntoView");
    expect(navigator).not.toContain(".sort(");
  });
});

describe("P6 composer dock geometry tokens (static)", () => {
  it("the shared token set defines controls, textarea bounds, gaps, radii, and bottom alignment", async () => {
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    expect(styles).toMatch(/--composer-control-size:\s*44px/);
    expect(styles).toMatch(/--composer-textarea-min-height:\s*44px/);
    expect(styles).toMatch(/--composer-textarea-max-height:\s*200px/);
    expect(styles).toMatch(/--composer-dock-gap:\s*10px/);
    expect(styles).toMatch(/--composer-control-gap:\s*8px/);
    expect(styles).toMatch(/--composer-radius-input:\s*10px/);
    expect(styles).toMatch(/--composer-radius-icon:\s*8px/);
    // The textarea derives its geometry from the tokens too.
    expect(styles).toMatch(/\.conversation-composer textarea\s*\{[\s\S]*min-height:\s*var\(--composer-textarea-min-height\)/);
    expect(styles).toMatch(/\.conversation-composer textarea\s*\{[\s\S]*max-height:\s*var\(--composer-textarea-max-height\)/);
    // Bottom-edge alignment: the dock and the control group align to the end.
    expect(styles).toMatch(/\.composer-action-row\s*\{[\s\S]*align-items:\s*flex-end/);
    expect(styles).toMatch(/\.composer-controls\s*\{[\s\S]*align-items:\s*flex-end/);
  });
});

describe("P6 boundary checks (static)", () => {
  it("no new storage, polling, endpoints, SSE schema, or unsafe surface in the changed P6 web files", async () => {
    for (const name of ["ConversationNavigator.tsx", "ConversationTimeline.tsx", "conversation-scroll-anchor.ts"]) {
      const content = await readFile(join(webSrc, name), "utf8");
      for (const forbidden of [
        "localStorage",
        "sessionStorage",
        "setInterval",
        "new EventSource",
        "/api/chat",
        "/api/vault",
        "dangerouslySetInnerHTML",
        "WebSocket",
      ]) {
        expect(content, `${name} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
