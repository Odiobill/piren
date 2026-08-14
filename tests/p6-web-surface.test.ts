import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * P6 — web surface corrections (accepted `conversation-p6-pilot-correction-contract.md`):
 * (1) active + draft share the SAME Conversation workspace/timeline component
 * path, with a disabled docked `Conversation details` action in the draft
 * (truthful accessible name/title, no modal/click, no durable state);
 * (2) composer dock geometry driven by one shared token set; (3) the single
 * transcript scroll is bottom-anchored via the pure anchor core, preserving an
 * upward reader's position; (4) no new storage/polling/endpoints/SSE surface.
 */

const webSrc = join(process.cwd(), "web", "src");

describe("P6 shared surface path and disabled draft details (static)", () => {
  it("the active and empty draft render the SAME Conversation timeline component path inside the same workspace", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    const draftBranch = navigator.slice(navigator.indexOf('aria-label="New conversation"'), navigator.length);
    // The draft renders the SAME ConversationTimeline component (draft mode),
    // not a bespoke bare scroll div.
    expect(draftBranch).toContain("<ConversationTimeline");
    expect(draftBranch).toContain("draft");
    expect(draftBranch).toContain("conversation-workspace");
    expect(draftBranch).not.toContain('className="conversation-scroll"');
    expect(draftBranch).toContain("composer-action-row");
  });

  it("the timeline's draft mode has zero history: no fetch, no stream, no durable state", async () => {
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    expect(timeline).toContain("if (draft) {");
    expect(timeline).toContain('stream: "draft"');
    expect(timeline).toContain('setPhase({ phase: "ready", items: [], stream: "draft", message: null })');
    // The draft early-return sits BEFORE the whole-history fetch and the live
    // stream subscription in the same mount effect (match the calls, not the
    // import line).
    const draftIndex = timeline.indexOf("      if (draft) {");
    const fetchIndex = timeline.indexOf("await fetchConversationEvents(");
    const streamIndex = timeline.indexOf("await streamConversationEvents(");
    expect(draftIndex).toBeGreaterThanOrEqual(0);
    expect(fetchIndex).toBeGreaterThan(draftIndex);
    expect(streamIndex).toBeGreaterThan(draftIndex);
  });

  it("the draft dock carries the details action disabled with a truthful accessible reason and no click", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    const draftBranch = navigator.slice(navigator.indexOf('aria-label="New conversation"'), navigator.length);
    expect(draftBranch).toContain("<DetailsToggleButton");
    expect(draftBranch).toContain("disabled");
    expect(draftBranch).toContain("title=\"Conversation details become available after the first message is sent\"");
    // No modal/click path in the draft dock: the disabled button carries no
    // onClick handler there.
    const draftButtonStart = draftBranch.indexOf("<DetailsToggleButton");
    expect(draftButtonStart).toBeGreaterThanOrEqual(0);
    expect(draftBranch.slice(draftButtonStart, draftButtonStart + 400)).not.toContain("onClick");
    // The shared button renders disabled + title and keeps the accessible name.
    const button = navigator.slice(navigator.indexOf("function DetailsToggleButton"), navigator.indexOf("function ConversationApprovalCards"));
    expect(button).toContain("aria-label=\"Conversation details\"");
    expect(button).toContain("disabled={disabled}");
    expect(button).toContain("title={title}");
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
