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
export type PiRuntimeSource = "path" | "npx-latest" | "unavailable";
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
export declare function formatCleanInstallReport(report: CleanInstallAssessment): string;
export interface CleanInstallOptions {
    /** Package spec to install, e.g. "github:Odiobill/piren" or a tarball path. */
    spec: string;
    /** npm prefix (install root). Created if missing. */
    prefix: string;
    /** Isolated HOME for the install + verification (clean config dir). */
    cleanHome: string;
    /**
     * PATH for the verification commands. Should contain node, npm, and at
     * least one of pi/npx so the Pi runtime policy can be exercised. If the
     * caller wants to force the npx-latest branch, omit pi from this PATH.
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
/**
 * Convenience entry for a full default run against the real github spec.
 * Used by scripts/clean-install-check.ts. Returns the formatted report string.
 */
export declare function defaultCleanInstallCheck(spec: string, opts?: Partial<CleanInstallOptions>): Promise<CleanInstallAssessment>;
