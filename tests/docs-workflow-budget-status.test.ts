import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * B7 — static documentation contract for the workflow-budget and per-agent
 * status surface. Factual presence checks on the public operator docs only:
 * the three authenticated Conversation routes, the closed POST body
 * (absolute strictly-raising targets, fixed caps/depth, no clamping, CAS
 * conflict), and the Workbench authority/no-polling boundaries. This is not
 * an implementation snapshot — it pins what operators must be able to find.
 */

let api = "";
let gateway = "";

beforeAll(async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  api = await readFile(join(repoRoot, "docs", "api.md"), "utf8");
  gateway = await readFile(join(repoRoot, "docs", "gateway.md"), "utf8");
});

describe("docs/api.md — the three workflow-budget/status routes are documented", () => {
  it("names all three authenticated Conversation routes", () => {
    expect(api).toContain("GET /api/conversations/<id>/agents/<agent>/workflow-status");
    expect(api).toContain("GET /api/conversations/<id>/workflow-budgets");
    expect(api).toContain("POST /api/conversations/<id>/workflow-budget");
  });

  it("documents the exact-pair status snapshot authority model", () => {
    // run_active is broker-authoritative and independent of workflow association.
    expect(api).toContain("run_active");
    // The server, not the browser, resolves the association; workflow:null is truthful.
    expect(api).toMatch(/workflow:\s*null|workflow: null/);
    expect(api).toContain("association");
    expect(api).toContain("404");
    expect(api).toContain("401");
    expect(api).toContain("400");
    expect(api).toContain("500");
  });

  it("documents the bounded budgets read (total/omitted, warnings, association map)", () => {
    expect(api).toContain("total");
    expect(api).toContain("omitted");
    expect(api).toContain("warnings");
  });

  it("documents the closed POST body with absolute strictly-raising targets and fixed caps/depth", () => {
    expect(api).toContain("root_event_id");
    expect(api).toContain("edges");
    expect(api).toContain("rework_rounds");
    expect(api).toContain("expected_effective");
    expect(api).toContain("strictly raise");
    expect(api).toContain("24");
    expect(api).toContain("6");
    expect(api).toContain("depth 3");
    // No clamping / no unlimited / no refill / no configuration override.
    expect(api).toMatch(/[Nn]ever\s+(?:a\s+)?(?:silent\s+)?clamp|no clamping/);
    expect(api).toMatch(/no (?:configuration |config )?override|never.{0,40}configur(?:ation|able)/);
    expect(api).toContain("409");
  });

  it("states the update never dispatches or touches a pending gate", () => {
    expect(api).toMatch(/never dispatch/);
    expect(api).toContain("gate");
  });
});

describe("docs/gateway.md — Workbench budget control and card status boundaries", () => {
  it("documents the Conversation Details Workflow budget section", () => {
    expect(gateway).toContain("Workflow budget");
    // Root-scoped durable facts; zero workflows render no fabricated budget.
    expect(gateway).toMatch(/root-scoped|per root|each root/);
    expect(gateway).toMatch(/[Zz]ero(?:\s+\w+)*\s+workflow/);
  });

  it("documents explicit Save with CAS re-read and manual-only retry", () => {
    expect(gateway).toMatch(/CAS|compare-and-set|expected effective/i);
    expect(gateway).toContain("Retry");
    expect(gateway).toMatch(/[Nn]o (?:hidden|automatic) retry/);
  });

  it("documents the per-agent card status meaning and fixed precedence", () => {
    expect(gateway).toMatch(/[Rr]ed/);
    expect(gateway).toContain("exhausted");
    expect(gateway).toMatch(/[Yy]ellow/);
    expect(gateway).toContain("low");
    expect(gateway).toMatch(/[Bb]usy/);
    expect(gateway).toContain("precedence");
    // Busy includes the no-workflow agent-first active run.
    expect(gateway).toMatch(/without an (?:associated )?workflow|no associated workflow|workflow: null/i);
  });

  it("documents the explicit status-read moments and the no-polling/no-persistence/no-browser-derivation boundaries", () => {
    expect(gateway).toMatch(/attach|selection/i);
    expect(gateway).toMatch(/[Dd]etails modal|details modal/);
    expect(gateway).toContain("polling");
    expect(gateway).toMatch(/[Nn]o browser (?:persistence|storage)|never persists to the browser|in-memory only/);
    expect(gateway).toMatch(/never (?:derived|inferred|chosen) (?:by|in) the browser|browser never/);
  });

  it("keeps workflow budgets distinct from per-agent budgets and Pi context telemetry", () => {
    expect(gateway).toContain("per-agent");
    expect(gateway).toContain("Context");
    expect(gateway).toMatch(/Pi context|context telemetry/i);
  });
});

describe("README.md — live activity vs workflow-status sourcing (B7 correction)", () => {
  it("no longer claims status cards come only from the live stream", async () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const readme = await readFile(join(repoRoot, "README.md"), "utf8");
    // The stale B7-review claim: workflow status is NOT stream-only after B6.
    expect(readme).not.toMatch(/status cards are transient, come only from the live stream/);
  });

  it("pins the truthful separation: live activity from the stream; workflow status from explicit gateway snapshots with interim activity, no persistence", async () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const readme = await readFile(join(repoRoot, "README.md"), "utf8");
    // Live activity cards: live-stream transient state, never reconstructed.
    expect(readme).toMatch(/[Ll]ive activity cards are transient/);
    expect(readme).toContain("never reconstructed from history");
    // Workflow-status indicators: session-only gateway snapshots + interim activity.
    expect(readme).toMatch(/workflow-status/);
    expect(readme).toMatch(/[Ss]napshot/);
    expect(readme).toMatch(/[Ll]ive activity/);
    expect(readme).toMatch(/[Nn]o (?:browser )?polling/);
    expect(readme).toMatch(/[Nn]o browser persistence|never (?:written|persisted) (?:to|in) the browser|in browser memory only/);
  });
});

describe("README.md + docs/gateway.md — W4 copy control on durable message cards", () => {
  it("documents the copy control scope, canonical body, native-only clipboard, and no durable effect", async () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const readme = await readFile(join(repoRoot, "README.md"), "utf8");
    const gateway = await readFile(join(repoRoot, "docs", "gateway.md"), "utf8");
    // Control scope: ordinary durable message cards only.
    expect(readme).toMatch(/copy/i);
    expect(gateway).toContain("message");
    // Canonical payload including Markdown source — never a rendered projection.
    expect(gateway).toContain("canonical");
    expect(gateway).toContain("Markdown source");
    // Native Clipboard API only; no fallback.
    expect(gateway).toContain("Clipboard API");
    expect(gateway).toContain("fallback");
    // Bounded per-card feedback; no persistence/telemetry/durable effect.
    expect(gateway).toContain("feedback");
    expect(gateway).toMatch(/2 seconds|two seconds/i);
    expect(gateway).toMatch(/[Nn]o (?:browser )?persistence|never persists/);
    // No copy control on handoff/evidence rows (binding exclusion).
    expect(gateway).toContain("handoff");
    expect(gateway).toMatch(/no copy control|excluded/);
  });
});
