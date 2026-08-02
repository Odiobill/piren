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
 * The pending 0.1.7 patch restores Discord gateway availability after transient
 * WebSocket disconnects. These guards keep package metadata, version, and
 * changelog truthful across the manual-bootstrap 0.1.3 and later OIDC releases.
 */

const repoRoot = process.cwd();

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

describe("scoped @odiobill/piren registry releases (0.1.7 candidate; 0.1.6/0.1.5/0.1.4 OIDC; 0.1.3 bootstrap)", () => {
  it("package.json name is the scoped @odiobill/piren identity", () => {
    const pkg = JSON.parse(read("package.json")) as { name: string };
    expect(pkg.name).toBe("@odiobill/piren");
  });

  it("package.json version is the pending 0.1.7 Discord reconnect patch", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(pkg.version).toBe("0.1.7");
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

  it("readVersion reports 0.1.7 from the real package.json", () => {
    expect(readVersion(join(repoRoot, "package.json"))).toBe("0.1.7");
  });

  it("package-lock.json name and version agree with package.json", () => {
    const lock = JSON.parse(read("package-lock.json")) as {
      name?: string;
      version?: string;
      packages?: Record<string, { name?: string; version?: string }>;
    };
    expect(lock.name).toBe("@odiobill/piren");
    expect(lock.version).toBe("0.1.7");
    expect(lock.packages?.[""]?.name).toBe("@odiobill/piren");
    expect(lock.packages?.[""]?.version).toBe("0.1.7");
  });

  it("CHANGELOG has a dated unpublished [0.1.7] Discord reconnect candidate entry", () => {
    const cl = read("CHANGELOG.md");
    const start = cl.indexOf("## [0.1.7]");
    const end = cl.indexOf("## [0.1.6]");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = cl.slice(start, end);
    expect(section).toMatch(/## \[0\.1\.7\] - 2026-08-02/);
    expect(section).toMatch(/Discord gateway/i);
    expect(section).toMatch(/reconnect/i);
    expect(section).toMatch(/not yet tagged or published/i);
    expect(section).not.toMatch(/published as|npm `latest`|SLSA provenance/i);
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
