/**
 * `piren update` core.
 *
 * Default behavior: install the scoped registry `latest` package
 * (`npm install -g @odiobill/piren`) — never GitHub `main`, never
 * `--install-links` (that flag is an npm-11 git-dependency workaround only).
 *
 * Before installing, the production CLI resolves the registry target version
 * through an argument-vector process call and refuses a major-version jump
 * unless the operator explicitly passes `--yes` (ADR-0033 non-goal: `piren
 * update` must never silently cross a major-version boundary).
 *
 * The module is split into testable layers:
 *   - `buildUpdateCommand` / `parseSemver` / `planUpdate`: pure, no I/O.
 *   - `resolveRegistryVersion` / `executePirenUpdate`: impure, deps injected.
 *   - `runPirenUpdate`: orchestrator composing the layers; deps injected so unit
 *     tests use no network and no Pi auth.
 */
export interface UpdateCommand {
    command: string;
    args: string[];
}
export interface CommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}
export interface UpdateReport extends UpdateCommand, CommandResult {
    ok: boolean;
}
export interface ExecuteUpdateDeps {
    runCommand: (command: string, args: string[]) => Promise<CommandResult>;
}
/** Canonical npm package spec: the scoped registry `latest` channel. */
export declare const DEFAULT_UPDATE_SPEC = "@odiobill/piren";
/**
 * Build the global install command for a spec. The default registry spec needs
 * no `--install-links` (that is an npm-11 git/github workaround only).
 */
export declare function buildUpdateCommand(spec?: string): UpdateCommand;
export interface Semver {
    major: number;
    minor: number;
    patch: number;
    /** Prerelease identifiers without the leading `-`, or "" when absent. */
    prerelease: string;
    /** Build metadata without the leading `+`, or "" when absent. */
    build: string;
}
/**
 * Parse a strict SemVer string. Returns `null` for any malformed version
 * (wrong arity, leading zeros, non-numeric components, leading `v`, surrounding
 * whitespace, malformed prerelease/build). Does not mutate the input.
 */
export declare function parseSemver(version: string): Semver | null;
export type UpdatePlan = {
    action: "install";
    currentVersion: string;
    targetVersion: string;
    command: UpdateCommand;
} | {
    action: "refuse-major";
    currentVersion: string;
    targetVersion: string;
    command: UpdateCommand;
} | {
    action: "version-error";
    field: "current" | "target";
    version: string;
};
export interface PlanUpdateOptions {
    currentVersion: string;
    targetVersion: string;
    /** When true, a major-version jump installs instead of refusing (`--yes`). */
    allowMajor: boolean;
    /** Defaults to the scoped registry latest spec. */
    spec?: string;
}
/**
 * Decide what `piren update` should do given a current and target version.
 * Pure: performs no I/O. Malformed current or target yields `version-error`
 * (no install); a higher target major yields `refuse-major` unless `allowMajor`.
 */
export declare function planUpdate(options: PlanUpdateOptions): UpdatePlan;
export type RegistryVersionResult = {
    ok: true;
    version: string;
} | {
    ok: false;
    reason: string;
};
/**
 * Resolve the current registry `latest` version for a spec by running
 * `npm view <spec> version` as an argument-vector process call (no shell
 * interpolation). Fails closed on non-zero exit or empty output.
 */
export declare function resolveRegistryVersion(deps: ExecuteUpdateDeps, spec?: string): Promise<RegistryVersionResult>;
/** Run the registry install command and report the npm result. */
export declare function executePirenUpdate(deps: ExecuteUpdateDeps, spec?: string): Promise<UpdateReport>;
export interface RunPirenUpdateOptions {
    /** Installed version, e.g. read from package.json. */
    currentVersion: string;
    /** True when the operator passed `--yes` (permit a major jump). */
    allowMajor: boolean;
    /** Defaults to the scoped registry latest spec. */
    spec?: string;
}
export type RunPirenUpdateOutcome = {
    kind: "installed";
    report: UpdateReport;
} | {
    kind: "refused-major";
    currentVersion: string;
    targetVersion: string;
    command: UpdateCommand;
} | {
    kind: "version-error";
    field: "current" | "target";
    version: string;
} | {
    kind: "resolver-error";
    reason: string;
};
/**
 * Resolve the registry target, plan the update, and (only when the plan is an
 * install) run it. Resolver/version failures and major refusals perform no
 * install. A malformed current version fails fast before any network resolve.
 */
export declare function runPirenUpdate(deps: ExecuteUpdateDeps, options: RunPirenUpdateOptions): Promise<RunPirenUpdateOutcome>;
export declare function formatUpdateReport(report: UpdateReport): string;
/** Render any orchestrator outcome as honest operator-facing text. */
export declare function formatRunPirenUpdate(outcome: RunPirenUpdateOutcome): string;
