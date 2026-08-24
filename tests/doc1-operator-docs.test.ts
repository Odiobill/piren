import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * DOC-1 operator-docs contract (0.2): current public documentation must tell
 * the truth about the delivered scheduler authority model, the force/dry-run
 * boundaries, the three-tab typed Settings surface, the session_start_only
 * core context-injection default, and the closed Agent Groups workflows.
 * A grep sweep keeps stale current-tense master-gate wording from silently
 * reappearing in repository docs.
 */

const root = process.cwd();

async function read(rel: string): Promise<string> {
  try {
    return await readFile(join(root, rel), "utf8");
  } catch {
    return "";
  }
}

describe("DOC-1: scheduler authority and operation docs", () => {
  let scheduler = "";
  let configuration = "";

  it("setup", async () => {
    scheduler = await read("docs/scheduler.md");
    configuration = await read("docs/configuration.md");
    expect(scheduler).not.toBe("");
    expect(configuration).not.toBe("");
  });

  it("names the three automation classes as the sole ordinary execution gates", async () => {
    const doc = await read("docs/scheduler.md");
    expect(doc).toMatch(/sole|only/i);
    expect(doc).toContain("automation.inbox_tasks");
    expect(doc).toContain("automation.agent_cron");
    expect(doc).toContain("automation.script_cron");
    // Supervision is distinct and inert when every class is disabled.
    expect(doc).toMatch(/supervision[^\n]*(inert|distinct)|inert[^\n]*supervisor/i);
  });

  it("documents fail-closed legacy handling: enabled true inert, false/malformed gated until confirmed configure migration", async () => {
    const doc = await read("docs/scheduler.md");
    expect(doc).toMatch(/retired scheduler\.enabled key present with value true; inert-to-ignore/i);
    expect(doc).toMatch(/legacy gate:[^\n]*fail closed/i);
    expect(doc).toMatch(/configure[^\n]*(migration|removes the stale)/i);
    // Settings and doctor never migrate the legacy gate.
    expect(doc).toMatch(/(Settings|doctor)[^\n]*never migrate|never migrate[^\n]*(Settings|doctor)/i);
  });

  it("documents --once --force as non-persistent inbox-only override", async () => {
    const doc = await read("docs/scheduler.md");
    expect(doc).toMatch(/--once --force/);
    expect(doc).toMatch(/non-persistent/i);
    expect(doc).toMatch(/inbox automation override|overrides?[^\n]*only[^\n]*inbox/i);
    expect(doc).toMatch(/never[^\n]*(cron|legacy gat)/i);
  });

  it("documents --dry-run as read-only and discovery-complete for a disabled inbox class", async () => {
    const doc = await read("docs/scheduler.md");
    expect(doc).toMatch(/--dry-run/);
    expect(doc).toMatch(/read-only/i);
    expect(doc).toContain("[DISABLED]");
    expect(doc).toMatch(/no claim proposed|discovery/i);
  });
});

describe("DOC-1: Settings surface and context default docs", () => {
  it("documents the welcoming three-tab Settings surface with in-memory-only state", async () => {
    const gateway = await read("docs/gateway.md");
    expect(gateway).toContain("This installation");
    expect(gateway).toContain("Agent settings");
    expect(gateway).toContain("Agent groups");
    expect(gateway).toMatch(/in-memory|no persistence|not persisted/i);
    expect(gateway).toMatch(/not a generic YAML|generic editor/i);
  });

  it("documents transport prefill, write-only tokens, runnable default-agent validation, static help", async () => {
    const gateway = await read("docs/gateway.md");
    expect(gateway).toMatch(/prefill|prefilled|pre-fills?/i);
    expect(gateway).toMatch(/write-only/i);
    expect(gateway).toMatch(/default agent[^\n]*(runnable|validated?)|runnable[^\n]*default agent/i);
    expect(gateway).toMatch(/static[^\n]*help|help[^\n]*static|bot setup/i);
  });

  it("documents durable future-launch agent settings and the truthful context default label", async () => {
    const gateway = await read("docs/gateway.md");
    expect(gateway).toMatch(/ordered[^\n]*fallback|fallback[^\n]*ordered/i);
    expect(gateway).toMatch(/explicit[^\n]*confirmation|confirmation[^\n]*modal/i);
    expect(gateway).toContain("Default (session_start_only)");
    const configuration = await read("docs/configuration.md");
    expect(configuration).toContain("Default (session_start_only)");
    expect(configuration).toMatch(/PIREN_CONTEXT_INJECTION/);
    expect(configuration).toMatch(/per_turn/);
  });

  it("documents the typed vault-owned Agent Groups boundary in configuration docs", async () => {
    const groups = await read("docs/agent-groups.md");
    const gateway = await read("docs/gateway.md");
    const combined = groups + "\n" + gateway;
    expect(combined).toMatch(/revision|conflict|409/i);
    expect(combined).toMatch(/confirm/i);
    expect(combined).toMatch(/[Nn]ot locally runnable/);
    expect(combined).toMatch(/allowed_agents|runnable policy/i);
    expect(combined).not.toMatch(/browser shell-out allowed|arbitrary vault editor/i);
  });
});

describe("DOC-1: API route docs", () => {
  it("documents the additive closed Groups routes without raw YAML or generic-write claims", async () => {
    const api = await read("docs/api.md");
    expect(api).toContain("/api/settings/groups");
    expect(api).toContain("/api/settings/groups/validation");
    expect(api).toMatch(/fallback-set/);
    expect(api).toMatch(/409/);
    expect(api).toMatch(/vault-defined|roster/i);
    expect(api).not.toMatch(/groups route[^\n]*raw YAML/i);
  });

  it("describes the scheduler projection without a master gate", async () => {
    const api = await read("docs/api.md");
    expect(api).toMatch(/GET \/api\/settings\/scheduler/);
    expect(api).toMatch(/legacyMasterGate|automation classes/i);
  });
});

describe("DOC-1: stale-language sweep over repository docs", () => {
  const CURRENT_DOCS = [
    "README.md",
    "docs/scheduler.md",
    "docs/configuration.md",
    "docs/api.md",
    "docs/gateway.md",
    "docs/getting-started.md",
    "docs/operations.md",
    "docs/service-management.md",
    "docs/troubleshooting.md",
    "docs/agent-groups.md",
    "docs/transports.md",
    "docs/security.md",
  ];

  it("keeps current-tense master-gate wording out of every repository doc", async () => {
    for (const rel of CURRENT_DOCS) {
      const text = await read(rel);
      expect(text, `${rel} must not contain 'master gate'`).not.toMatch(/master[\s-]+gate/i);
      expect(text, `${rel} must not enable the retired key as a gate`).not.toMatch(
        /enabled:\s*true\s*#\s*master/i,
      );
      expect(text, `${rel} must not claim the force override opens the master gate`).not.toMatch(
        /master and inbox gates/i,
      );
    }
  });

  it("configuration.md never claims per_turn is the default any more", async () => {
    const configuration = await read("docs/configuration.md");
    expect(configuration).not.toMatch(/The default remains `per_turn`/);
    expect(configuration).not.toMatch(/mode: per_turn\s+# default/);
    expect(configuration).toMatch(/absent[^.\n]*`context_injection`[^.\n]*session_start_only|session_start_only[^.\n]*core default/i);
  });
});
