import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ADR-0033 P1: static contract for the registry publication workflow.
 *
 * `.github/workflows/release-publish.yml` is the ONLY workflow that publishes
 * Piren to npm. It must be tag-only, gated by the protected `npm-production`
 * GitHub Environment, use only `contents: read` + `id-token: write`, carry no
 * token/secret/production-Pi-installer path, verify ONE concrete packed tarball
 * through the existing clean-install machinery BEFORE its single provenance
 * `npm publish --tag latest`, and check tag/package version agreement first.
 *
 * It must not weaken the verification-only `release-verify.yml`.
 *
 * Assertions are YAML-format-tolerant: whitespace is collapsed to single spaces
 * and substring/regex checks are used. Forbidden strings are checked raw.
 */

const repoRoot = process.cwd();
const publishPath = join(repoRoot, ".github", "workflows", "release-publish.yml");
const verifyPath = join(repoRoot, ".github", "workflows", "release-verify.yml");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** Remove full-line comments so structural checks (count/order) see only the
 *  active workflow text, not explanatory prose that legitimately names the
 *  commands. Forbidden-literal checks still run against the raw text. */
function stripComments(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

describe("ADR-0033 P1: registry publication workflow", () => {
  let raw: string;
  let blob: string;

  beforeAll(() => {
    raw = read(publishPath);
    blob = normalize(raw);
  });

  it("ships a named workflow file at .github/workflows/release-publish.yml", () => {
    expect(raw.length).toBeGreaterThan(0);
    expect(blob).toMatch(/\bname:/);
  });

  describe("trigger", () => {
    it("is tag-only (no branch or manual dispatch)", () => {
      expect(blob).toMatch(/\bon:/);
      expect(blob).toMatch(/\bpush\b/);
      expect(blob).toMatch(/\btags\b/);
      expect(blob).toMatch(/v\*+|v\[0-9\]/);
      // Publication must be tag-triggered only: no workflow_dispatch.
      expect(blob).not.toMatch(/\bworkflow_dispatch\b/);
      // No branch-push trigger.
      expect(blob).not.toMatch(/\bbranches\b/);
    });
  });

  describe("permissions", () => {
    it("declares exactly contents: read and id-token: write, nothing broader", () => {
      expect(blob).toMatch(/contents\s*:\s*read/);
      expect(blob).toMatch(/id-token\s*:\s*write/);
      // No broader repository permissions.
      expect(blob).not.toMatch(/contents\s*:\s*write/);
      expect(blob).not.toMatch(/packages\s*:\s*write/);
      expect(blob).not.toMatch(/deployments\s*:\s*write/);
    });
  });

  describe("protected environment gate", () => {
    it("runs in the npm-production GitHub Environment", () => {
      expect(blob).toMatch(/environment\s*:\s*npm-production/);
    });
  });

  describe("runtime: Node and lockfile", () => {
    it("uses Node 22 and installs from the lockfile via npm ci", () => {
      expect(blob).toMatch(/node-version.*22/);
      expect(blob).toMatch(/\bnpm ci\b/);
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

  describe("version agreement", () => {
    it("checks tag and package.json version agreement before publish", () => {
      expect(blob).toMatch(/GITHUB_REF_NAME/);
      expect(blob).toMatch(/package\.json/);
      expect(blob).toMatch(/version/i);
    });
  });

  describe("one explicit verified tarball", () => {
    it("creates one explicit npm tarball via npm pack", () => {
      expect(blob).toMatch(/\bnpm pack\b/);
    });

    it("verifies the concrete packed tarball via the clean-install machinery", () => {
      expect(blob).toContain("npm run clean-install:check");
      // The check step references the packed tarball glob, not a github/branch spec.
      expect(blob).toMatch(/piren-\*\.tgz|\$tarball/);
    });

    it("verifies the tarball BEFORE its only npm publish", () => {
      const active = normalize(stripComments(raw));
      const verifyIdx = active.indexOf("npm run clean-install:check");
      const publishIdx = active.indexOf("npm publish");
      expect(verifyIdx).toBeGreaterThan(-1);
      expect(publishIdx).toBeGreaterThan(-1);
      expect(verifyIdx).toBeLessThan(publishIdx);
    });

    it("has exactly one provenance-enabled npm publish to latest", () => {
      const active = normalize(stripComments(raw));
      const count = (active.match(/\bnpm publish\b/g) ?? []).length;
      expect(count).toBe(1);
      expect(active).toMatch(/npm publish.*--provenance/);
      expect(active).toMatch(/npm publish.*--tag latest/);
      expect(active).toMatch(/npm publish.*--access public/);
    });

    it("publishes the verified tarball, never github: or branch-tip source", () => {
      const active = normalize(stripComments(raw));
      expect(active).not.toMatch(/npm publish.*github:/);
      expect(active).not.toMatch(/--install-links/);
    });
  });

  describe("hard boundaries: no credentials and no production Pi installer", () => {
    it("contains no npm token, registry secret, or .npmrc secret", () => {
      // These strings must not appear ANYWHERE in the workflow file.
      expect(raw).not.toContain("NPM_TOKEN");
      expect(raw).not.toContain("NODE_AUTH_TOKEN");
      expect(raw).not.toContain("secrets.");
      expect(raw).not.toContain("_authToken");
    });

    it("does not fetch or install the real Pi runtime", () => {
      expect(blob.toLowerCase()).not.toMatch(/pi\.dev\/install/);
      expect(blob.toLowerCase()).not.toMatch(/curl.*install/);
    });

    it("the fake pi shim stays CI-only and is not a real runtime", () => {
      expect(blob).toMatch(/GITHUB_PATH/);
      expect(blob.toLowerCase()).toMatch(/fake|shim|stub|ci-only/);
    });
  });
});

describe("ADR-0033 P1: verification workflow stays verification-only", () => {
  // The publication workflow must not weaken release-verify.yml.
  let raw: string;
  let blob: string;

  beforeAll(() => {
    raw = read(verifyPath);
    blob = normalize(raw);
  });

  it("remains non-publishing, token-free, Environment-free, and without id-token: write", () => {
    expect(raw).not.toContain("npm publish");
    expect(blob).not.toMatch(/id-token\s*:\s*write/);
    expect(raw).not.toContain("NPM_TOKEN");
    expect(blob.toLowerCase()).not.toContain("environment:");
  });
});

describe("ADR-0033 P1: this slice changes no public/version state", () => {
  it("does not bump the package version (still 0.1.0)", () => {
    const pkg = JSON.parse(read(join(repoRoot, "package.json"))) as { version: string };
    expect(pkg.version).toBe("0.1.0");
  });

  it("does not add a pi runtime dependency to the package", () => {
    const pkg = JSON.parse(read(join(repoRoot, "package.json"))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const keys = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    expect(keys).not.toContain("pi");
    expect(keys.filter((k) => k.startsWith("@pi/"))).toEqual([]);
  });

  it("does not introduce registry-install copy into the public docs surface", () => {
    // The public cutover is P4; P1 must not pre-announce npm install -g piren.
    const candidates = ["README.md", "docs/getting-started.md", "site/index.html"];
    for (const rel of candidates) {
      let text: string;
      try {
        text = read(join(repoRoot, rel));
      } catch {
        continue;
      }
      expect(text).not.toMatch(/npm install -g piren\b/);
    }
  });
});
