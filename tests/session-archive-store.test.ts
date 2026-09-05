import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { previewStoredSessionSummaryArchive } from "../src/session-archive-store.js";

let roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("stored vault session-summary archive preview", () => {
  it("requires one exact existing direct summary and an absent destination without mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "piren-session-archive-"));
    roots.push(root);
    const path = "team/thor/sessions/summary.md";
    await mkdir(join(root, "team", "thor", "sessions"), { recursive: true });
    await writeFile(join(root, path), "# summary\n");
    const now = () => new Date("2026-09-05T10:00:00.000Z");
    await expect(previewStoredSessionSummaryArchive(root, path, now)).resolves.toEqual({
      sourcePath: path,
      destinationPath: "team/thor/sessions/archive/2026/09/05/summary.md",
    });
    await mkdir(join(root, "team", "thor", "sessions", "archive", "2026", "09", "05"), { recursive: true });
    await writeFile(join(root, "team", "thor", "sessions", "archive", "2026", "09", "05", "summary.md"), "existing");
    await expect(previewStoredSessionSummaryArchive(root, path, now)).rejects.toThrow("destination already exists");
  });
});
