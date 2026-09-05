import { describe, expect, it } from "vitest";
import { planSessionSummaryArchive } from "../src/session-archive.js";

describe("vault session-summary archive planning", () => {
  it("plans one direct vault summary into an operation-date archive", () => {
    expect(planSessionSummaryArchive({ path: "team/thor/sessions/20260905T090000000Z-summary.md", archiveAt: "2026-09-05T10:00:00.000Z" })).toEqual({
      sourcePath: "team/thor/sessions/20260905T090000000Z-summary.md",
      destinationPath: "team/thor/sessions/archive/2026/09/05/20260905T090000000Z-summary.md",
    });
  });

  it("rejects Pi-native, archive, traversal, and invalid-time paths", () => {
    for (const path of [".pi/agent/sessions/x.md", "team/thor/sessions/archive/x.md", "team/thor/sessions/../x.md"]) {
      expect(() => planSessionSummaryArchive({ path, archiveAt: "2026-09-05T10:00:00.000Z" })).toThrow("direct");
    }
    expect(() => planSessionSummaryArchive({ path: "team/thor/sessions/x.md", archiveAt: "bad" })).toThrow("operation time");
  });
});
