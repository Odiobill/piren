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
 * provenance). The current development version is the `0.1.4` registry-cutover
 * candidate: source-only, not yet published, no provenance attestation. These
 * guards keep the package metadata, version, and changelog truthful across the
 * published 0.1.3 and the pending 0.1.4 candidate. No tag, publish, or
 * configuration is represented here.
 */

const repoRoot = process.cwd();

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

describe("scoped @odiobill/piren registry releases (0.1.4 candidate, 0.1.3 published)", () => {
  it("package.json name is the scoped @odiobill/piren identity", () => {
    const pkg = JSON.parse(read("package.json")) as { name: string };
    expect(pkg.name).toBe("@odiobill/piren");
  });

  it("package.json version is the 0.1.4 release candidate", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(pkg.version).toBe("0.1.4");
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

  it("readVersion reports 0.1.4 from the real package.json", () => {
    expect(readVersion(join(repoRoot, "package.json"))).toBe("0.1.4");
  });

  it("package-lock.json name and version agree with package.json", () => {
    const lock = JSON.parse(read("package-lock.json")) as {
      name?: string;
      version?: string;
      packages?: Record<string, { name?: string; version?: string }>;
    };
    expect(lock.name).toBe("@odiobill/piren");
    expect(lock.version).toBe("0.1.4");
    expect(lock.packages?.[""]?.name).toBe("@odiobill/piren");
    expect(lock.packages?.[""]?.version).toBe("0.1.4");
  });

  it("CHANGELOG has an unreleased [0.1.4] candidate and a dated published [0.1.3]", () => {
    const cl = read("CHANGELOG.md");
    // [0.1.4] is the unreleased candidate, not dated as a release.
    expect(cl).toMatch(/## \[0\.1\.4\] - unreleased/);
    expect(cl).not.toMatch(/## \[0\.1\.4\] - \d{4}-\d{2}-\d{2}/);
    // [0.1.3] is dated as the published manual bootstrap.
    expect(cl).toMatch(/## \[0\.1\.3\] - 2026-07-20/);
  });

  it("the [0.1.4] candidate does not claim to be published, verified, or provenance-attested", () => {
    const cl = read("CHANGELOG.md");
    const start = cl.indexOf("## [0.1.4]");
    const end = cl.indexOf("## [0.1.3]");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = cl.slice(start, end);
    expect(section).toMatch(/not yet published/i);
    expect(section).toMatch(/no provenance attestation/i);
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
