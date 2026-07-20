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

describe("ADR-0036 P3c: 0.1.2 replacement release-preparation artifact", () => {
  it("package.json version is 0.1.2", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(pkg.version).toBe("0.1.2");
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

  it("readVersion reports 0.1.2 from the real package.json", () => {
    expect(readVersion(join(repoRoot, "package.json"))).toBe("0.1.2");
  });

  it("package-lock.json version agrees with package.json (0.1.2)", () => {
    const lock = JSON.parse(read("package-lock.json")) as {
      version?: string;
      packages?: Record<string, { version?: string }>;
    };
    expect(lock.version).toBe("0.1.2");
    expect(lock.packages?.[""]?.version).toBe("0.1.2");
  });

  it("CHANGELOG has a pending [0.1.2] replacement entry (not dated as released)", () => {
    const cl = read("CHANGELOG.md");
    expect(cl).toMatch(/## \[0\.1\.2\]/);
    expect(cl).not.toMatch(/## \[0\.1\.2\] - \d{4}-\d{2}-\d{2}/);
  });

  it("the [0.1.2] entry describes the ADR-0036 replacement bootstrap without claiming success", () => {
    const cl = read("CHANGELOG.md");
    const start = cl.indexOf("## [0.1.2]");
    const end = cl.indexOf("## [0.1.1]");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = cl.slice(start, end);
    expect(section).toMatch(/ADR-0036/);
    expect(section).toMatch(/bootstrap/i);
    expect(section).toMatch(/2FA/);
    expect(section).toMatch(/provenance/i);
    expect(section).not.toMatch(/npm install -g piren\b/);
    expect(section).not.toMatch(/first registry artifact/i);
    expect(section).not.toMatch(/\bpublished\b/i);
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
