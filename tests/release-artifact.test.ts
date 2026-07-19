import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readVersion } from "../src/version.js";

/**
 * ADR-0033 P3a: repository release-preparation artifact for the one-time
 * ADR-0035 bootstrap publication of piren@0.1.1.
 *
 * This is preparation only: the version bump, npm provenance repository
 * metadata, lockfile agreement, runtime version read, and an unreleased
 * CHANGELOG entry that does not claim publication, OIDC provenance for 0.1.1,
 * or an existing registry install path. No tag, publish, or configuration is
 * represented here.
 */

const repoRoot = process.cwd();

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

describe("ADR-0033 P3a: 0.1.1 release-preparation artifact", () => {
  it("package.json version is 0.1.1", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(pkg.version).toBe("0.1.1");
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

  it("readVersion reports 0.1.1 from the real package.json", () => {
    expect(readVersion(join(repoRoot, "package.json"))).toBe("0.1.1");
  });

  it("package-lock.json version agrees with package.json (0.1.1)", () => {
    const lock = JSON.parse(read("package-lock.json")) as {
      version?: string;
      packages?: Record<string, { version?: string }>;
    };
    expect(lock.version).toBe("0.1.1");
    expect(lock.packages?.[""]?.version).toBe("0.1.1");
  });

  it("CHANGELOG has an unreleased [0.1.1] entry", () => {
    const cl = read("CHANGELOG.md");
    expect(cl).toMatch(/## \[0\.1\.1\]/);
    // Not dated as a released version (no release-date claim).
    expect(cl).not.toMatch(/## \[0\.1\.1\] - \d{4}-\d{2}-\d{2}/);
  });

  it("the [0.1.1] changelog entry does not claim publication, provenance, or a registry install path", () => {
    const cl = read("CHANGELOG.md");
    const start = cl.indexOf("## [0.1.1]");
    const end = cl.indexOf("## [0.1.0]");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = cl.slice(start, end);
    // Explicitly states it is not yet published.
    expect(section).toMatch(/not (?:yet )?published|unreleased/i);
    // Does not present a registry install command as already available.
    expect(section).not.toMatch(/npm install -g piren\b/);
    // Does not state 0.1.1 itself is published or provenance-backed.
    expect(section).not.toMatch(/0\.1\.1 (?:is |has been )(?:published|provenance)/i);
  });
});
