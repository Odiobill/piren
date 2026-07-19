import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveInstallSpec,
  checkPackedArtifacts,
  parseNpmPackJson,
  parseTarListing,
  buildLocalTarball,
  runPrebuiltTarballCheck,
  needsInstallLinks,
  runPackedCleanInstallCheck,
  REQUIRED_PACKED_ARTIFACTS,
  formatCleanInstallReport,
  type PackRunDeps,
  type InstallRunner,
  type CleanInstallReportResult,
  type CleanInstallResult,
  type CleanInstallProbe,
  type CleanInstallSourceInfo,
} from "../src/clean-install.js";

// ---------------------------------------------------------------------------
// resolveInstallSpec: default must be packed-tarball/local, NOT github.
// ---------------------------------------------------------------------------

describe("resolveInstallSpec", () => {
  it("defaults to packed-tarball/local when no positional spec is given", () => {
    expect(resolveInstallSpec([])).toEqual({ kind: "packed-tarball", source: "local" });
  });

  it("defaults to packed-tarball/local when only flags are present", () => {
    expect(resolveInstallSpec(["--keep", "--allow-scripts"])).toEqual({ kind: "packed-tarball", source: "local" });
  });

  it("treats an explicit positional as an explicit spec (escape hatch)", () => {
    expect(resolveInstallSpec(["github:Odiobill/piren"])).toEqual({ kind: "explicit", spec: "github:Odiobill/piren" });
  });

  it("routes a local tarball path to the prebuilt-tarball verifier (surface-validated)", () => {
    expect(resolveInstallSpec(["/abs/path/piren-0.1.0.tgz"])).toEqual({ kind: "prebuilt-tarball", spec: "/abs/path/piren-0.1.0.tgz" });
    expect(resolveInstallSpec(["./piren-0.1.1.tgz"])).toEqual({ kind: "prebuilt-tarball", spec: "./piren-0.1.1.tgz" });
  });

  it("keeps github/git specs on the explicit escape hatch", () => {
    expect(resolveInstallSpec(["github:Odiobill/piren"])).toEqual({ kind: "explicit", spec: "github:Odiobill/piren" });
    expect(resolveInstallSpec(["git+https://example.com/piren.git"])).toEqual({ kind: "explicit", spec: "git+https://example.com/piren.git" });
  });

  it("ignores flags after the first positional", () => {
    expect(resolveInstallSpec(["/x.tgz", "--allow-scripts", "--keep"])).toEqual({ kind: "prebuilt-tarball", spec: "/x.tgz" });
  });
});

// ---------------------------------------------------------------------------
// checkPackedArtifacts: pure pass/fail over the packed file surface.
// ---------------------------------------------------------------------------

describe("checkPackedArtifacts", () => {
  it("passes when all required runtime artifacts are present", () => {
    const result = checkPackedArtifacts([
      "README.md",
      "dist/src/cli.js",
      "dist/public/index.html",
      "dist/src/pi-extension.js",
      "docs/getting-started.md",
    ]);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("fails and lists missing artifacts (runtime and docs)", () => {
    const result = checkPackedArtifacts(["dist/src/cli.js", "README.md"]);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([
      "dist/public/index.html",
      "dist/src/pi-extension.js",
      "docs/getting-started.md",
    ]);
  });

  it("normalizes a leading package/ prefix from tarball listings", () => {
    const result = checkPackedArtifacts([
      "package/dist/src/cli.js",
      "package/dist/public/index.html",
      "package/dist/src/pi-extension.js",
      "package/docs/getting-started.md",
    ]);
    expect(result.ok).toBe(true);
  });

  it("declares the packed-surface contract: runtime artifacts plus a stable docs file", () => {
    expect([...REQUIRED_PACKED_ARTIFACTS]).toEqual([
      "dist/src/cli.js",
      "dist/public/index.html",
      "dist/src/pi-extension.js",
      "docs/getting-started.md",
    ]);
  });
});

// ---------------------------------------------------------------------------
// parseNpmPackJson: robust across npm object-keyed and array output shapes.
// ---------------------------------------------------------------------------

const SAMPLE_OBJECT_KEYED = JSON.stringify({
  piren: {
    id: "piren@0.1.0",
    name: "piren",
    version: "0.1.0",
    filename: "piren-0.1.0.tgz",
    files: [
      { path: "dist/src/cli.js", size: 10, mode: 420 },
      { path: "dist/public/index.html", size: 10, mode: 420 },
      { path: "dist/src/pi-extension.js", size: 10, mode: 420 },
      { path: "docs/getting-started.md", size: 10, mode: 420 },
    ],
  },
});

const SAMPLE_ARRAY = JSON.stringify([
  {
    id: "piren@0.1.0",
    name: "piren",
    version: "0.1.0",
    filename: "piren-0.1.0.tgz",
    files: [{ path: "dist/src/cli.js", size: 10, mode: 420 }],
  },
]);

describe("parseNpmPackJson", () => {
  it("parses the npm object-keyed shape (current npm)", () => {
    const parsed = parseNpmPackJson(SAMPLE_OBJECT_KEYED);
    expect(parsed).not.toBeNull();
    expect(parsed!.filename).toBe("piren-0.1.0.tgz");
    expect(parsed!.packageName).toBe("piren");
    expect(parsed!.packageVersion).toBe("0.1.0");
    expect(parsed!.packedFiles).toContain("dist/src/cli.js");
    expect(parsed!.packedFiles).toContain("dist/public/index.html");
  });

  it("parses the npm array shape (older npm)", () => {
    const parsed = parseNpmPackJson(SAMPLE_ARRAY);
    expect(parsed).not.toBeNull();
    expect(parsed!.filename).toBe("piren-0.1.0.tgz");
    expect(parsed!.packedFiles).toContain("dist/src/cli.js");
  });

  it("returns null on non-JSON or empty output", () => {
    expect(parseNpmPackJson("not json")).toBeNull();
    expect(parseNpmPackJson("")).toBeNull();
    expect(parseNpmPackJson(JSON.stringify({}))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildLocalTarball: orchestration via injected pack deps (no real npm).
// ---------------------------------------------------------------------------

function fakePackDeps(pack: () => Promise<{ code: number; stdout: string; stderr: string }>): PackRunDeps {
  const removed: string[] = [];
  return {
    pack: async () => pack(),
    remove: async (path: string) => {
      removed.push(path);
    },
    // expose for assertions via closure is unnecessary here; behavior tested via outcome.
    _removed: removed,
  } as unknown as PackRunDeps;
}

describe("buildLocalTarball", () => {
  it("packs, resolves the tarball path under cwd, and validates the surface", async () => {
    const deps = fakePackDeps(async () => ({ code: 0, stdout: SAMPLE_OBJECT_KEYED, stderr: "" }));
    const outcome = await buildLocalTarball(deps, "/repo");
    expect(outcome.ok).toBe(true);
    expect(outcome.tarballPath).toBe(join("/repo", "piren-0.1.0.tgz"));
    expect(outcome.packageName).toBe("piren");
    expect(outcome.packageVersion).toBe("0.1.0");
    expect(outcome.missing).toEqual([]);
    expect(outcome.packedFiles.length).toBe(4);
  });

  it("fails when npm pack exits non-zero, without producing a tarball path", async () => {
    const deps = fakePackDeps(async () => ({ code: 1, stdout: "", stderr: "pack failed" }));
    const outcome = await buildLocalTarball(deps, "/repo");
    expect(outcome.ok).toBe(false);
    expect(outcome.tarballPath).toBeUndefined();
    expect(outcome.error).toMatch(/pack/i);
  });

  it("fails when the packed surface is missing required artifacts", async () => {
    const missingSurface = JSON.stringify({
      piren: {
        id: "piren@0.1.0",
        name: "piren",
        version: "0.1.0",
        filename: "piren-0.1.0.tgz",
        files: [{ path: "dist/src/cli.js", size: 10, mode: 420 }],
      },
    });
    const deps = fakePackDeps(async () => ({ code: 0, stdout: missingSurface, stderr: "" }));
    const outcome = await buildLocalTarball(deps, "/repo");
    expect(outcome.ok).toBe(false);
    expect(outcome.tarballPath).toBe(join("/repo", "piren-0.1.0.tgz"));
    expect(outcome.missing).toEqual([
      "dist/public/index.html",
      "dist/src/pi-extension.js",
      "docs/getting-started.md",
    ]);
  });

  it("fails when npm pack output is unparseable", async () => {
    const deps = fakePackDeps(async () => ({ code: 0, stdout: "garbage", stderr: "" }));
    const outcome = await buildLocalTarball(deps, "/repo");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/parse|npm pack/i);
  });
});

// ---------------------------------------------------------------------------
// runPackedCleanInstallCheck: tarball cleanup on every path (regression).
// A tarball produced by `npm pack` must be removed unless --keep, including
// the surface-missing failure path and thrown install errors.
// ---------------------------------------------------------------------------

const SURFACE_MISSING_PACK = JSON.stringify({
  piren: {
    id: "piren@0.1.0",
    name: "piren",
    version: "0.1.0",
    filename: "piren-0.1.0.tgz",
    files: [{ path: "dist/src/cli.js", size: 10, mode: 420 }],
  },
});

function observablePack(packResult: { code: number; stdout: string; stderr: string }): { deps: PackRunDeps; removed: string[] } {
  const removed: string[] = [];
  const deps: PackRunDeps = {
    pack: async () => packResult,
    remove: async (path: string) => {
      removed.push(path);
    },
  };
  return { deps, removed };
}

const okProbe: CleanInstallProbe = {
  installDir: "/prefix/node_modules/piren",
  cliJsExists: true,
  publicIndexExists: true,
  extensionJsExists: true,
  binaryRuns: true,
  piRuntimeSource: "path",
};

const fakeInstallOk: InstallRunner = async (): Promise<CleanInstallResult> => ({
  ok: true,
  installDir: "/prefix/node_modules/piren",
  checks: [{ id: "dist-cli", status: "ok", message: "present." }],
  probe: okProbe,
});

describe("runPackedCleanInstallCheck tarball cleanup", () => {
  it("removes the tarball on the default surface-missing failure path", async () => {
    const { deps, removed } = observablePack({ code: 0, stdout: SURFACE_MISSING_PACK, stderr: "" });
    const result = await runPackedCleanInstallCheck({ repoRoot: "/repo", packDeps: deps, runInstall: fakeInstallOk });
    expect(result.ok).toBe(false);
    expect(removed).toEqual([join("/repo", "piren-0.1.0.tgz")]);
  });

  it("preserves the tarball on the failure path when --keep is set", async () => {
    const { deps, removed } = observablePack({ code: 0, stdout: SURFACE_MISSING_PACK, stderr: "" });
    await runPackedCleanInstallCheck({ repoRoot: "/repo", keep: true, packDeps: deps, runInstall: fakeInstallOk });
    expect(removed).toEqual([]);
  });

  it("does not attempt removal when npm pack failed and produced no tarball", async () => {
    const { deps, removed } = observablePack({ code: 1, stdout: "", stderr: "boom" });
    await runPackedCleanInstallCheck({ repoRoot: "/repo", packDeps: deps, runInstall: fakeInstallOk });
    expect(removed).toEqual([]);
  });

  it("removes the tarball on the success path by default", async () => {
    const { deps, removed } = observablePack({ code: 0, stdout: SAMPLE_OBJECT_KEYED, stderr: "" });
    const result = await runPackedCleanInstallCheck({ repoRoot: "/repo", packDeps: deps, runInstall: fakeInstallOk });
    expect(result.ok).toBe(true);
    expect(removed).toEqual([join("/repo", "piren-0.1.0.tgz")]);
  });

  it("preserves the tarball on the success path when --keep is set", async () => {
    const { deps, removed } = observablePack({ code: 0, stdout: SAMPLE_OBJECT_KEYED, stderr: "" });
    await runPackedCleanInstallCheck({ repoRoot: "/repo", keep: true, packDeps: deps, runInstall: fakeInstallOk });
    expect(removed).toEqual([]);
  });

  it("removes the tarball even when the install step throws", async () => {
    const { deps, removed } = observablePack({ code: 0, stdout: SAMPLE_OBJECT_KEYED, stderr: "" });
    const throwingInstall: InstallRunner = async () => {
      throw new Error("install exploded");
    };
    await expect(
      runPackedCleanInstallCheck({ repoRoot: "/repo", packDeps: deps, runInstall: throwingInstall }),
    ).rejects.toThrow(/install exploded/);
    expect(removed).toEqual([join("/repo", "piren-0.1.0.tgz")]);
  });
});

// ---------------------------------------------------------------------------
// needsInstallLinks: github needs it, tarballs/registry/folders do not.
// ---------------------------------------------------------------------------

describe("needsInstallLinks", () => {
  it("returns true for github: and git+ specs", () => {
    expect(needsInstallLinks("github:Odiobill/piren")).toBe(true);
    expect(needsInstallLinks("git+https://github.com/Odiobill/piren.git")).toBe(true);
    expect(needsInstallLinks("https://github.com/Odiobill/piren.git")).toBe(true);
  });

  it("returns false for a local tarball path", () => {
    expect(needsInstallLinks("/abs/piren-0.1.0.tgz")).toBe(false);
    expect(needsInstallLinks("./piren-0.1.0.tgz")).toBe(false);
  });

  it("returns false for a registry spec or name", () => {
    expect(needsInstallLinks("piren")).toBe(false);
    expect(needsInstallLinks("piren@0.1.0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatCleanInstallReport: surfaces packed-tarball source info.
// ---------------------------------------------------------------------------

describe("formatCleanInstallReport with source info", () => {
  const baseAssessment: CleanInstallReportResult = {
    ok: true,
    installDir: "/prefix/node_modules/piren",
    checks: [
      { id: "dist-cli", status: "ok", message: "present." },
      { id: "binary-runs", status: "ok", message: "runs." },
      { id: "pi-runtime", status: "ok", message: "on PATH." },
    ],
  };

  it("prints packed-tarball source header with the artifact path/spec", () => {
    const source: CleanInstallSourceInfo = {
      kind: "packed-tarball",
      spec: "/repo/piren-0.1.0.tgz",
      tarballPath: "/repo/piren-0.1.0.tgz",
      packageName: "piren",
      packageVersion: "0.1.0",
      packedFileCount: 209,
      artifactsOk: true,
    };
    const out = formatCleanInstallReport({ ...baseAssessment, source });
    expect(out).toContain("source: packed-tarball");
    expect(out).toContain("/repo/piren-0.1.0.tgz");
    expect(out).toContain("piren@0.1.0");
    expect(out).toContain("209");
  });

  it("omits source header when no source info is present (explicit/github path)", () => {
    const out = formatCleanInstallReport(baseAssessment);
    expect(out).not.toMatch(/source:/);
    expect(out).toContain("result: PASS");
  });
});

// ---------------------------------------------------------------------------
// Package metadata: engines.node declares Node >= 22.
// ---------------------------------------------------------------------------

describe("package metadata (registry distribution)", () => {
  it("declares engines.node compatible with the documented Node 22+ requirement", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    expect(pkg.engines?.node).toBeTruthy();
    // Accept any range whose minimum is 22 or higher (e.g. ">=22", "^22", "22.x").
    const range = pkg.engines!.node!;
    const minMatch = range.match(/(\d+)/);
    expect(minMatch).not.toBeNull();
    expect(Number(minMatch![1])).toBeGreaterThanOrEqual(22);
  });
});

// ---------------------------------------------------------------------------
// parseTarListing + runPrebuiltTarballCheck (ADR-0033 P1): consume an explicitly
// pre-packed tarball, validate its packed surface (incl. docs), then install it.
// Reuses runCleanInstallCheck + checkPackedArtifacts; never removes the
// caller-owned tarball.
// ---------------------------------------------------------------------------

const TAR_SURFACE_OK =
  "package/package.json\n" +
  "package/dist/src/cli.js\n" +
  "package/dist/public/index.html\n" +
  "package/dist/src/pi-extension.js\n" +
  "package/docs/getting-started.md\n";

const TAR_SURFACE_MISSING_DOCS =
  "package/package.json\n" +
  "package/dist/src/cli.js\n" +
  "package/dist/public/index.html\n" +
  "package/dist/src/pi-extension.js\n";

describe("parseTarListing", () => {
  it("extracts one entry per non-empty line", () => {
    expect(parseTarListing("a\nb\nc\n")).toEqual(["a", "b", "c"]);
  });

  it("tolerates trailing/blank lines and CRLF", () => {
    expect(parseTarListing("a\r\nb\n\n")).toEqual(["a", "b"]);
  });

  it("returns an empty list for blank input", () => {
    expect(parseTarListing("")).toEqual([]);
  });
});

describe("runPrebuiltTarballCheck", () => {
  const okProbe2: CleanInstallProbe = {
    installDir: "/prefix/node_modules/piren",
    cliJsExists: true,
    publicIndexExists: true,
    extensionJsExists: true,
    binaryRuns: true,
    piRuntimeSource: "path",
  };

  function makeListDeps(stdout: string, code = 0): { listDeps: import("../src/clean-install.js").TarballListDeps; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      listDeps: {
        list: async (tarballPath: string) => {
          calls.push(tarballPath);
          return { code, stdout, stderr: code === 0 ? "" : "tar error" };
        },
      },
    };
  }

  it("installs the prebuilt tarball when its surface is valid", async () => {
    const { listDeps, calls } = makeListDeps(TAR_SURFACE_OK);
    let installedSpec: string | undefined;
    const runInstall: InstallRunner = async (opts) => {
      installedSpec = opts.spec;
      return { ok: true, installDir: opts.prefix + "/node_modules/piren", checks: [{ id: "dist-cli", status: "ok", message: "present." }], probe: okProbe2 };
    };
    const result = await runPrebuiltTarballCheck({ tarballPath: "/repo/piren-0.1.0.tgz", listDeps, runInstall });

    expect(calls).toEqual(["/repo/piren-0.1.0.tgz"]);
    expect(installedSpec).toBe("/repo/piren-0.1.0.tgz");
    expect(result.ok).toBe(true);
    expect(result.source?.kind).toBe("prebuilt-tarball");
    expect(result.source?.tarballPath).toBe("/repo/piren-0.1.0.tgz");
    expect(result.source?.artifactsOk).toBe(true);
  });

  it("fails before install when the packed surface is missing artifacts (e.g. docs)", async () => {
    const { listDeps } = makeListDeps(TAR_SURFACE_MISSING_DOCS);
    let installCalled = false;
    const runInstall: InstallRunner = async () => {
      installCalled = true;
      return { ok: true, installDir: "/x", checks: [], probe: okProbe2 };
    };
    const result = await runPrebuiltTarballCheck({ tarballPath: "/repo/piren-0.1.0.tgz", listDeps, runInstall });

    expect(result.ok).toBe(false);
    expect(installCalled).toBe(false);
    expect(result.source?.artifactsOk).toBe(false);
    expect(result.source?.missing).toContain("docs/getting-started.md");
    expect(result.checks.some((c) => c.id === "packed-surface" && c.status === "fail")).toBe(true);
  });

  it("fails when the tarball cannot be listed", async () => {
    const { listDeps } = makeListDeps("", 2);
    let installCalled = false;
    const runInstall: InstallRunner = async () => {
      installCalled = true;
      return { ok: true, installDir: "/x", checks: [], probe: okProbe2 };
    };
    const result = await runPrebuiltTarballCheck({ tarballPath: "/repo/missing.tgz", listDeps, runInstall });

    expect(result.ok).toBe(false);
    expect(installCalled).toBe(false);
  });

  it("never removes the caller-owned prebuilt tarball", async () => {
    const { listDeps } = makeListDeps(TAR_SURFACE_OK);
    const runInstall: InstallRunner = async () => ({
      ok: true,
      installDir: "/x",
      checks: [{ id: "dist-cli", status: "ok", message: "present." }],
      probe: okProbe2,
    });
    const result = await runPrebuiltTarballCheck({ tarballPath: "/repo/piren-0.1.0.tgz", listDeps, runInstall });
    expect(result.ok).toBe(true);
    // No removal hook is exercised; the tarball is owned by the caller/workflow.
    expect(result.source?.tarballPath).toBe("/repo/piren-0.1.0.tgz");
  });

  it("resolves a relative tarball path to an absolute install spec (regression)", async () => {
    const { listDeps, calls } = makeListDeps(TAR_SURFACE_OK);
    let installedSpec: string | undefined;
    const runInstall: InstallRunner = async (opts) => {
      installedSpec = opts.spec;
      return { ok: true, installDir: "/x", checks: [{ id: "dist-cli", status: "ok", message: "present." }], probe: okProbe2 };
    };
    await runPrebuiltTarballCheck({ tarballPath: "piren-0.1.0.tgz", listDeps, runInstall });
    // The isolated install runs with cwd set to the clean prefix, so the
    // tarball must be resolved to an absolute path before installing.
    expect(installedSpec).toMatch(/.*piren-0\.1\.0\.tgz$/);
    expect(installedSpec?.startsWith("/")).toBe(true);
    // The listing also receives the resolved absolute path.
    expect(calls[0]?.startsWith("/")).toBe(true);
  });
});
