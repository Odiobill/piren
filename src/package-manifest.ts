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

import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PackageManifest {
  type: string;
  required: string[];
  recommended: string[];
}

export type PackageSource =
  | { kind: "shared" }
  | { kind: "group"; group: string }
  | { kind: "agent"; agent: string };

export interface EffectivePackage {
  name: string;
  /** true if this package is required (not recommended) in the effective intent. */
  required: boolean;
  source: PackageSource;
}

export type PackageState =
  | "ok-required"
  | "ok-recommended"
  | "missing-from-local-config"
  | "blocked-by-policy"
  | "declared-but-not-installed"
  | "recommended-missing";

export interface DiagnosedPackage {
  name: string;
  required: boolean;
  source: PackageSource;
  state: PackageState;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/**
 * Parse a YAML string into a PackageManifest.
 *
 * Tolerant of missing fields and malformed YAML: returns empty required/
 * recommended arrays when the input cannot be interpreted as a manifest.
 */
export function parsePackageManifest(content: string): PackageManifest {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return { type: "Package Manifest", required: [], recommended: [] };
  }
  const record = isRecord(parsed) ? parsed : {};
  return {
    type: typeof record.type === "string" ? record.type : "Package Manifest",
    required: asStringArray(record.required),
    recommended: asStringArray(record.recommended),
  };
}

// ---------------------------------------------------------------------------
// Manifest merging
// ---------------------------------------------------------------------------

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
export function mergeEffectivePackages(
  manifests: ManifestWithSource[],
): EffectivePackage[] {
  const map = new Map<string, EffectivePackage>();

  for (const { source, manifest } of manifests) {
    // required first, then recommended (so recommended wins on collision
    // within a single manifest)
    for (const name of manifest.required) {
      if (name.trim() === "") continue;
      map.set(name, { name, required: true, source });
    }
    for (const name of manifest.recommended) {
      if (name.trim() === "") continue;
      map.set(name, { name, required: false, source });
    }
  }

  // Preserve declaration order: first occurrence of each name determines
  // position in the output.
  const seen = new Set<string>();
  const result: EffectivePackage[] = [];
  for (const { source, manifest } of manifests) {
    for (const name of [...manifest.required, ...manifest.recommended]) {
      if (name.trim() === "" || seen.has(name)) continue;
      const entry = map.get(name);
      if (entry !== undefined) {
        result.push(entry);
        seen.add(name);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Doctor / diagnostic
// ---------------------------------------------------------------------------

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
export function diagnosePackages(
  effective: EffectivePackage[],
  localPackages: string[],
  packageInstalled: (name: string) => boolean,
  blockedPackages?: string[],
): DiagnosedPackage[] {
  const localSet = new Set(localPackages);
  const blockedSet = new Set(blockedPackages ?? []);

  return effective.map((pkg): DiagnosedPackage => {
    // blocked-by-policy takes precedence: if the package is explicitly blocked
    // in local config, report it regardless of install/declaration status.
    if (blockedSet.has(pkg.name)) {
      return {
        name: pkg.name,
        required: pkg.required,
        source: pkg.source,
        state: "blocked-by-policy",
        detail: "blocked by local package_policy",
      };
    }

    const inLocalConfig = localSet.has(pkg.name);

    if (!inLocalConfig) {
      if (pkg.required) {
        return {
          name: pkg.name,
          required: true,
          source: pkg.source,
          state: "missing-from-local-config",
          detail: "not declared in local config packages list",
        };
      }
      return {
        name: pkg.name,
        required: false,
        source: pkg.source,
        state: "recommended-missing",
        detail: "recommended package not in local config",
      };
    }

    // Package is in local config — check if it is installed
    const installed = packageInstalled(pkg.name);
    if (!installed) {
      return {
        name: pkg.name,
        required: pkg.required,
        source: pkg.source,
        state: "declared-but-not-installed",
        detail: "declared in local config but require.resolve failed",
      };
    }

    // Installed and in local config
    return {
      name: pkg.name,
      required: pkg.required,
      source: pkg.source,
      state: pkg.required ? "ok-required" : "ok-recommended",
      detail: "installed",
    };
  });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatSource(source: PackageSource): string {
  if (source.kind === "shared") return "shared (packages.yml)";
  if (source.kind === "group") return `group/${source.group} (agent-groups/${source.group}/packages.yml)`;
  return `agent/${source.agent} (team/${source.agent}/packages.yml)`;
}

function formatState(state: PackageState): string {
  const labels: Record<PackageState, string> = {
    "ok-required": "OK (required, installed)",
    "ok-recommended": "OK (recommended, installed)",
    "missing-from-local-config": "MISSING-FROM-LOCAL-CONFIG",
    "blocked-by-policy": "BLOCKED-BY-POLICY",
    "declared-but-not-installed": "DECLARED-BUT-NOT-INSTALLED",
    "recommended-missing": "RECOMMENDED-MISSING",
  };
  return labels[state] ?? state;
}

/**
 * Format the effective package list for `piren package list --agent <agent>`.
 */
export function formatPackageList(
  effective: EffectivePackage[],
  agentName: string,
): string {
  const lines = [`Effective packages for agent '${agentName}':`];
  if (effective.length === 0) {
    lines.push("  <none>");
    return lines.join("\n");
  }

  const required = effective.filter((p) => p.required);
  const recommended = effective.filter((p) => !p.required);

  if (required.length > 0) {
    lines.push("  Required:");
    for (const pkg of required) {
      lines.push(`    ${pkg.name}  (source: ${formatSource(pkg.source)})`);
    }
  }
  if (recommended.length > 0) {
    lines.push("  Recommended:");
    for (const pkg of recommended) {
      lines.push(`    ${pkg.name}  (source: ${formatSource(pkg.source)})`);
    }
  }

  return lines.join("\n");
}

/**
 * Format detailed provenance for `piren package explain --agent <agent>`.
 */
export function formatPackageExplain(
  effective: EffectivePackage[],
  agentName: string,
): string {
  const lines = [`Package provenance for agent '${agentName}':`];
  if (effective.length === 0) {
    lines.push("  No packages declared in any vault manifest.");
    return lines.join("\n");
  }

  for (const pkg of effective) {
    const kind = pkg.required ? "required" : "recommended";
    lines.push(`  ${pkg.name}:`);
    lines.push(`    Kind:     ${kind}`);
    lines.push(`    Source:   ${formatSource(pkg.source)}`);

    if (pkg.source.kind === "group") {
      lines.push(`    Scope:    Group '${pkg.source.group}' declares this package for all its agents.`);
    } else if (pkg.source.kind === "shared") {
      lines.push(`    Scope:    Vault-wide shared intent.`);
    } else {
      lines.push(`    Scope:    Agent-specific declaration.`);
    }
  }

  return lines.join("\n");
}

/**
 * Format the package doctor report for `piren package doctor [--agent <agent>]`.
 */
export function formatPackageDoctor(
  diagnosed: DiagnosedPackage[],
  agentName: string,
): string {
  const lines = [`Package doctor for agent '${agentName}':`];
  if (diagnosed.length === 0) {
    lines.push("  No packages declared in vault manifests.");
    return lines.join("\n");
  }

  let hasIssues = false;
  for (const pkg of diagnosed) {
    if (pkg.state.startsWith("ok")) continue;
    hasIssues = true;
    lines.push(`  ${pkg.name}:`);
    lines.push(`    State:    ${formatState(pkg.state)}`);
    lines.push(`    Required: ${pkg.required ? "yes" : "no (recommended)"}`);
    lines.push(`    Source:   ${formatSource(pkg.source)}`);
    if (pkg.detail !== undefined) {
      lines.push(`    Detail:   ${pkg.detail}`);
    }
  }

  if (!hasIssues) {
    lines.push("  All packages are present and installed.");
  }

  // Summary
  const counts: Record<PackageState, number> = {
    "ok-required": 0,
    "ok-recommended": 0,
    "missing-from-local-config": 0,
    "blocked-by-policy": 0,
    "declared-but-not-installed": 0,
    "recommended-missing": 0,
  };
  for (const pkg of diagnosed) {
    counts[pkg.state] = (counts[pkg.state] ?? 0) + 1;
  }

  lines.push("");
  lines.push("Summary:");
  lines.push(`  required (OK):            ${counts["ok-required"]}`);
  lines.push(`  recommended (OK):         ${counts["ok-recommended"]}`);
  lines.push(`  missing-from-local-config: ${counts["missing-from-local-config"]}`);
  lines.push(`  blocked-by-policy:         ${counts["blocked-by-policy"]}`);
  lines.push(`  declared-but-not-installed: ${counts["declared-but-not-installed"]}`);
  lines.push(`  recommended-missing:       ${counts["recommended-missing"]}`);

  return lines.join("\n");
}
