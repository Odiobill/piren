import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ADR-0033 R2: static contract for the release-artifact verification workflow.
 *
 * This is a verification scaffold, NOT a publication pipeline. It proves the
 * checked-out tag source produces a releasable npm artifact (quality gates +
 * packed-tarball clean-install) without ever publishing or minting provenance.
 *
 * Assertions are intentionally YAML-format-tolerant: the workflow is read as
 * text, whitespace (including newlines) is collapsed to single spaces, and
 * substring/regex checks are used instead of coupling to incidental line
 * layout. Security-critical forbidden strings are checked against the raw text.
 */

const workflowPath = join(process.cwd(), ".github", "workflows", "release-verify.yml");

function readWorkflow(): string {
  return readFileSync(workflowPath, "utf8");
}

/** Collapse all whitespace runs (including newlines) to single spaces so
 *  assertions survive YAML reformatting. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ");
}

describe("ADR-0033 R2: release-artifact verification workflow", () => {
  let raw: string;
  let blob: string;

  beforeAll(() => {
    raw = readWorkflow();
    blob = normalize(raw);
  });

  it("ships a named workflow file at .github/workflows/release-verify.yml", () => {
    expect(raw.length).toBeGreaterThan(0);
    expect(blob).toMatch(/\bname:/);
  });

  describe("trigger", () => {
    it("runs on version-tag push and supports manual dispatch", () => {
      expect(blob).toMatch(/\bon:/);
      expect(blob).toMatch(/\bpush\b/);
      expect(blob).toMatch(/\btags\b/);
      // at least one tag glob is version-prefixed (v* / v** / v[0-9]*)
      expect(blob).toMatch(/v\*+|v\[0-9\]/);
      // manual dispatch is allowed (opt-in, non-publishing)
      expect(blob).toMatch(/\bworkflow_dispatch\b/);
    });
  });

  describe("runtime: Node and lockfile", () => {
    it("uses Node 22", () => {
      expect(blob).toMatch(/node-version.*22/);
    });

    it("installs from the repository lockfile via npm ci", () => {
      expect(blob).toMatch(/\bnpm ci\b/);
      // setup-node cache is lockfile-aware
      expect(blob).toMatch(/cache.*npm/);
    });
  });

  describe("quality gates", () => {
    it("runs all four normal quality gates", () => {
      expect(blob).toContain("npm test");
      expect(blob).toContain("npm run typecheck");
      expect(blob).toContain("npm run build");
      expect(blob).toContain("npm run smoke");
    });
  });

  describe("packed-tarball verification (R1 contract)", () => {
    it("runs the packed-tarball clean-install check against the checked-out tag source", () => {
      expect(blob).toContain("npm run clean-install:check");
    });
  });

  describe("CI-only fake pi runtime shim", () => {
    it("provides a narrowly scoped fake pi on PATH for the clean-install check", () => {
      // an executable named `pi` is created in the workflow
      expect(blob).toMatch(/\bpi\b/);
      // exposed to subsequent steps via the GITHUB_PATH mechanism
      expect(blob).toMatch(/GITHUB_PATH/);
      // explicitly labeled CI-only/fake/shim/stub, not a real Pi runtime
      expect(blob.toLowerCase()).toMatch(/fake|shim|stub|ci-only/);
      // responds to --version so `piren doctor` recognizes source `path`
      expect(blob).toMatch(/--version/);
    });

    it("does not call a network installer or fetch the real Pi runtime", () => {
      expect(blob.toLowerCase()).not.toMatch(/pi\.dev\/install/);
      expect(blob.toLowerCase()).not.toMatch(/curl.*install/);
    });
  });

  describe("hard boundaries: no publication and no privileged credentials", () => {
    // The task's required forbidden set. These strings must not appear
    // ANYWHERE in the workflow file (including comments), so a reviewer can
    // grep the file for each and get zero hits. `npm publish --provenance` is
    // subsumed by the `npm publish` absence and is therefore not listed.
    it("never publishes or declares OIDC/token/install-links credentials", () => {
      expect(raw).not.toContain("npm publish");
      // id-token permission in any spacing form
      expect(blob).not.toMatch(/id-token\s*:\s*write/);
      expect(raw).not.toContain("NPM_TOKEN");
      expect(raw).not.toContain("--install-links");
    });

    it("declares minimal read-only permissions and no GitHub Environment", () => {
      expect(blob).toMatch(/\bpermissions\b/);
      expect(blob).toMatch(/contents\s*:\s*read/);
      expect(blob.toLowerCase()).not.toContain("environment:");
    });
  });

  describe("package boundary: pi is not added to Piren's package", () => {
    it("keeps package.json free of any pi runtime dependency", () => {
      const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const keys = Object.keys(deps);
      // No dependency key is the bare `pi` runtime or a `@pi/...` package.
      expect(keys).not.toContain("pi");
      expect(keys.filter((k) => k.startsWith("@pi/"))).toEqual([]);
    });
  });

  describe("ADR-0036 P3d: CI fake-Pi ordering (release-verify)", () => {
    it("installs the CI-only fake Pi after unit tests but before smoke and clean-install", () => {
      // Steps appear in execution order in the file; step names are unique, so
      // their raw-text positions reflect the run order.
      const unitTestsIdx = raw.indexOf("Quality gate - unit tests");
      const fakePiIdx = raw.indexOf("Provide CI-only fake pi on PATH");
      const smokeIdx = raw.indexOf("Quality gate - smoke");
      const cleanInstallIdx = raw.indexOf("npm run clean-install:check");
      expect(unitTestsIdx).toBeGreaterThan(-1);
      expect(fakePiIdx).toBeGreaterThan(-1);
      expect(smokeIdx).toBeGreaterThan(-1);
      expect(cleanInstallIdx).toBeGreaterThan(-1);
      // Unit tests run BEFORE the shim (no runner Pi during tests -> hermetic).
      expect(fakePiIdx).toBeGreaterThan(unitTestsIdx);
      // Smoke and packed-tarball clean-install run AFTER the shim (Pi on PATH).
      expect(fakePiIdx).toBeLessThan(smokeIdx);
      expect(fakePiIdx).toBeLessThan(cleanInstallIdx);
    });
  });
});
