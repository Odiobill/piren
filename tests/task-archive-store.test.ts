import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { previewStoredTerminalTaskArchive } from "../src/task-archive-store.js";

let roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const task = (id: string, status: string, depends = "") => `---\nid: ${id}\nstatus: ${status}${depends}\n---\n\n# task\n`;

describe("stored terminal task archive preview", () => {
  it("plans one agent's ordinary and claimed terminal tasks while retaining a live prerequisite", async () => {
    const root = await mkdtemp(join(tmpdir(), "piren-task-archive-")); roots.push(root);
    await mkdir(join(root, "team", "thor", "inbox"), { recursive: true });
    await mkdir(join(root, "team", "piren", "inbox"), { recursive: true });
    await writeFile(join(root, "team/thor/inbox/done.md"), task("20260905T080000000Z-done", "completed"));
    await writeFile(join(root, "team/thor/inbox/claimed.claimed.nas.md"), task("20260905T080100000Z-claimed", "cancelled"));
    await writeFile(join(root, "team/thor/inbox/needed.md"), task("20260905T080200000Z-needed", "completed"));
    await writeFile(join(root, "team/piren/inbox/live.md"), task("20260905T080300000Z-live", "pending", "\ndepends_on:\n  - 20260905T080200000Z-needed"));
    await expect(previewStoredTerminalTaskArchive(root, "thor", () => new Date("2026-09-05T10:00:00.000Z"))).resolves.toMatchObject({
      eligible: [{ sourcePath: "team/thor/inbox/claimed.claimed.nas.md" }, { sourcePath: "team/thor/inbox/done.md" }],
      skipped: [{ sourcePath: "team/thor/inbox/needed.md", reason: "required by live task: 20260905T080300000Z-live" }],
    });
  });
});
