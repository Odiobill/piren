import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Residual Rooms product cleanup (task
 * `team/dipu/inbox/20260814T223524788Z-clean-residual-rooms-product-terminology-and-dead-workbench-styles.md`,
 * following the accepted no-compatibility Rooms decommission `f34854c`):
 *
 * 1. dead Room-only Workbench CSS (`.room-*`, RoomTimeline entry-list rules,
 *    RoomComposer form rules, RoomNavigator participant-list rule) is gone,
 *    while shared conversation/timeline styles actually used by the active
 *    Workbench are retained;
 * 2. stale current-tense product claims (an active Room broker/API/workbench or
 *    room fallback behavior) are corrected — the shipped surface is described
 *    as Conversation-only;
 * 3. the `Room Manifest`/`Room Event`/`Room Summary` OKF taxonomy and the
 *    `okf-graph` raw-event exclusion are PRESERVED as historical-evidence
 *    support (they are not a Room product compatibility path).
 *
 * Static cleanup coverage only: no runtime behavior, API route, schema,
 * fixture, or dist surface is asserted here.
 */

const root = process.cwd();
const stylesPath = join(root, "web", "src", "styles.css");
const configurationPath = join(root, "docs", "configuration.md");

describe("residual Rooms cleanup: dead Workbench CSS removed, shared styles kept", () => {
  it("no .room-* class rule remains in styles.css", async () => {
    const styles = await readFile(stylesPath, "utf8");
    for (const selector of [
      ".room-list",
      ".room-entry",
      ".room-title",
      ".room-meta",
      ".room-create",
    ]) {
      expect(styles, selector).not.toContain(selector);
    }
  });

  it("no RoomTimeline/RoomComposer/RoomNavigator-only CSS block remains", async () => {
    const styles = await readFile(stylesPath, "utf8");
    // RoomTimeline entry-list styles (dead since RoomTimeline.tsx was removed).
    for (const selector of [
      ".timeline-list",
      ".timeline-entry",
      ".timeline-kind",
      ".timeline-time",
      ".timeline-body",
      ".timeline-note",
    ]) {
      expect(styles, selector).not.toContain(selector);
    }
    // RoomComposer structured-dispatch form styles (dead since RoomComposer.tsx
    // and web/src/composer.ts were removed).
    for (const selector of [".composer {", ".composer-field"]) {
      expect(styles, selector).not.toContain(selector);
    }
    // RoomNavigator participant-list rule (dead since RoomNavigator.tsx was
    // removed; the live ParticipantPicker uses .participant-picker/.agent-*).
    expect(styles).not.toContain(".participant-list");
  });

  it("no stale Room-surface comment remains in styles.css", async () => {
    const styles = await readFile(stylesPath, "utf8");
    expect(styles).not.toContain("Room list");
    expect(styles).not.toContain("Create form");
    expect(styles).not.toContain("Room timeline");
    expect(styles).not.toContain("room surface");
    expect(styles).not.toContain("remain for the Rooms");
  });

  it("shared conversation/timeline styles actually used by the Workbench are retained", async () => {
    const styles = await readFile(stylesPath, "utf8");
    for (const selector of [
      ".conversation-surface",
      ".conversation-entry",
      ".participant-picker",
      ".agent-roster",
      ".agent-entry",
      ".timeline {",
      ".timeline-status",
      ".timeline-status-disconnected",
      ".button-small",
      ".transcript-list",
      ".transcript-row",
      ".composer-action-row",
      ".member-chip",
    ]) {
      expect(styles, selector).toContain(selector);
    }
  });
});

describe("residual Rooms cleanup: stale active-product claims corrected (Conversation-only)", () => {
  it("docs/configuration.md no longer describes an active Room broker or room fallback behavior", async () => {
    const configuration = await readFile(configurationPath, "utf8");
    expect(configuration).not.toContain("Room and conversation brokers");
    expect(configuration).not.toContain("room×agent");
    expect(configuration).not.toContain("room approvals stay exact");
  });

  it("docs/configuration.md describes the Conversation broker as the only broker", async () => {
    const configuration = await readFile(configurationPath, "utf8");
    expect(configuration).toContain("The conversation broker rotates");
    expect(configuration).toContain("conversation×agent");
    expect(configuration).toContain("conversation approvals stay exact");
  });

  it("stale App/Workbench comments no longer claim an active Room surface", async () => {
    const app = await readFile(join(root, "web", "src", "App.tsx"), "utf8");
    const appShell = await readFile(join(root, "web", "src", "AppShell.tsx"), "utf8");
    const nav = await readFile(join(root, "web", "src", "nav.ts"), "utf8");
    const mobileDrawer = await readFile(join(root, "web", "src", "MobileDrawer.tsx"), "utf8");
    // App.tsx: the R3b-era comment claimed the room navigator and listed the
    // shipped timeline/composer/approvals/abort surface as "still excluded".
    expect(app).not.toMatch(/room\s*navigator/);
    expect(app).not.toContain("Still excluded: timeline");
    // AppShell/nav: the C3-A notes claimed the Rooms page was replaced.
    expect(appShell).not.toContain("replaces the Rooms page");
    expect(nav).not.toContain("replaces the Rooms page");
    // MobileDrawer: runtime claim referenced an "active room/chat run".
    expect(mobileDrawer).not.toContain("room/chat run");
  });
});

describe("residual Rooms cleanup: historical Room-record taxonomy and exclusion preserved", () => {
  it("src/okf.ts keeps the Room Manifest/Event/Summary OKF types", async () => {
    const okf = await readFile(join(root, "src", "okf.ts"), "utf8");
    for (const type of ["Room Manifest", "Room Event", "Room Summary"]) {
      expect(okf, type).toContain(type);
    }
  });

  it("src/okf-graph.ts keeps the raw Room-event graph exclusion", async () => {
    const okfGraph = await readFile(join(root, "src", "okf-graph.ts"), "utf8");
    expect(okfGraph).toContain("Raw room events");
    expect(okfGraph).toContain("segments[3] === \"events\"");
  });

  it("docs/okf.md and docs/vault-layout.md keep the historical-evidence taxonomy/note", async () => {
    const okfDoc = await readFile(join(root, "docs", "okf.md"), "utf8");
    for (const type of ["Room Manifest", "Room Event", "Room Summary"]) {
      expect(okfDoc, type).toContain(type);
    }
    const vaultLayout = await readFile(join(root, "docs", "vault-layout.md"), "utf8");
    expect(vaultLayout).toContain("existing historical vault data is left untouched");
  });
});
