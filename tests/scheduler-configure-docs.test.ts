import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Focused docs assertions for the delivered `piren scheduler configure` CLI
// surface (0.2.0 S3). Pins that the operator docs tell the truth about the
// fail-closed defaults, the guided atomic writer, and the bounded --force
// override — nothing more.

const repoRoot = process.cwd();

describe("scheduler configure operator docs (0.2.0 S3)", () => {
  it("docs/scheduler.md documents the fail-closed gates, configure, and --force boundary", async () => {
    const doc = await readFile(join(repoRoot, "docs", "scheduler.md"), "utf8");
    // Fail-closed default gate + closed classes.
    expect(doc).toContain("scheduler.enabled");
    expect(doc).toMatch(/disabled by default|fail.closed/i);
    expect(doc).toContain("inbox_tasks");
    expect(doc).toContain("agent_cron");
    expect(doc).toContain("script_cron");
    // The guided atomic writer.
    expect(doc).toContain("piren scheduler configure");
    expect(doc).toMatch(/preview/);
    expect(doc).toMatch(/atomic/);
    expect(doc).toMatch(/never (starts?|installs?)/i);
    // The bounded one-shot override stays --once-only.
    expect(doc).toContain("--once --force");
    expect(doc).toMatch(/master and inbox/i);
  });
});
