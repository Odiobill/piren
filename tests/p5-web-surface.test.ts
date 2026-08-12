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

describe("P5 transient run panel (static)", () => {
  it("the timeline renders an activity-only temporary panel with an accessible labelled abort icon, never an audience-derived run section", async () => {
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    // The panel is transient-activity-driven and identifies the broker agent.
    expect(timeline).toContain("transient-run-panel");
    expect(timeline).toContain("activity.runs.length === 0");
    expect(timeline).toContain("run.agent");
    expect(timeline).toContain("is working…");
    expect(timeline).toContain("is typing…");
    expect(timeline).toContain("Transient — only durable events are saved.");
    // The accessible labelled inline-SVG abort targets the broker-provided
    // agent only via the existing abort route.
    expect(timeline).toContain("Abort ${run.agent} run");
    expect(timeline).toContain("StopIcon");
    expect(timeline).toContain("onClick={() => onAbortRun(run.agent)}");
    expect(navigator).toContain("onAbortRun={(agent) => void handleAbort(agent)}");
    // The static audience-derived Active run section is gone.
    expect(navigator).not.toContain("ConversationAbortControls");
    expect(navigator).not.toContain("run-controls");
    expect(navigator).not.toContain("Active run");
  });

  it("the panel clears only on the existing U4 cleanup (no audience guess or history reconstruction)", async () => {
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

  it("the selected surface has no bordered/blue-outline container and the workspace owns the pane (single transcript scroll)", async () => {
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    expect(styles).toMatch(/\.conversation-surface\s*\{[\s\S]*outline:\s*none/);
    expect(styles).toMatch(/\.conversation-surface\s*\{[\s\S]*border:\s*0/);
    expect(styles).toMatch(/\.shell-main\s*>\s*\.workspace-panel-conversations\s*\{[\s\S]*height:\s*100%/);
    expect(styles).toMatch(/\.shell-main\s*>\s*\.workspace-panel-conversations\s*\{[\s\S]*overflow:\s*hidden/);
    expect(styles).toMatch(/\.conversation-scroll\s*\{[\s\S]*overflow-y:\s*auto/);
    expect(styles).toMatch(/\.composer-action-row\s*\{[\s\S]*flex:\s*none/);
  });

  it("the composer dock controls share consistent 44px heights and vertical alignment", async () => {
    const styles = await readFile(join(webSrc, "styles.css"), "utf8");
    expect(styles).toMatch(/\.composer-upload-placeholder\s*\{[\s\S]*width:\s*44px[\s\S]*height:\s*44px/);
    expect(styles).toMatch(/\.composer-submit-toggle\s*\{[\s\S]*width:\s*44px[\s\S]*height:\s*44px/);
    expect(styles).toMatch(/\.conversation-details-toggle\s*\{[\s\S]*width:\s*44px[\s\S]*height:\s*44px/);
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
