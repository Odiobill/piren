import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { listArchivedFiles } from "../src/archive-inspection.js";

let roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("archive inspection", () => {
  it("lists only canonical date-partitioned archive files deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "piren-archive-inspect-")); roots.push(root);
    const dir = join(root, "steward-inbox/alerts/archive/2026/09/05");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "b.md"), "b"); await writeFile(join(dir, "a.md"), "a");
    await expect(listArchivedFiles({ vaultRoot: root, kind: "alerts" })).resolves.toEqual([
      "steward-inbox/alerts/archive/2026/09/05/a.md", "steward-inbox/alerts/archive/2026/09/05/b.md",
    ]);
  });
});
