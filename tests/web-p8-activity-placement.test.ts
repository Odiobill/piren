import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * P8 (accepted `conversation-p8-pilot-correction-contract.md` §3) — U4
 * transient activity renders at the CHRONOLOGICAL BOTTOM (below the durable
 * transcript items, immediately above the docked composer), not at the
 * transcript top; durable ordering and the U4 frame surface are unchanged.
 */

const webSrc = join(process.cwd(), "web", "src");

describe("P8 U4 activity placement (static)", () => {
  it("ConversationActivityDisplay renders AFTER ConversationTimelineItems in the ready branch", async () => {
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    const readyBranch = timeline.slice(timeline.indexOf('phase.phase === "ready"'), timeline.length);
    const activityIndex = readyBranch.indexOf("<ConversationActivityDisplay");
    const itemsIndex = readyBranch.indexOf("<ConversationTimelineItems");
    expect(activityIndex).toBeGreaterThanOrEqual(0);
    expect(itemsIndex).toBeGreaterThanOrEqual(0);
    // Chronological bottom: the durable transcript items come first, then the
    // transient activity panel sits immediately above the docked composer.
    expect(activityIndex).toBeGreaterThan(itemsIndex);
  });

  it("activity frames still notify the surface via onAppend for the anchor decision", async () => {
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    const activityFrameBranch = timeline.slice(timeline.indexOf("frame.event === \"conversation_activity\""), timeline.length);
    expect(activityFrameBranch).toContain("onAppend?.()");
  });

  it("durable ordering and the U4 frame surface are untouched (no new schema/sort)", async () => {
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    // The durable transcript render path is unchanged: items come from
    // groupConversationTranscript over phase.items in server-durable order.
    expect(timeline).toContain("groupConversationTranscript(items)");
    // No reordering/sorting of the durable items introduced by P8.
    expect(timeline).not.toContain(".sort(");
  });
});
