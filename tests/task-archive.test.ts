import { describe, expect, it } from "vitest";
import { planTerminalTaskArchive } from "../src/task-archive.js";

const terminal = { id: "20260905T080000000Z-done", status: "completed" as const, path: "team/thor/inbox/done.md", agentName: "thor", dependsOn: [] };

describe("terminal task archive planning", () => {
  it("selects ordinary and claimed terminal tasks, but blocks a task needed by live work", () => {
    const result = planTerminalTaskArchive({
      agentName: "thor",
      archiveAt: "2026-09-05T09:00:00.000Z",
      tasks: [
        terminal,
        { ...terminal, id: "20260905T080100000Z-claimed", path: "team/thor/inbox/claimed.claimed.nas.md", status: "cancelled" as const, claimedBy: "nas" },
        { ...terminal, id: "20260905T080200000Z-needed", path: "team/thor/inbox/needed.md" },
        { id: "20260905T080300000Z-live", status: "pending" as const, path: "team/piren/inbox/live.md", agentName: "piren", dependsOn: ["20260905T080200000Z-needed"] },
      ],
    });
    expect(result.eligible.map((item) => item.sourcePath)).toEqual(["team/thor/inbox/claimed.claimed.nas.md", terminal.path]);
    expect(result.eligible[0]?.destinationPath).toBe("team/thor/inbox/archive/2026/09/05/claimed.claimed.nas.md");
    expect(result.skipped).toEqual([{ sourcePath: "team/thor/inbox/needed.md", reason: "required by live task: 20260905T080300000Z-live" }]);
  });

  it("does not let terminal dependents block cleanup and rejects invalid source grammar", () => {
    expect(planTerminalTaskArchive({ agentName: "thor", archiveAt: "2026-09-05T09:00:00.000Z", tasks: [terminal, { ...terminal, id: "20260905T080300000Z-finished", agentName: "piren", status: "completed" as const, dependsOn: [terminal.id] }] }).eligible).toHaveLength(1);
    expect(() => planTerminalTaskArchive({ agentName: "thor", archiveAt: "bad", tasks: [terminal] })).toThrow("operation time");
  });
});
