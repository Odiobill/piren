import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSessionSummary } from "../src/session.js";

let root: string;
let vault: string;
let agentDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-session-"));
  vault = join(root, "vault");
  agentDir = join(vault, "team", "thor");
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await writeFile(join(vault, ".piren-vault"), "");
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("session summaries", () => {
  it("writes a timestamped Markdown session summary under the selected agent", async () => {
    const result = await writeSessionSummary({
      vaultRoot: vault,
      agentName: "thor",
      agentDir,
      title: "Fix Bootstrap",
      summary: "Resolved bootstrap config edge cases.",
      now: () => new Date("2026-06-22T12:30:45.000Z"),
    });

    expect(result.path).toBe("team/thor/sessions/20260622T123045Z-fix-bootstrap.md");
    expect(result.timestamp).toBe("2026-06-22T12:30:45.000Z");
    const content = await readFile(join(vault, result.path), "utf8");
    expect(content).toContain("type: session-summary");
    expect(content).toContain("agent: thor");
    expect(content).toContain("# Fix Bootstrap");
    expect(content).toContain("Resolved bootstrap config edge cases.");
  });

  it("rejects empty session summaries", async () => {
    await expect(writeSessionSummary({
      vaultRoot: vault,
      agentName: "thor",
      agentDir,
      summary: "   ",
    })).rejects.toThrow(/summary is required/i);
  });
});
