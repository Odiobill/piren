/**
 * Clean-install verification core.
 *
 * `assessCleanInstall` is the pure, unit-testable heart: given the observed
 * state of a freshly installed Piren (dist artifacts, binary behavior, Pi
 * runtime source), it produces a structured pass/fail report with a check per
 * concern. `runCleanInstallCheck` orchestrates the real npm install in an
 * isolated clean HOME and feeds the resulting probe to `assessCleanInstall`.
 *
 * The most common real-world failure this catches: a github or tarball install
 * that does not contain the committed `dist/` release artifacts expected by the
 * installed `piren` binary.
 */
export type CleanInstallStatus = "ok" | "warn" | "fail";
export interface CleanInstallCheck {
    id: string;
    status: CleanInstallStatus;
    message: string;
}
export type PiRuntimeSource = "path" | "unavailable";
/**
 * The observed state of one fresh install. The orchestration script gathers
 * this by running real `npm install` + `piren` commands; tests construct it
 * directly so the assessment logic is exercised without any network.
 */
export interface CleanInstallProbe {
    installDir: string;
    cliJsExists: boolean;
    publicIndexExists: boolean;
    extensionJsExists: boolean;
    binaryRuns: boolean;
    binaryVersion?: string | undefined;
    piRuntimeSource: PiRuntimeSource;
    piRuntimeVersion?: string | undefined;
    piRuntimeError?: string | undefined;
}
export interface CleanInstallAssessment {
    ok: boolean;
    installDir: string;
    checks: CleanInstallCheck[];
}
export declare function assessCleanInstall(probe: CleanInstallProbe): CleanInstallAssessment;
export declare function formatCleanInstallReport(report: CleanInstallReportResult): string;
/**
 * Required packed-surface contract: the runtime artifacts the installed CLI
 * needs PLUS a stable docs file, so a regression that drops `docs/` from
 * `package.json` `files` is caught here. The installed-runtime probe
 * (`assessCleanInstall`) stays scoped to the three dist runtime files; this
 * constant governs the pack surface only.
 */
export declare const REQUIRED_PACKED_ARTIFACTS: readonly ["dist/src/cli.js", "dist/public/index.html", "dist/src/pi-extension.js", "docs/getting-started.md"];
/** Discriminated install-spec resolved from CLI args. */
export type InstallSpec = {
    kind: "packed-tarball";
    source: "local";
} | {
    kind: "prebuilt-tarball";
    spec: string;
} | {
    kind: "explicit";
    spec: string;
};
/** Result of validating a packed file surface. */
export interface PackArtifactsResult {
    ok: boolean;
    missing: string[];
    presentCount: number;
}
/** Parsed `npm pack --json` entry. */
export interface ParsedPackJson {
    filename: string;
    packageName: string;
    packageVersion: string;
    packedFiles: string[];
}
/** Injected command/filesystem deps used by `buildLocalTarball`. */
export interface PackRunDeps {
    pack(cwd: string): Promise<{
        code: number;
        stdout: string;
        stderr: string;
    }>;
    remove(path: string): Promise<void>;
}
/** Outcome of packing + surface-validating the local source. */
export interface PackOutcome {
    ok: boolean;
    tarballPath: string | undefined;
    packageName: string | undefined;
    packageVersion: string | undefined;
    packedFiles: string[];
    missing: string[];
    error: string | undefined;
}
/** Source attribution printed in the final report. */
export interface CleanInstallSourceInfo {
    kind: "packed-tarball" | "explicit-spec" | "prebuilt-tarball";
    spec: string;
    tarballPath?: string;
    packageName?: string;
    packageVersion?: string;
    packedFileCount?: number;
    artifactsOk?: boolean;
    missing?: string[];
}
/** Assessment extended with optional source attribution for the report. */
export interface CleanInstallReportResult extends CleanInstallAssessment {
    source?: CleanInstallSourceInfo;
}
/** Whether a spec string denotes a local prepacked npm tarball file. */
export declare function isLocalTarballSpec(spec: string): boolean;
/** Resolve the install spec from CLI args. Default = packed-tarball/local; a
 *  local `.tgz` positional selects the surface-validated prebuilt-tarball path;
 *  any other positional is the explicit escape hatch (github:/git+ specs). */
export declare function resolveInstallSpec(args: string[]): InstallSpec;
/** Pure: check a packed file surface contains every required runtime artifact. */
export declare function checkPackedArtifacts(packedFiles: string[]): PackArtifactsResult;
/**
 * Parse `npm pack --json` stdout. Handles both the current object-keyed
 * shape (`{ "@odiobill/piren": {...} }`) and the older array shape (`[ {...} ]`).
 * Returns null when the output is not parseable or has no filename.
 */
export declare function parseNpmPackJson(stdout: string): ParsedPackJson | null;
/** Whether an install spec needs npm's `--install-links` (git/github only). */
export declare function needsInstallLinks(spec: string): boolean;
/**
 * Build the local tarball via `npm pack --json` using injected deps, then
 * validate its packed surface. The tarball is created in `cwd` (the repo
 * root); the returned `tarballPath` is the absolute path the caller installs
 * and later removes.
 */
export declare function buildLocalTarball(deps: PackRunDeps, cwd: string): Promise<PackOutcome>;
export interface CleanInstallOptions {
    /** Package spec to install, e.g. "github:Odiobill/piren" or a tarball path. */
    spec: string;
    /** npm prefix (install root). Created if missing. */
    prefix: string;
    /** Isolated HOME for the install + verification (clean config dir). */
    cleanHome: string;
    /**
     * PATH for the verification commands. Should contain node, npm, and pi so
     * the Pi runtime policy can be exercised. If the caller wants to exercise
     * the missing-Pi branch, omit pi from this PATH.
     */
    pathEnv: string;
    /** Node binary, defaults to process.execPath. */
    nodeBin?: string;
    /** npm binary, defaults to "npm". */
    npmBin?: string;
    /** Extra args passed to npm install (e.g. ["--no-save"]). */
    npmArgs?: string[];
    /** Whether to pass npm's --allow-scripts flag. Kept for operator compatibility. */
    allowInstallScripts?: boolean;
    /** Whether to delete the prefix/cleanHome at the end. Default false (keep for inspection). */
    cleanup?: boolean;
    /** Optional logger. */
    log?: (message: string) => void;
}
export interface CleanInstallResult extends CleanInstallAssessment {
    probe: CleanInstallProbe;
}
/** Run the clean-install verification end to end against a real npm install. */
export declare function runCleanInstallCheck(options: CleanInstallOptions): Promise<CleanInstallResult>;
/** Real `npm pack` adapter for `buildLocalTarball`. */
export declare function createRealPackDeps(): PackRunDeps;
export interface PackedCheckOptions {
    /** Repo root to pack from (must contain package.json). */
    repoRoot: string;
    /** PATH for verification (node/npm/pi). Defaults to process.env.PATH. */
    pathEnv?: string;
    /** Keep the packed tarball and install dirs for inspection. Default: clean up. */
    keep?: boolean;
    /** Pass npm's --allow-scripts during install. */
    allowInstallScripts?: boolean;
    /** Optional logger. */
    log?: (message: string) => void;
    /** Injected pack deps for tests; defaults to the real npm adapter. */
    packDeps?: PackRunDeps;
    /** Injected install runner for tests; defaults to runCleanInstallCheck. */
    runInstall?: InstallRunner;
}
/** Install runner signature, matching runCleanInstallCheck. Injected for tests. */
export type InstallRunner = (options: CleanInstallOptions) => Promise<CleanInstallResult>;
/**
 * Default clean-install path (ADR-0033 Slice R1): pack the exact local source
 * via `npm pack`, validate the packed surface, then install that tarball into
 * an isolated HOME/prefix and run the existing dist/binary/Pi checks. No
 * `github:` fetch and no `--install-links` in the normal path.
 *
 * Cleanup invariant: any tarball that was produced is removed unless `keep`,
 * including the surface-missing failure path and thrown install errors
 * (enforced by a single try/finally around the whole post-pack body).
 */
export declare function runPackedCleanInstallCheck(options: PackedCheckOptions): Promise<CleanInstallReportResult>;
/** Injected tarball-listing deps (e.g. `tar -tf`) used to inspect a prepacked tarball. */
export interface TarballListDeps {
    list(tarballPath: string): Promise<{
        code: number;
        stdout: string;
        stderr: string;
    }>;
}
/** Parse `tar -tf` output into a list of entry paths (one per non-empty line). */
export declare function parseTarListing(stdout: string): string[];
/** Real `tar -tf` adapter for inspecting a prepacked tarball's surface. */
export declare function createRealTarballListDeps(): TarballListDeps;
export interface PrebuiltCheckOptions {
    /** Absolute path to an existing npm tarball to validate and install. */
    tarballPath: string;
    /** PATH for the install verification (node/npm/pi). Defaults to process.env.PATH. */
    pathEnv?: string;
    /** Injected tarball-listing deps for tests; defaults to the real tar adapter. */
    listDeps?: TarballListDeps;
    /** Injected install runner for tests; defaults to runCleanInstallCheck. */
    runInstall?: InstallRunner;
    /** Optional logger. */
    log?: (message: string) => void;
}
/**
 * Validate and install a PRE-PACKED npm tarball (ADR-0033 P1). This is the
 * publication path's verifier: the caller (the release workflow) owns the
 * tarball, so this validates its packed surface (the same
 * REQUIRED_PACKED_ARTIFACTS contract as the local-pack path) and then installs
 * that exact tarball through the existing `runCleanInstallCheck` machinery. It
 * never removes the tarball — the caller decides its lifecycle (e.g. publish).
 */
export declare function runPrebuiltTarballCheck(options: PrebuiltCheckOptions): Promise<CleanInstallReportResult>;
/**
 * Convenience entry for a full default run against the real github spec.
 * Used by scripts/clean-install-check.ts. Returns the formatted report string.
 */
export declare function defaultCleanInstallCheck(spec: string, opts?: Partial<CleanInstallOptions>): Promise<CleanInstallAssessment>;
