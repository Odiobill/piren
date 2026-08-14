import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * P5 — web surface corrections (accepted `conversation-pilot-correction-contract.md`):
 * the transient U4 activity-only temporary run panel with an accessible inline
 * SVG abort (no audience-as-run assertion), the full-height chat layout with
 * no footer/bordered selected container/independent shell scrolling, and the
 * empty draft parity (same chat layout + docked composer, no durable state
 * until the first accepted send).
 */

const webSrc = join(process.cwd(), "web", "src");

describe("P5+R2 transient live run state (static)", () => {
  it("compact live run state lives in the bottom dock with an accessible labelled abort icon, never a transcript panel or audience-derived run section", async () => {
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    // R2 — the transcript renders NO transient activity panel: the compact
    // dock state is broker-activity-driven and identifies the exact agent.
    expect(timeline).not.toContain("transient-run-panel");
    expect(timeline).not.toContain("ConversationActivityDisplay");
    expect(navigator).toContain("dock-run-status");
    expect(navigator).toContain("run.agent");
    // The truthful working/typing labels come from the pure activity core
    // (conversationActivityRunStateLabel), never partial work content.
    expect(navigator).toContain("conversationActivityRunStateLabel(run.phase)");
    const activity = await readFile(join(webSrc, "conversation-activity.ts"), "utf8");
    expect(activity).toContain('"is working…"');
    expect(activity).toContain('"is typing…"');
    // The accessible labelled inline-SVG abort targets the broker-provided
    // agent only via the existing abort route, moved into the dock.
    expect(navigator).toContain("Abort ${run.agent} run");
    expect(navigator).toContain("StopIcon");
    expect(navigator).toContain("handleAbort(run.agent)");
    expect(navigator).toContain("abortConversationRun(");
    // The static audience-derived Active run section is gone.
    expect(navigator).not.toContain("ConversationAbortControls");
    expect(navigator).not.toContain("run-controls");
    expect(navigator).not.toContain("Active run");
  });

  it("the compact dock state clears only on the existing U4 cleanup (no audience guess or history reconstruction)", async () => {
    const activity = await readFile(join(webSrc, "conversation-activity.ts"), "utf8");
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    // The panel reads the broker-authoritative activity state only.
    expect(activity).toContain("working");
    expect(activity).toContain("text_delta");
    expect(activity).toContain("settled");
    expect(timeline).not.toMatch(/activity\.runs\.map.*audience|audience.*activity\.runs/);
  });
});

describe("P5 full-height chat layout and empty draft (static)", () => {
  it("the persistent desktop footer is removed", async () => {
    const shell = await readFile(join(webSrc, "AppShell.tsx"), "utf8");
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    expect(shell).not.toContain("shell-footer");
    expect(styles).not.toContain(".shell-footer");
  });

  it("the selected surface has no bordered/blue-outline container and the BROWSER root owns the Conversation scroll (R1)", async () => {
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    expect(styles).toMatch(/\.conversation-surface\s*\{[\s\S]*outline:\s*none/);
    expect(styles).toMatch(/\.conversation-surface\s*\{[\s\S]*border:\s*0/);
    expect(styles).toMatch(/\.shell-main\s*>\s*\.workspace-panel-conversations\s*\{[\s\S]*width:\s*100%/);
    // R1 — the Conversation shell unclips to the browser document (no inner
    // transcript/main-pane scroll owner; no dedicated shell-main scroll area
    // for the Conversations panel) and the composer/details row is the
    // stable sticky bottom dock.
    expect(styles).toMatch(/\.shell\.shell-conversation\s*\{[\s\S]*height:\s*auto/);
    expect(styles).toMatch(/\.shell\.shell-conversation \.shell-main\s*\{[\s\S]*overflow:\s*visible/);
    expect(styles).not.toContain(".conversation-scroll");
    expect(styles).toMatch(/\.composer-action-row\s*\{[\s\S]*position:\s*sticky/);
    expect(styles).toMatch(/\.composer-action-row\s*\{[\s\S]*flex:\s*none/);
  });

  it("the composer dock controls share consistent 44px heights and vertical alignment via shared geometry tokens (P6)", async () => {
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    // One shared token set drives every dock control (no per-breakpoint
    // pixel guessing) — the P5 44px guarantee is preserved through the token.
    expect(styles).toMatch(/--composer-control-size:\s*44px/);
    expect(styles).toMatch(/--composer-dock-gap:\s*10px/);
    expect(styles).toMatch(/--composer-control-gap:\s*8px/);
    for (const selector of ["composer-upload-placeholder", "composer-submit-toggle", "conversation-details-toggle"]) {
      const widthPattern = new RegExp(String.raw`\.${selector}\s*\{[\s\S]*width:\s*var\(--composer-control-size\)`);
      const heightPattern = new RegExp(String.raw`\.${selector}\s*\{[\s\S]*height:\s*var\(--composer-control-size\)`);
      expect(styles).toMatch(widthPattern);
      expect(styles).toMatch(heightPattern);
    }
    expect(styles).toMatch(new RegExp(String.raw`\.composer-action-row\s*\{[\s\S]*align-items:\s*flex-end`));
  });

  it("the empty draft reuses the same chat layout and docked composer with no explanatory card", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    expect(navigator).toContain('aria-label="New conversation"');
    expect(navigator).not.toContain("conversation-draft");
    expect(navigator).not.toContain("only in this window");
    // The draft composer sits in the same docked action row as active chats.
    const draftBranch = navigator.slice(navigator.indexOf('aria-label="New conversation"'), navigator.length);
    expect(draftBranch).toContain("composer-action-row");
    expect(draftBranch).toContain('mode="draft"');
  });

  it("no storage, polling, new endpoints, or unsafe surface in the changed P5 web files", async () => {
    for (const name of ["ConversationTimeline.tsx", "ConversationNavigator.tsx", "AppShell.tsx", "icons.tsx"]) {
      const content = await readFile(join(webSrc, name), "utf8");
      for (const forbidden of ["localStorage", "sessionStorage", "setInterval", "new EventSource", "/api/chat", "/api/vault", "dangerouslySetInnerHTML"]) {
        expect(content, `${name} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
