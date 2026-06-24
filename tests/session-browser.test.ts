import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { listAgentSessions } from "../src/session-browser.js";

async function makeVault(): Promise<{ vault: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "piren-session-browser-"));
  const vault = join(root, "vault");
  const sessionsDir = join(vault, "team", "piren", "sessions");
  await mkdir(sessionsDir, { recursive: true });

  // Two session summaries with frontmatter. Filenames are timestamp-prefixed
  // (newest last alphabetically) to match session_write_summary output.
  await writeFile(
    join(sessionsDir, "20260622T120000Z-fix-bootstrap.md"),
    [
      "---",
      "type: session-summary",
      "agent: piren",
      "created: 2026-06-22T12:00:00.000Z",
      "---",
      "",
      "# Fix Bootstrap",
      "",
      "Resolved bootstrap config edge cases.",
    ].join("\n"),
  );
  await writeFile(
    join(sessionsDir, "20260623T090000Z-add-tests.md"),
    [
      "---",
      "type: session-summary",
      "agent: piren",
      "created: 2026-06-23T09:00:00.000Z",
      "---",
      "",
      "# Add Tests",
      "",
      "Added session resume tests.",
    ].join("\n"),
  );
  // A non-summary file (no frontmatter) should be included as-is with defaults.
  await writeFile(join(sessionsDir, "notes.md"), "# Raw notes\n");

  return {
    vault,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("listAgentSessions", () => {
  it("lists session summary files under team/<agent>/sessions/", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      const result = await listAgentSessions(vault, "piren");
      expect(result.sessions.length).toBe(3);
    } finally {
      await cleanup();
    }
  });

  it("parses frontmatter title and created date", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      const result = await listAgentSessions(vault, "piren");
      const addTests = result.sessions.find((s) => s.name === "20260623T090000Z-add-tests.md");
      expect(addTests).toBeDefined();
      expect(addTests?.title).toBe("Add Tests");
      expect(addTests?.created).toBe("2026-06-23T09:00:00.000Z");
    } finally {
      await cleanup();
    }
  });

  it("sorts sessions newest-first by filename", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      const result = await listAgentSessions(vault, "piren");
      expect(result.sessions[0]?.name).toBe("20260623T090000Z-add-tests.md");
      expect(result.sessions[1]?.name).toBe("20260622T120000Z-fix-bootstrap.md");
    } finally {
      await cleanup();
    }
  });

  it("returns the vault-relative path for each session", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      const result = await listAgentSessions(vault, "piren");
      const first = result.sessions[0];
      expect(first?.path).toBe("team/piren/sessions/20260623T090000Z-add-tests.md");
    } finally {
      await cleanup();
    }
  });

  it("returns an empty list when the sessions directory does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "piren-empty-"));
    const vault = join(root, "vault");
    await mkdir(join(vault, "team", "missing-agent"), { recursive: true });
    try {
      const result = await listAgentSessions(vault, "missing-agent");
      expect(result.sessions).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
