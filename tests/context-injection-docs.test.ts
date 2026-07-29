import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Operator-docs contract for the context-injection runtime preference (C3).
 * Prevents stale claims: the exact YAML schema, the per_turn default, the
 * session_start_only semantics, the PIREN_CONTEXT_INJECTION measurement
 * override, the invalid-value fallback, and piren_status visibility must be
 * documented, and the docs must never claim session_start_only is the default
 * or that the preference is a Web UI setting.
 */

const root = process.cwd();

function read(rel: string): string {
  return existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : "";
}

const CONFIGURATION = read("docs/configuration.md");

describe("context-injection operator docs", () => {
  it("documents the exact YAML schema in team/<agent>/config.yml", () => {
    expect(CONFIGURATION).toContain("context_injection:");
    expect(CONFIGURATION).toContain("mode: per_turn");
    expect(CONFIGURATION).toContain("session_start_only");
    expect(CONFIGURATION).toContain("team/<agent>/config.yml");
  });

  it("documents per_turn as the default", () => {
    expect(CONFIGURATION).toMatch(/default[^\n]*per_turn|per_turn[^\n]*default/i);
  });

  it("documents session reload/new/resume as the freshness boundary", () => {
    expect(CONFIGURATION).toMatch(/resume/i);
    expect(CONFIGURATION).toMatch(/reload|restart/i);
  });

  it("documents the PIREN_CONTEXT_INJECTION measurement override and invalid-value fallback", () => {
    expect(CONFIGURATION).toContain("PIREN_CONTEXT_INJECTION");
    expect(CONFIGURATION).toMatch(/invalid|unknown/i);
    expect(CONFIGURATION).toMatch(/fall(s)? back|fallback/i);
  });

  it("documents piren_status visibility", () => {
    expect(CONFIGURATION).toMatch(/piren_status[^\n]*context_injection|context_injection[^\n]*piren_status/i);
  });

  it("never claims session_start_only is the default", () => {
    expect(CONFIGURATION).not.toMatch(/default\s*(is|:|=)?\s*`?session_start_only/i);
    expect(CONFIGURATION).not.toMatch(/session_start_only[^\n]*\bis the default\b/i);
  });

  it("never presents the preference as a Web UI setting", () => {
    expect(CONFIGURATION).not.toMatch(/web ui[^\n]*context_injection|context_injection[^\n]*web ui/i);
  });
});
