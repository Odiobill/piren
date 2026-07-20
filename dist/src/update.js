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
/** Canonical npm package spec: the scoped registry `latest` channel. */
export const DEFAULT_UPDATE_SPEC = "@odiobill/piren";
/**
 * Build the global install command for a spec. The default registry spec needs
 * no `--install-links` (that is an npm-11 git/github workaround only).
 */
export function buildUpdateCommand(spec = DEFAULT_UPDATE_SPEC) {
    return {
        command: "npm",
        args: ["install", "-g", spec],
    };
}
/**
 * Canonical SemVer 2.0.0 regular expression (semver.org). Rejects leading zeros
 * in numeric version/prerelease identifiers, requires exactly three numeric
 * components, and allows optional prerelease (`-...`) and build (`+...`).
 */
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
/**
 * Parse a strict SemVer string. Returns `null` for any malformed version
 * (wrong arity, leading zeros, non-numeric components, leading `v`, surrounding
 * whitespace, malformed prerelease/build). Does not mutate the input.
 */
export function parseSemver(version) {
    const match = SEMVER_RE.exec(version);
    if (!match)
        return null;
    return {
        major: Number(match[1] ?? "0"),
        minor: Number(match[2] ?? "0"),
        patch: Number(match[3] ?? "0"),
        prerelease: match[4] ?? "",
        build: match[5] ?? "",
    };
}
/**
 * Decide what `piren update` should do given a current and target version.
 * Pure: performs no I/O. Malformed current or target yields `version-error`
 * (no install); a higher target major yields `refuse-major` unless `allowMajor`.
 */
export function planUpdate(options) {
    const { currentVersion, targetVersion, allowMajor } = options;
    const spec = options.spec ?? DEFAULT_UPDATE_SPEC;
    const command = buildUpdateCommand(spec);
    const current = parseSemver(currentVersion);
    if (current === null) {
        return { action: "version-error", field: "current", version: currentVersion };
    }
    const target = parseSemver(targetVersion);
    if (target === null) {
        return { action: "version-error", field: "target", version: targetVersion };
    }
    if (target.major > current.major && !allowMajor) {
        return { action: "refuse-major", currentVersion, targetVersion, command };
    }
    return { action: "install", currentVersion, targetVersion, command };
}
/**
 * Resolve the current registry `latest` version for a spec by running
 * `npm view <spec> version` as an argument-vector process call (no shell
 * interpolation). Fails closed on non-zero exit or empty output.
 */
export async function resolveRegistryVersion(deps, spec = DEFAULT_UPDATE_SPEC) {
    const result = await deps.runCommand("npm", ["view", spec, "version"]);
    if (result.exitCode !== 0) {
        return { ok: false, reason: `npm view ${spec} version failed (exit ${result.exitCode})` };
    }
    const version = result.stdout.trim();
    if (version.length === 0) {
        return { ok: false, reason: `npm view ${spec} version returned no version` };
    }
    return { ok: true, version };
}
// ---------------------------------------------------------------------------
// Low-level install executor (impure, deps injected).
// ---------------------------------------------------------------------------
/** Run the registry install command and report the npm result. */
export async function executePirenUpdate(deps, spec = DEFAULT_UPDATE_SPEC) {
    const update = buildUpdateCommand(spec);
    const result = await deps.runCommand(update.command, update.args);
    return {
        ...update,
        ...result,
        ok: result.exitCode === 0,
    };
}
/**
 * Resolve the registry target, plan the update, and (only when the plan is an
 * install) run it. Resolver/version failures and major refusals perform no
 * install. A malformed current version fails fast before any network resolve.
 */
export async function runPirenUpdate(deps, options) {
    const { currentVersion, allowMajor } = options;
    const spec = options.spec ?? DEFAULT_UPDATE_SPEC;
    // Fail fast: a malformed current version skips the network resolve entirely.
    if (parseSemver(currentVersion) === null) {
        return { kind: "version-error", field: "current", version: currentVersion };
    }
    const resolved = await resolveRegistryVersion(deps, spec);
    if (!resolved.ok) {
        return { kind: "resolver-error", reason: resolved.reason };
    }
    const plan = planUpdate({ currentVersion, targetVersion: resolved.version, allowMajor, spec });
    if (plan.action === "version-error") {
        return { kind: "version-error", field: plan.field, version: plan.version };
    }
    if (plan.action === "refuse-major") {
        return { kind: "refused-major", currentVersion, targetVersion: plan.targetVersion, command: plan.command };
    }
    const report = await executePirenUpdate(deps, spec);
    return { kind: "installed", report };
}
// ---------------------------------------------------------------------------
// Formatters.
// ---------------------------------------------------------------------------
export function formatUpdateReport(report) {
    const lines = [
        `Piren update: ${report.ok ? "ok" : "failed"}`,
        `command: ${[report.command, ...report.args].join(" ")}`,
        `exit_code: ${report.exitCode}`,
    ];
    const stdout = report.stdout.trim();
    const stderr = report.stderr.trim();
    if (stdout) {
        lines.push("", "stdout:", stdout);
    }
    if (stderr) {
        lines.push("", "stderr:", stderr);
    }
    return lines.join("\n");
}
/** Render any orchestrator outcome as honest operator-facing text. */
export function formatRunPirenUpdate(outcome) {
    switch (outcome.kind) {
        case "installed":
            return formatUpdateReport(outcome.report);
        case "refused-major":
            return [
                "Piren update: refused (major version increase).",
                `current: ${outcome.currentVersion}`,
                `target:  ${outcome.targetVersion}`,
                "",
                "A major version update may include breaking changes.",
                "To allow this update, run:",
                "  piren update --yes",
                "",
                "No changes were made.",
            ].join("\n");
        case "version-error":
            return [
                "Piren update: aborted.",
                `The ${outcome.field} version "${outcome.version}" is not a valid semantic version.`,
                "No changes were made.",
            ].join("\n");
        case "resolver-error":
            return [
                "Piren update: aborted.",
                `Could not resolve the latest registry version: ${outcome.reason}`,
                "No changes were made.",
            ].join("\n");
    }
}
//# sourceMappingURL=update.js.map