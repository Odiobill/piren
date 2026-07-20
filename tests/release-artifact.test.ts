import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readVersion } from "../src/version.js";

/**
 * ADR-0037 P3e: scoped @odiobill/piren recovery candidate (0.1.3).
 *
 * The canonical npm package identity is @odiobill/piren (the unscoped piren
 * name was rejected by npm's similarity policy); the executable bin stays
 * `piren`. This is preparation only: scoped metadata, a 0.1.3 version bump,
 * and a truthful changelog with a pending [0.1.3] scoped replacement entry plus
 * compact [0.1.2]/[0.1.1] unpublished-candidate audits. No tag, publish, or
 * configuration is represented here.
 */

const repoRoot = process.cwd();

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

describe("ADR-0037 P3e: scoped @odiobill/piren 0.1.3 recovery candidate", () => {
  it("package.json name is the scoped @odiobill/piren identity", () => {
    const pkg = JSON.parse(read("package.json")) as { name: string };
    expect(pkg.name).toBe("@odiobill/piren");
  });

  it("package.json version is 0.1.3", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(pkg.version).toBe("0.1.3");
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

  it("readVersion reports 0.1.3 from the real package.json", () => {
    expect(readVersion(join(repoRoot, "package.json"))).toBe("0.1.3");
  });

  it("package-lock.json name and version agree with package.json", () => {
    const lock = JSON.parse(read("package-lock.json")) as {
      name?: string;
      version?: string;
      packages?: Record<string, { name?: string; version?: string }>;
    };
    expect(lock.name).toBe("@odiobill/piren");
    expect(lock.version).toBe("0.1.3");
    expect(lock.packages?.[""]?.name).toBe("@odiobill/piren");
    expect(lock.packages?.[""]?.version).toBe("0.1.3");
  });

  it("CHANGELOG has a pending [0.1.3] scoped replacement entry (not dated as released)", () => {
    const cl = read("CHANGELOG.md");
    expect(cl).toMatch(/## \[0\.1\.3\]/);
    expect(cl).not.toMatch(/## \[0\.1\.3\] - \d{4}-\d{2}-\d{2}/);
  });

  it("the [0.1.3] entry describes the ADR-0037 scoped bootstrap without claiming success", () => {
    const cl = read("CHANGELOG.md");
    const start = cl.indexOf("## [0.1.3]");
    const end = cl.indexOf("## [0.1.2]");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = cl.slice(start, end);
    expect(section).toMatch(/ADR-0037/);
    expect(section).toMatch(/bootstrap/i);
    expect(section).toMatch(/2FA/);
    expect(section).toMatch(/provenance/i);
    // No registry install command is presented as available for this release.
    expect(section).not.toMatch(/npm install -g (?:@odiobill\/piren|piren)\b/);
    // No completed-state claim (pre-publication bootstrap).
    expect(section).not.toMatch(/first registry artifact/i);
    expect(section).not.toMatch(/\bpublished\b/i);
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
