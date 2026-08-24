import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Operator-docs contract for the context-injection runtime preference (C3,
 * CI-1 default flip). Prevents stale claims: the exact YAML schema, the
 * session_start_only core default, the explicit per_turn opt-in, the
 * PIREN_CONTEXT_INJECTION measurement override, the invalid-value fallback,
 * and piren_status visibility must be documented, and the docs must never
 * claim per_turn is the default any more. The Workbench presentation is
 * contracted to the delivered typed Settings workflow over the same
 * vault-owned team/<agent>/config.yml file (0.2.0 scope amendment section
 * 5.1): never a live Pi-session control, a browser-persisted setting, a
 * generic editor, a provider-credential workflow, or an alternative
 * authority store.
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

  it("documents session_start_only as the core default with an explicit per_turn opt-in (CI-1)", () => {
    expect(CONFIGURATION).toMatch(/core default `session_start_only`/);
    expect(CONFIGURATION).toMatch(/declare `mode: per_turn` explicitly/);
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

  it("never claims per_turn is the default (CI-1 flipped it)", () => {
    expect(CONFIGURATION).not.toMatch(/default remains `per_turn`/i);
    expect(CONFIGURATION).not.toMatch(/mode: per_turn\s*#\s*default/);
  });

  it("documents the preference as vault-owned, with only the delivered typed Settings workflow in the Workbench", () => {
    // Remains a vault-owned team/<agent>/config.yml preference.
    expect(CONFIGURATION).toMatch(/context_injection/);
    expect(CONFIGURATION).toContain("team/<agent>/config.yml");
    // The Workbench Settings page may expose only the delivered typed
    // workflow for that same preference over the same file.
    expect(CONFIGURATION).toMatch(/Workbench Settings page[^\n]*typed workflow|typed workflow[^\n]*Workbench Settings page/i);
    // It must never be described as a live Pi-session control, a
    // browser-persisted setting, a generic editor, a provider-credential
    // workflow, or an alternative authority store.
    expect(CONFIGURATION).not.toMatch(/context_injection[^\n]*live (Pi )?session|live (Pi )?session[^\n]*context_injection/i);
    expect(CONFIGURATION).not.toMatch(/context_injection[^\n]*browser[- ](storage|persist)|browser[- ](storage|persist)[^\n]*context_injection/i);
    expect(CONFIGURATION).not.toMatch(/context_injection[^\n]*generic editor|generic editor[^\n]*context_injection/i);
    expect(CONFIGURATION).not.toMatch(/context_injection[^\n]*provider credential|provider credential[^\n]*context_injection/i);
    expect(CONFIGURATION).not.toMatch(/context_injection[^\n]*(alternative authority|authority store)|(alternative authority|authority store)[^\n]*context_injection/i);
  });
});
