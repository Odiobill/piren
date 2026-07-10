/**
 * Vault-scoped package manifest core (ADR-0032, Slice F).
 *
 * Package manifests are desired-state metadata at three scopes:
 *   - `packages.yml` at vault root       (shared)
 *   - `agent-groups/<group>/packages.yml` (group)
 *   - `team/<agent>/packages.yml`         (agent)
 *
 * Effective intent = shared + groups + agent, merged deterministically.
 * Local config remains the authority for executable code loading.
 */
export interface PackageManifest {
    type: string;
    required: string[];
    recommended: string[];
}
export type PackageSource = {
    kind: "shared";
} | {
    kind: "group";
    group: string;
} | {
    kind: "agent";
    agent: string;
};
export interface EffectivePackage {
    name: string;
    /** true if this package is required (not recommended) in the effective intent. */
    required: boolean;
    source: PackageSource;
}
export type PackageState = "ok-required" | "ok-recommended" | "missing-from-local-config" | "blocked-by-policy" | "declared-but-not-installed" | "recommended-missing";
export interface DiagnosedPackage {
    name: string;
    required: boolean;
    source: PackageSource;
    state: PackageState;
    detail?: string;
}
/**
 * Parse a YAML string into a PackageManifest.
 *
 * Tolerant of missing fields and malformed YAML: returns empty required/
 * recommended arrays when the input cannot be interpreted as a manifest.
 */
export declare function parsePackageManifest(content: string): PackageManifest;
interface ManifestWithSource {
    source: PackageSource;
    manifest: PackageManifest;
}
/**
 * Merge shared, group, and agent package manifests into the effective
 * package intent for one agent.
 *
 * Resolution order: later scopes override earlier ones on name collision.
 * Within a scope, `recommended` is processed after `required`, so when the
 * same package appears in both lists of a single manifest the recommended
 * entry wins (last-writer).
 */
export declare function mergeEffectivePackages(manifests: ManifestWithSource[]): EffectivePackage[];
/**
 * Diagnose effective packages against local config and Node resolvability.
 *
 * @param effective - Resolved effective packages from vault manifests.
 * @param localPackages - Package names declared in `~/.config/piren/config.yml`
 *   under the `packages` field.
 * @param packageInstalled - A function that returns true if a package name
 *   resolves successfully via `require.resolve`. Injected for testability.
 * @param blockedPackages - Package names declared in
 *   `~/.config/piren/config.yml` under `package_policy.blocked`. When a
 *   vault-declared package name appears here, it is reported as
 *   `blocked-by-policy` regardless of other checks. Read-only; no install or
 *   apply behavior.
 * @returns One DiagnosedPackage per effective package, in the same order.
 */
export declare function diagnosePackages(effective: EffectivePackage[], localPackages: string[], packageInstalled: (name: string) => boolean, blockedPackages?: string[]): DiagnosedPackage[];
/**
 * Format the effective package list for `piren package list --agent <agent>`.
 */
export declare function formatPackageList(effective: EffectivePackage[], agentName: string): string;
/**
 * Format detailed provenance for `piren package explain --agent <agent>`.
 */
export declare function formatPackageExplain(effective: EffectivePackage[], agentName: string): string;
/**
 * Format the package doctor report for `piren package doctor [--agent <agent>]`.
 */
export declare function formatPackageDoctor(diagnosed: DiagnosedPackage[], agentName: string): string;
export {};
