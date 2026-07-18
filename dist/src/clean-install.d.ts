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
/** Required runtime artifacts the packed tarball must ship for the CLI to run. */
export declare const REQUIRED_PACKED_ARTIFACTS: readonly ["dist/src/cli.js", "dist/public/index.html", "dist/src/pi-extension.js"];
/** Discriminated install-spec resolved from CLI args. */
export type InstallSpec = {
    kind: "packed-tarball";
    source: "local";
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
    kind: "packed-tarball" | "explicit-spec";
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
/** Resolve the install spec from CLI args. Default = packed-tarball/local. */
export declare function resolveInstallSpec(args: string[]): InstallSpec;
/** Pure: check a packed file surface contains every required runtime artifact. */
export declare function checkPackedArtifacts(packedFiles: string[]): PackArtifactsResult;
/**
 * Parse `npm pack --json` stdout. Handles both the current object-keyed
 * shape (`{ "piren": {...} }`) and the older array shape (`[ {...} ]`).
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
}
/**
 * Default clean-install path (ADR-0033 Slice R1): pack the exact local source
 * via `npm pack`, validate the packed surface, then install that tarball into
 * an isolated HOME/prefix and run the existing dist/binary/Pi checks. No
 * `github:` fetch and no `--install-links` in the normal path.
 */
export declare function runPackedCleanInstallCheck(options: PackedCheckOptions): Promise<CleanInstallReportResult>;
/**
 * Convenience entry for a full default run against the real github spec.
 * Used by scripts/clean-install-check.ts. Returns the formatted report string.
 */
export declare function defaultCleanInstallCheck(spec: string, opts?: Partial<CleanInstallOptions>): Promise<CleanInstallAssessment>;
