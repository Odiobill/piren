import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Focused docs assertions for the delivered `piren scheduler configure` CLI
// surface (0.2.0 S3 + SGC gate retirement). Pins that the operator docs tell
// the truth about the class-sole gates, the fail-closed retired-key state,
// the guided atomic writer, and the inbox-only --force override — nothing
// more.

const repoRoot = process.cwd();

describe("scheduler configure operator docs (0.2.0 S3)", () => {
  it("docs/scheduler.md documents the class-sole gates, configure, and --force boundary", async () => {
    const doc = await readFile(join(repoRoot, "docs", "scheduler.md"), "utf8");
    // The three automation classes are the sole ordinary execution gates.
    expect(doc).toMatch(/sole ordinary execution gates/i);
    expect(doc).toContain("inbox_tasks");
    expect(doc).toContain("agent_cron");
    expect(doc).toContain("script_cron");
    // The retired key is documented fail-closed, never as a live gate.
    expect(doc).toContain("scheduler.enabled");
    expect(doc).toMatch(/inert-to-ignore/i);
    expect(doc).toMatch(/fail closed/i);
    // The guided atomic writer is the only migration writer.
    expect(doc).toContain("piren scheduler configure");
    expect(doc).toMatch(/only\) writer|only migration writer/i);
    expect(doc).toMatch(/preview/);
    expect(doc).toMatch(/atomic/);
    expect(doc).toMatch(/never (starts?|installs?)/i);
    // The bounded one-shot override stays --once-only and inbox-only.
    expect(doc).toContain("--once --force");
    expect(doc).toMatch(/non-persistent/i);
    expect(doc).not.toMatch(/master and inbox/i);
  });
});
