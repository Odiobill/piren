import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 0.2.4 release-recovery contract: static contract for the NON-PUBLISHING
 * Release preflight workflow.
 *
 * The preflight runs the SAME named shared quality kernels as both tag
 * verifiers (release-verify.yml and release-publish.yml verify) on every push
 * to main and on manual dispatch, so tag-only verification failures are
 * discovered before any tag is cut. It must never publish, never hold a
 * registry token, never mint OIDC provenance, and never declare a GitHub
 * Environment.
 *
 * Assertions are intentionally YAML-format-tolerant: the workflow is read as
 * text, whitespace runs are collapsed to single spaces, and step ordering is
 * proven through unique-text positions (steps appear in execution order).
 */
const preflightPath = join(process.cwd(), ".github", "workflows", "release-preflight.yml");
const publishPath = join(process.cwd(), ".github", "workflows", "release-publish.yml");
const verifyPath = join(process.cwd(), ".github", "workflows", "release-verify.yml");

function readRaw(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

/** Collapse whitespace runs to single spaces (format-tolerant matching). */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ");
}

describe("0.2.4 recovery: non-publishing release preflight workflow", () => {
  let raw: string;
  let blob: string;

  beforeAll(() => {
    raw = readRaw(".github/workflows/release-preflight.yml");
    blob = normalize(raw);
  });

  it("ships a named workflow file at .github/workflows/release-preflight.yml", () => {
    expect(raw.length).toBeGreaterThan(0);
    expect(raw).toContain("name: Release preflight");
  });

  describe("trigger (push to main plus manual dispatch, never tags)", () => {
    it("runs on pushes to main and manual dispatch", () => {
      expect(blob).toMatch(/\bon:/);
      expect(blob).toMatch(/\bpush\b/);
      expect(blob).toMatch(/branches:/);
      expect(blob).toMatch(/- main/);
      expect(blob).toMatch(/\bworkflow_dispatch\b/);
    });

    it("never runs on release tags (tag verification stays with the tag workflows)", () => {
      const trigger = raw.slice(raw.indexOf("on:"), raw.indexOf("permissions:"));
      expect(trigger).not.toMatch(/tags:/);
    });
  });

  it("pins the exact tag-verifier Node floor 22.14.0", () => {
    expect(raw).toMatch(/node-version:\s*"22\.14\.0"/);
  });

  it("installs from the repository lockfile via npm ci", () => {
    expect(blob).toMatch(/\bnpm ci\b/);
  });

  it("uses the shared named quality kernels (verify:unit + verify:runtime) and the shared clean-install check", () => {
    expect(raw).toContain("npm run verify:unit");
    expect(raw).toContain("npm run verify:runtime");
    expect(raw).toContain("npm run clean-install:check");
  });

  it("installs the CI-only fake Pi after the unit kernel but before the runtime kernel and clean-install", () => {
    // Steps appear in execution order in the file; step names are unique, so
    // their raw-text positions reflect the run order.
    const unitIdx = raw.indexOf("shared verify:unit");
    const fakePiIdx = raw.indexOf("Provide CI-only fake pi on PATH");
    const runtimeIdx = raw.indexOf("shared verify:runtime");
    const cleanInstallIdx = raw.indexOf("npm run clean-install:check");
    expect(unitIdx).toBeGreaterThan(-1);
    expect(fakePiIdx).toBeGreaterThan(-1);
    expect(runtimeIdx).toBeGreaterThan(-1);
    expect(cleanInstallIdx).toBeGreaterThan(-1);
    // Unit tests run BEFORE the shim (no runner Pi during tests -> hermetic).
    expect(fakePiIdx).toBeGreaterThan(unitIdx);
    // The runtime kernel and packed-tarball clean-install run AFTER the shim.
    expect(fakePiIdx).toBeLessThan(runtimeIdx);
    expect(fakePiIdx).toBeLessThan(cleanInstallIdx);
  });

  describe("hard boundaries: strictly non-publishing", () => {
    it("never publishes, packs for publication, or uploads/downloads a release artifact", () => {
      expect(raw).not.toMatch(/\bnpm publish\b/);
      expect(raw).not.toMatch(/\bnpm pack\b/);
      expect(raw).not.toContain("actions/upload-artifact");
      expect(raw).not.toContain("actions/download-artifact");
    });

    it("holds no registry token, OIDC write, environment, or privileged permissions", () => {
      expect(blob).not.toContain("NPM_TOKEN");
      expect(blob).not.toContain("NODE_AUTH_TOKEN");
      expect(blob).not.toMatch(/registry-url/i);
      expect(blob).not.toMatch(/id-token\s*:\s*write/);
      expect(blob).not.toMatch(/\benvironment\s*:/);
      expect(blob).toMatch(/permissions: contents: read/);
    });

    it("never references repository secrets of any kind", () => {
      expect(raw).not.toMatch(/secrets\./);
    });
  });

  describe("shared kernels across all three verifier paths", () => {
    it("the publish verifier and the release-artifact verifier use the same named kernels", () => {
      const publishRaw = readRaw(".github/workflows/release-publish.yml");
      const verifyRaw = readRaw(".github/workflows/release-verify.yml");
      expect(publishRaw).toContain("npm run verify:unit");
      expect(publishRaw).toContain("npm run verify:runtime");
      expect(verifyRaw).toContain("npm run verify:unit");
      expect(verifyRaw).toContain("npm run verify:runtime");
      // The preflight shares the identical kernel script names.
      expect(raw).toContain("npm run verify:unit");
      expect(raw).toContain("npm run verify:runtime");
    });

    it("all three verifier paths pin the same exact Node floor 22.14.0", () => {
      const publishRaw = readRaw(".github/workflows/release-publish.yml");
      const verifyRaw = readRaw(".github/workflows/release-verify.yml");
      expect(publishRaw).toMatch(/node-version:\s*"22\.14\.0"/);
      expect(verifyRaw).toMatch(/node-version:\s*"22\.14\.0"/);
      expect(raw).toMatch(/node-version:\s*"22\.14\.0"/);
    });
  });
});
