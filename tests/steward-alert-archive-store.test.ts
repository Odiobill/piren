import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { previewStoredStewardAlertArchive, StewardAlertStoreError } from "../src/steward-alert-store.js";

const closed = `---
type: Alert
id: closed-alert
from: thor
severity: high
status: closed
closed_at: 2026-09-04T17:00:00.000Z
closed_via: workbench
created: 2026-09-04T16:45:00.000Z
notify: true
---

# Closed alert
`;
const path = "steward-inbox/alerts/closed.md";
let roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function rootWithAlert(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "piren-alert-archive-"));
  roots.push(root);
  await mkdir(join(root, "steward-inbox", "alerts"), { recursive: true });
  await writeFile(join(root, path), closed);
  return root;
}

describe("stored steward-alert archive preview", () => {
  it("returns a no-mutation exact plan only when its destination is absent", async () => {
    const root = await rootWithAlert();
    await expect(previewStoredStewardAlertArchive(root, path)).resolves.toEqual({
      sourcePath: path,
      destinationPath: "steward-inbox/alerts/archive/2026/09/04/closed.md",
    });

    await mkdir(join(root, "steward-inbox", "alerts", "archive", "2026", "09", "04"), { recursive: true });
    await writeFile(join(root, "steward-inbox", "alerts", "archive", "2026", "09", "04", "closed.md"), "existing");
    await expect(previewStoredStewardAlertArchive(root, path)).rejects.toEqual(expect.objectContaining<Partial<StewardAlertStoreError>>({ kind: "conflict" }));
  });
});
