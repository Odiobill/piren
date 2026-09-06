import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readVersion } from "../src/version.js";

/**
 * Scoped @odiobill/piren registry releases.
 *
 * The canonical npm package identity is @odiobill/piren (the unscoped piren
 * name was rejected by npm's similarity policy); the executable bin stays
 * `piren`. After ADR-0037, `@odiobill/piren@0.1.3` was published to npm
 * `latest` via the sole one-time manual bootstrap (it may lack OIDC
 * provenance), `@odiobill/piren@0.1.4` was published through the trusted
 * OIDC workflow with a SLSA provenance attestation, and
 * `@odiobill/piren@0.1.5` (ADR-0038 scheduler safety) was published through
 * the same protected tag-only OIDC workflow from immutable tag `v0.1.5`.
 * `@odiobill/piren@0.1.6` (ADR-0040 transport maturity) was published through
 * the same protected tag-only OIDC workflow from immutable tag `v0.1.6`.
 * `@odiobill/piren@0.1.7` restores Discord gateway availability after transient
 * WebSocket disconnects through the same protected OIDC workflow from `v0.1.7`.
 * `0.2.5` is the current public release (Workbench-associated workflow budget
 * retention/control in Context telemetry, safe interactive model fallback,
 * steward-alert lifecycle/workbench/archive compatibility, task/session/alert
 * confirmed archive plus inspection, and coherent premium Workbench
 * presentation). `0.2.4` remains the recovery publication carrying all
 * accepted 0.2.3 work — durable Conversation workflow budgets, bounded gateway
 * workflow routes, Workbench workflow surfaces, canonical message copy,
 * scheduler agent scope — plus the test-only CI release-readiness
 * stabilization and the fail-closed pretag verification lane. `0.2.2` was
 * published through the normal OIDC path.
 * `v0.2.0` (incomplete committed artifact), `v0.2.1` (failed CI test gate), and
 * `v0.2.3` (immutable unpublished candidate whose publish-path verification
 * failed its unit gate) were tagged but never published; all are
 * superseded and must never be moved, recreated, or published. These guards keep package metadata,
 * version, and changelog truthful across the manual-bootstrap 0.1.3 and later
 * OIDC releases.
 */

const repoRoot = process.cwd();

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

describe("scoped @odiobill/piren releases (0.2.5 public release; 0.2.4/0.2.2/0.1.7/0.1.6/0.1.5/0.1.4 OIDC; 0.1.3 bootstrap; 0.2.3/0.2.1/0.2.0 unpublished)", () => {
  it("package.json name is the scoped @odiobill/piren identity", () => {
    const pkg = JSON.parse(read("package.json")) as { name: string };
    expect(pkg.name).toBe("@odiobill/piren");
  });

  it("package.json version is the public 0.2.5 release", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(pkg.version).toBe("0.2.5");
  });

  it("the executable bin name stays piren (scoped package, unchanged command)", () => {
    const pkg = JSON.parse(read("package.json")) as { bin?: Record<string, string> };
    expect(pkg.bin?.piren).toBe("dist/src/cli.js");
  });

  it("package.json declares canonical npm provenance repository metadata", () => {
    const pkg = JSON.parse(read("package.json")) as {
      repository?: { type?: string; url?: string };
    };
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/Odiobill/piren.git",
    });
  });

  it("package is publishable (private is absent or false)", () => {
    const pkg = JSON.parse(read("package.json")) as { private?: unknown };
    expect(pkg.private === undefined || pkg.private === false).toBe(true);
  });

  it("readVersion reports 0.2.5 from the real package.json", () => {
    expect(readVersion(join(repoRoot, "package.json"))).toBe("0.2.5");
  });

  it("package-lock.json name and version agree with package.json", () => {
    const lock = JSON.parse(read("package-lock.json")) as {
      name?: string;
      version?: string;
      packages?: Record<string, { name?: string; version?: string }>;
    };
    expect(lock.name).toBe("@odiobill/piren");
    expect(lock.version).toBe("0.2.5");
    expect(lock.packages?.[""]?.name).toBe("@odiobill/piren");
    expect(lock.packages?.[""]?.version).toBe("0.2.5");
  });

  it("CHANGELOG has a dated public [0.2.5] entry above [0.2.4]", () => {
    const cl = read("CHANGELOG.md");
    const start = cl.indexOf("## [0.2.5]");
    const next = cl.indexOf("## [0.2.4]");
    expect(start).toBeGreaterThan(-1);
    expect(next).toBeGreaterThan(start);
    const section = cl.slice(start, next);
    expect(section).toMatch(/## \[0\.2\.5\] - 2026-09-06/);
    expect(section).toMatch(/workflow budget/i);
    expect(section).toMatch(/model fallback/i);
    expect(section).toMatch(/steward alert/i);
    expect(section).toMatch(/terminal tasks[^\n]*confirmed archive/i);
    expect(section).toMatch(/session summaries[^\n]*archive (foundations|core)/i);
    expect(section).not.toMatch(/tasks, sessions, and steward alerts support a confirmed archive action/i);
    expect(section).toMatch(/Workbench/i);
    expect(section).toMatch(/scheduler/i);
    expect(section).not.toMatch(/not yet tagged or published|unreleased|internal pilot|candidate/i);
  });

  it("README describes the Steward Alerts Workbench as an explicit close surface, not a read-only surface", () => {
    const readme = read("README.md");
    expect(readme).toMatch(/Steward alerts:[^\n]*explicit Workbench close lifecycle/i);
    expect(readme).not.toMatch(/Steward alerts:[^\n]*read-only Workbench surface/i);
    expect(readme).toMatch(/Web workbench:[^\n]*Steward Alerts with explicit close lifecycle/i);
  });

  it("CHANGELOG retains the dated public [0.2.4] recovery entry above [0.2.3]", () => {
    const cl = read("CHANGELOG.md");
    const start = cl.indexOf("## [0.2.4]");
    const next = cl.indexOf("## [0.2.3]");
    expect(start).toBeGreaterThan(-1);
    expect(next).toBeGreaterThan(start);
    const section = cl.slice(start, next);
    expect(section).toMatch(/## \[0\.2\.4\] - 2026-08-30/);
    expect(section).toMatch(/recovers publication|recovery/i);
    expect(section).toMatch(/budget/i);
    expect(section).toMatch(/Workbench/i);
    expect(section).toMatch(/scheduler/i);
    expect(section).toMatch(/copy/i);
    expect(section).toMatch(/test-only/i);
    expect(section).toMatch(/preflight/i);
    expect(section).not.toMatch(/not yet tagged or published|unreleased|internal pilot/i);
  });

  it("CHANGELOG records v0.2.3 as an immutable unpublished verification-failed candidate", () => {
    const cl = read("CHANGELOG.md");
    const start = cl.indexOf("## [0.2.3]");
    const next = cl.indexOf("## [0.2.2]");
    expect(start).toBeGreaterThan(-1);
    expect(next).toBeGreaterThan(start);
    const section = cl.slice(start, next);
    expect(section).toMatch(/unpublished/i);
    expect(section).toMatch(/immutable/i);
    expect(section).toMatch(/superseded/i);
    expect(section).toMatch(/verification|test|CI/i);
  });

  it("CHANGELOG retains the dated public [0.2.2] entry", () => {
    const cl = read("CHANGELOG.md");
    const start = cl.indexOf("## [0.2.2]");
    const next = cl.indexOf("## [0.2.1]");
    expect(start).toBeGreaterThan(-1);
    expect(next).toBeGreaterThan(start);
    const section = cl.slice(start, next);
    expect(section).toMatch(/## \[0\.2\.2\] - 2026-08-26/);
    expect(section).toMatch(/Workbench/i);
    expect(section).toMatch(/model fallback/i);
    expect(section).toMatch(/scheduler/i);
    expect(section).not.toMatch(/not yet tagged or published|unreleased|internal pilot/i);
  });

  it("CHANGELOG records v0.2.0 as an unpublished superseded candidate", () => {
    const cl = read("CHANGELOG.md");
    const start = cl.indexOf("## [0.2.0]");
    const next = cl.indexOf("## [0.1.7]");
    expect(start).toBeGreaterThan(-1);
    expect(next).toBeGreaterThan(start);
    const section = cl.slice(start, next);
    expect(section).toMatch(/unpublished/i);
    expect(section).toMatch(/superseded/i);
    expect(section).toMatch(/incomplete/i);
  });

  it("CHANGELOG records v0.2.1 as an unpublished failed test-gate candidate", () => {
    const cl = read("CHANGELOG.md");
    const start = cl.indexOf("## [0.2.1]");
    const next = cl.indexOf("## [0.2.0]");
    expect(start).toBeGreaterThan(-1);
    expect(next).toBeGreaterThan(start);
    const section = cl.slice(start, next);
    expect(section).toMatch(/unpublished/i);
    expect(section).toMatch(/superseded/i);
    expect(section).toMatch(/test|verification|CI/i);
  });

  it("CHANGELOG has a dated published [0.1.7] Discord reconnect entry with OIDC provenance", () => {
    const cl = read("CHANGELOG.md");
    const start = cl.indexOf("## [0.1.7]");
    const end = cl.indexOf("## [0.1.6]");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = cl.slice(start, end);
    expect(section).toMatch(/## \[0\.1\.7\] - 2026-08-02/);
    expect(section).toMatch(/Discord gateway/i);
    expect(section).toMatch(/reconnect/i);
    expect(section).toMatch(/published/i);
    expect(section).toMatch(/npm `latest`/);
    expect(section).toMatch(/OIDC/);
    expect(section).toMatch(/provenance/i);
    expect(section).not.toMatch(/not yet tagged or published|prepared release candidate|unreleased/i);
  });

  it("CHANGELOG retains a dated [0.1.6] entry recording OIDC publication with provenance", () => {
    const cl = read("CHANGELOG.md");
    const start = cl.indexOf("## [0.1.6]");
    const end = cl.indexOf("## [0.1.5]");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = cl.slice(start, end);
    expect(section).toMatch(/## \[0\.1\.6\] - 2026-08-01/);
    expect(section).toMatch(/ADR-0040/);
    expect(section).toMatch(/D4|three-host/i);
    expect(section).toMatch(/published/i);
    expect(section).toMatch(/npm `latest`/);
    expect(section).toMatch(/OIDC/);
    expect(section).toMatch(/provenance/i);
    expect(section).not.toMatch(/not yet tagged or published|prepared release candidate|unreleased/i);
  });

  it("CHANGELOG has dated published [0.1.4] and [0.1.3] entries", () => {
    const cl = read("CHANGELOG.md");
    expect(cl).toMatch(/## \[0\.1\.4\] - 2026-07-20/);
    expect(cl).not.toMatch(/## \[0\.1\.4\] - unreleased/);
    expect(cl).toMatch(/## \[0\.1\.3\] - 2026-07-20/);
  });

  it("the [0.1.4] entry records OIDC publication and SLSA provenance", () => {
    const cl = read("CHANGELOG.md");
    const start = cl.indexOf("## [0.1.4]");
    const end = cl.indexOf("## [0.1.3]");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = cl.slice(start, end);
    expect(section).toMatch(/published/i);
    expect(section).toMatch(/OIDC/i);
    expect(section).toMatch(/SLSA provenance/i);
    expect(section).not.toMatch(/not yet published|no provenance attestation/i);
  });

  it("the [0.1.3] entry describes the ADR-0037 published manual bootstrap and disclaims OIDC provenance", () => {
    const cl = read("CHANGELOG.md");
    const start = cl.indexOf("## [0.1.3]");
    const end = cl.indexOf("## [0.1.2]");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = cl.slice(start, end);
    expect(section).toMatch(/ADR-0037/);
    expect(section).toMatch(/bootstrap/i);
    expect(section).toMatch(/2FA/);
    expect(section).toMatch(/\bPublished\b/i);
    // The manual bootstrap may lack OIDC provenance; no attestation is claimed.
    expect(section).toMatch(/may lack OIDC provenance|no provenance attestation is claimed/i);
  });

  it("retains a compact [0.1.2] audit entry: unpublished candidate rejected by npm similarity", () => {
    const cl = read("CHANGELOG.md");
    const start = cl.indexOf("## [0.1.2]");
    const end = cl.indexOf("## [0.1.1]");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = cl.slice(start, end);
    expect(section).toMatch(/unpublished/i);
    expect(section).toMatch(/reject|similarity|E403/i);
    expect(section).toMatch(/ADR-0037/);
  });

  it("retains a compact [0.1.1] audit entry as an unpublished failed candidate", () => {
    const cl = read("CHANGELOG.md");
    const start = cl.indexOf("## [0.1.1]");
    const end = cl.indexOf("## [0.1.0]");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = cl.slice(start, end);
    expect(section).toMatch(/unpublished/i);
    expect(section).toMatch(/fail/i);
  });
});
