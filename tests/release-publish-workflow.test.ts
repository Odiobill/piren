import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * ADR-0033 P1: static contract for the registry publication workflow.
 *
 * `.github/workflows/release-publish.yml` is the ONLY workflow that publishes
 * Piren to npm. It is split into an unprotected `verify` job and a `publish`
 * job that `needs: verify`, so steward approval (the protected `npm-production`
 * Environment) and `id-token: write` apply ONLY after the tag-triggered
 * verification path has completed. Structural assertions parse the workflow
 * YAML; forbidden-literal checks run against the raw text.
 *
 * It must not weaken the verification-only `release-verify.yml`.
 */

const repoRoot = process.cwd();
const publishPath = join(repoRoot, ".github", "workflows", "release-publish.yml");
const verifyPath = join(repoRoot, ".github", "workflows", "release-verify.yml");

function readRaw(path: string): string {
  return readFileSync(path, "utf8");
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ");
}

function stripComments(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}
interface Job {
  name?: string;
  needs?: string | string[];
  environment?: string;
  permissions?: Record<string, string> | string;
  if?: string;
  steps?: Step[];
}
interface Workflow {
  jobs?: Record<string, Job>;
  permissions?: Record<string, string> | string;
}

function asPermissions(p: Record<string, string> | string | undefined): Record<string, string> {
  if (typeof p === "string" || p === undefined) return {};
  return p;
}

function needsList(job: Job | undefined): string[] {
  const n = job?.needs;
  if (n === undefined) return [];
  return Array.isArray(n) ? n : [n];
}

function runText(job: Job | undefined): string {
  return (job?.steps ?? []).map((s) => s.run ?? "").join("\n");
}

function usesList(job: Job | undefined): string[] {
  return (job?.steps ?? []).filter((s) => s.uses).map((s) => s.uses as string);
}

function setupNodeStep(job: Job | undefined): Step | undefined {
  return (job?.steps ?? []).find((s) => s.uses?.startsWith("actions/setup-node"));
}

function nodeVersion(job: Job | undefined): string | undefined {
  return setupNodeStep(job)?.with?.["node-version"];
}

function npmInstallVersion(job: Job | undefined): string | undefined {
  const m = runText(job).match(/npm install(?:\s+--global|\s+-g)?\s+npm@([0-9][^\s"'@]*)/);
  return m?.[1];
}

function stepIndex(job: Job | undefined, pred: (s: Step) => boolean): number {
  return (job?.steps ?? []).findIndex(pred);
}

/** Pure numeric semver >= comparison over the first three components. */
function semverGte(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return true;
}

describe("ADR-0033 P1: registry publication workflow", () => {
  let raw: string;
  let wf: Workflow;

  beforeAll(() => {
    raw = readRaw(publishPath);
    wf = parseYaml(raw) as Workflow;
  });

  it("ships a named workflow file at .github/workflows/release-publish.yml", () => {
    expect(raw.length).toBeGreaterThan(0);
  });

  describe("trigger (tag-only)", () => {
    it("runs release jobs on version-tag pushes and permits a manual diagnostic only", () => {
      const blob = normalize(raw);
      expect(blob).toMatch(/\bon:/);
      expect(blob).toMatch(/\bpush\b/);
      expect(blob).toMatch(/\btags\b/);
      expect(blob).toMatch(/v\*+|v\[0-9\]/);
      expect(blob).toMatch(/\bworkflow_dispatch\b/);
      expect(blob).not.toMatch(/\bbranches\b/);
      expect(wf.jobs?.verify?.if).toBe("github.event_name == 'push'");
      expect(wf.jobs?.publish?.if).toContain("github.event_name == 'push'");
    });
  });

  describe("two-job split", () => {
    it("defines verify, publish, and a manual-only OIDC exchange diagnostic in that order", () => {
      const keys = Object.keys(wf.jobs ?? {});
      expect(keys).toEqual(["verify", "publish", "diagnose_oidc_exchange"]);
    });

    it("publish depends on verify (steward approval happens after verification)", () => {
      expect(needsList(wf.jobs?.publish)).toContain("verify");
    });
  });

  describe("ADR-0035/0036/0037 bootstrap exception (P1c + P3c + P3e)", () => {
    it("the publish job is skipped for the three manual-bootstrap tags v0.1.1, v0.1.2, v0.1.3", () => {
      expect(wf.jobs?.publish?.if).toBe("github.event_name == 'push' && github.ref_name != 'v0.1.1' && github.ref_name != 'v0.1.2' && github.ref_name != 'v0.1.3'");
    });

    it("the guard skips only those three tags, not later tags", () => {
      const expr = wf.jobs?.publish?.if ?? "";
      expect(expr).toContain("github.ref_name");
      expect(expr).toContain("!=");
      expect(expr).toContain("v0.1.1");
      expect(expr).toContain("v0.1.2");
      expect(expr).toContain("v0.1.3");
      expect(expr).not.toContain("v0.1.4");
      expect(expr).not.toMatch(/v0\.\*|v\*/);
    });

    it("the verify job runs only for a tag push, never a manual diagnostic", () => {
      expect(wf.jobs?.verify?.if).toBe("github.event_name == 'push'");
    });

    it("normal later-tag publication still depends on verify", () => {
      expect(needsList(wf.jobs?.publish)).toContain("verify");
    });
  });

  describe("permission isolation", () => {
    it("top-level permissions are contents: read with no id-token", () => {
      const top = asPermissions(wf.permissions);
      expect(top["contents"]).toBe("read");
      expect(top["id-token"]).not.toBe("write");
    });

    it("verify job has no id-token: write", () => {
      const p = asPermissions(wf.jobs?.verify?.permissions);
      expect(p["id-token"]).not.toBe("write");
    });

    it("publish and the manual diagnostic alone have contents: read and id-token: write", () => {
      const publish = asPermissions(wf.jobs?.publish?.permissions);
      const diagnose = asPermissions(wf.jobs?.diagnose_oidc_exchange?.permissions);
      expect(publish).toEqual({ contents: "read", "id-token": "write" });
      expect(diagnose).toEqual({ contents: "read", "id-token": "write" });
    });

    it("only the publish and manual diagnostic jobs run in the npm-production Environment", () => {
      expect(wf.jobs?.publish?.environment).toBe("npm-production");
      expect(wf.jobs?.diagnose_oidc_exchange?.environment).toBe("npm-production");
      expect(wf.jobs?.verify?.environment).toBeUndefined();
    });
  });

  describe("verify job (pre-approval)", () => {
    it("runs the four quality gates", () => {
      const t = runText(wf.jobs?.verify);
      expect(t).toContain("npm test");
      expect(t).toContain("npm run typecheck");
      expect(t).toContain("npm run build");
      expect(t).toContain("npm run smoke");
    });

    it("checks tag/package version agreement", () => {
      const t = runText(wf.jobs?.verify);
      expect(t).toMatch(/GITHUB_REF_NAME/);
      expect(t).toMatch(/package\.json/);
    });

    it("builds one explicit tarball and validates it through the clean-install machinery", () => {
      const t = runText(wf.jobs?.verify);
      expect(t).toMatch(/\bnpm pack\b/);
      expect(t).toContain("npm run clean-install:check");
      // The scoped package packs to odiobill-piren-<version>.tgz; the workflow
      // globs that scoped name (not the old unscoped piren-*.tgz).
      expect(normalize(stripComments(raw))).toMatch(/odiobill-piren-\*\.tgz/);
    });

    it("uploads the verified tarball as a workflow artifact", () => {
      expect(usesList(wf.jobs?.verify)).toEqual(
        expect.arrayContaining([
          "actions/checkout@v4",
          "actions/upload-artifact@v4",
        ]),
      );
    });

    it("installs the CI-only fake Pi after unit tests but before smoke and clean-install (ADR-0036 P3d)", () => {
      const verify = wf.jobs?.verify;
      const unitTestsIdx = stepIndex(verify, (s) => /\bnpm test\b/.test(s.run ?? ""));
      const fakePiIdx = stepIndex(verify, (s) => /fake pi/i.test(s.name ?? "") || /fake pi/i.test(s.run ?? ""));
      const smokeIdx = stepIndex(verify, (s) => /npm run smoke/.test(s.run ?? ""));
      const cleanInstallIdx = stepIndex(verify, (s) => /npm run clean-install:check/.test(s.run ?? ""));
      expect(unitTestsIdx).toBeGreaterThanOrEqual(0);
      expect(fakePiIdx).toBeGreaterThanOrEqual(0);
      expect(smokeIdx).toBeGreaterThanOrEqual(0);
      expect(cleanInstallIdx).toBeGreaterThanOrEqual(0);
      // Unit tests run BEFORE the shim (no runner Pi during tests -> hermetic).
      expect(fakePiIdx).toBeGreaterThan(unitTestsIdx);
      // Smoke and packed-tarball clean-install run AFTER the shim (Pi on PATH).
      expect(fakePiIdx).toBeLessThan(smokeIdx);
      expect(fakePiIdx).toBeLessThan(cleanInstallIdx);
    });
  });

  describe("manual OIDC exchange diagnostic", () => {
    it("can run only by manual dispatch and exchanges the npm-audience ID token without publishing or logging a token", () => {
      const diagnose = wf.jobs?.diagnose_oidc_exchange;
      const t = runText(diagnose);
      expect(diagnose?.if).toBe("github.event_name == 'workflow_dispatch'");
      expect(t).toContain("/-/npm/v1/oidc/token/exchange/package/@odiobill%2fpiren");
      expect(t).toContain("npm:registry.npmjs.org");
      expect(t).not.toMatch(/npm\s+publish/);
      expect(t).not.toMatch(/npm\s+install/);
      expect(t).not.toMatch(/console\.log\(.*token/);
      expect(t).not.toMatch(/console\.log\(.*value/);
    });
  });

  describe("publish job (post-approval)", () => {
    it("downloads the verified tarball artifact", () => {
      expect(usesList(wf.jobs?.publish)).toContain("actions/download-artifact@v4");
    });

    it("never rebuilds, repacks, or installs from source", () => {
      const t = runText(wf.jobs?.publish);
      expect(t).not.toMatch(/\bnpm pack\b/);
      expect(t).not.toMatch(/\bnpm ci\b/);
      expect(t).not.toMatch(/npm run build/);
      // No source checkout in publish: it publishes the downloaded artifact.
      expect(usesList(wf.jobs?.publish)).not.toContain("actions/checkout@v4");
    });

    it("has exactly one provenance-enabled npm publish to latest", () => {
      const t = runText(wf.jobs?.publish);
      const count = (t.match(/\bnpm publish\b/g) ?? []).length;
      expect(count).toBe(1);
      expect(t).toMatch(/npm publish.*--provenance/);
      expect(t).toMatch(/--tag latest/);
      expect(t).toMatch(/--access public/);
    });

    it("publishes the verified artifact, never github: or branch-tip source", () => {
      const active = normalize(stripComments(raw));
      expect(active).not.toMatch(/npm publish.*github:/);
      expect(active).not.toMatch(/--install-links/);
    });
  });

  describe("verify-before-publish ordering (active text)", () => {
    it("validates the tarball before the single npm publish", () => {
      const active = normalize(stripComments(raw));
      const verifyIdx = active.indexOf("npm run clean-install:check");
      const publishIdx = active.indexOf("npm publish");
      expect(verifyIdx).toBeGreaterThan(-1);
      expect(publishIdx).toBeGreaterThan(-1);
      expect(verifyIdx).toBeLessThan(publishIdx);
    });
  });

  describe("trusted-publishing toolchain floor (P1b)", () => {
    it("both jobs pin a Node version satisfying the >=22.14.0 floor", () => {
      const verifyNode = nodeVersion(wf.jobs?.verify);
      const publishNode = nodeVersion(wf.jobs?.publish);
      expect(verifyNode).toBeDefined();
      expect(publishNode).toBeDefined();
      expect(semverGte(verifyNode!, "22.14.0")).toBe(true);
      expect(semverGte(publishNode!, "22.14.0")).toBe(true);
      // Not an ambiguous bare major ("22" alone does not express the floor).
      expect(verifyNode).not.toBe("22");
      expect(publishNode).not.toBe("22");
    });

    it("the publish job installs an npm CLI satisfying >=11.5.1", () => {
      const v = npmInstallVersion(wf.jobs?.publish);
      expect(v).toBeDefined();
      expect(semverGte(v!, "11.5.1")).toBe(true);
      // verify does not need the provenance npm; it must not install it.
      expect(npmInstallVersion(wf.jobs?.verify)).toBeUndefined();
    });

    it("the publish job has a fail-closed Node/npm version preflight before npm publish", () => {
      const publish = wf.jobs?.publish;
      const preflightIdx = stepIndex(
        publish,
        (s) => /22\.14\.0/.test(s.run ?? "") && /11\.5\.1/.test(s.run ?? ""),
      );
      const npmPublishIdx = stepIndex(publish, (s) => /\bnpm publish\b/.test(s.run ?? ""));
      expect(preflightIdx).toBeGreaterThanOrEqual(0);
      expect(npmPublishIdx).toBeGreaterThan(preflightIdx);
      // Fail-closed: the preflight exits non-zero on a below-floor toolchain.
      const preflightRun = publish?.steps?.[preflightIdx]?.run ?? "";
      expect(preflightRun).toMatch(/process\.exit\(1\)|exit 1/);
    });

    it("the npm install adds no token, registry-url, or auth path", () => {
      const t = runText(wf.jobs?.publish);
      expect(t).not.toMatch(/registry-url/i);
      expect(t).not.toContain("NODE_AUTH_TOKEN");
      expect(t).not.toContain("_authToken");
      expect(t).not.toContain("secrets.");
    });
  });

  describe("hard boundaries: no credentials and no production Pi installer", () => {
    it("contains no npm token, registry secret, or .npmrc secret anywhere", () => {
      expect(raw).not.toContain("NPM_TOKEN");
      expect(raw).not.toContain("NODE_AUTH_TOKEN");
      expect(raw).not.toContain("secrets.");
      expect(raw).not.toContain("_authToken");
    });

    it("does not fetch or install the real Pi runtime", () => {
      const blob = normalize(raw);
      expect(blob.toLowerCase()).not.toMatch(/pi\.dev\/install/);
      expect(blob.toLowerCase()).not.toMatch(/curl.*install/);
    });

    it("the fake pi shim stays CI-only and is not a real runtime", () => {
      const blob = normalize(raw);
      expect(blob).toMatch(/GITHUB_PATH/);
      expect(blob.toLowerCase()).toMatch(/fake|shim|stub|ci-only/);
    });
  });
});

describe("ADR-0033 P1: verification workflow stays verification-only", () => {
  let raw: string;
  let blob: string;

  beforeAll(() => {
    raw = readRaw(verifyPath);
    blob = normalize(raw);
  });

  it("remains non-publishing, token-free, Environment-free, and without id-token: write", () => {
    expect(raw).not.toContain("npm publish");
    expect(blob).not.toMatch(/id-token\s*:\s*write/);
    expect(raw).not.toContain("NPM_TOKEN");
    expect(blob.toLowerCase()).not.toContain("environment:");
  });
});

describe("ADR-0033: release artifact and public-surface guards", () => {
  it("package version is the 0.1.4 registry-cutover release candidate (unreleased)", () => {
    const pkg = JSON.parse(readRaw(join(repoRoot, "package.json"))) as { version: string };
    expect(pkg.version).toBe("0.1.4");
  });

  it("does not add a pi runtime dependency to the package", () => {
    const pkg = JSON.parse(readRaw(join(repoRoot, "package.json"))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const keys = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    expect(keys).not.toContain("pi");
    expect(keys.filter((k) => k.startsWith("@pi/"))).toEqual([]);
  });

  it("does not introduce registry-install copy into the public docs surface", () => {
    const candidates = ["README.md", "docs/getting-started.md", "site/index.html"];
    for (const rel of candidates) {
      let text: string;
      try {
        text = readRaw(join(repoRoot, rel));
      } catch {
        continue;
      }
      expect(text).not.toMatch(/npm install -g piren\b/);
    }
  });
});
