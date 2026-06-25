/**
 * Pi package extensibility (ADR-0013).
 *
 * Packages are npm packages that export Pi extensions, declared in
 * `~/.config/piren/config.yml` under the `packages` field. `buildPiRunCommand`
 * resolves each declared package to its installed entry point and appends it as
 * an additional `--extension` flag to the Pi command.
 *
 * This module is the pure core: it takes a list of package names and a resolver
 * function, and returns resolved entry points plus a list of missing packages.
 * The resolver is injected so tests can use a fake without live npm resolution.
 */

export interface PackageEntryResolver {
  (name: string): string;
}

export interface ResolvedPackage {
  name: string;
  path: string;
}

export interface PackageCheck {
  name: string;
  installed: boolean;
  path?: string;
  error?: string;
}

export interface ResolvePackagesResult {
  resolved: ResolvedPackage[];
  missing: string[];
  checks: PackageCheck[];
}

/**
 * Resolve a list of declared package names to their installed entry points.
 *
 * The resolver is injected so the core logic is testable without a live
 * node_modules tree. A package that throws on resolve is recorded as missing
 * rather than crashing resolution, so `piren doctor` can report all missing
 * packages in one pass.
 *
 * Declaration order is preserved: Piren's core extension loads first, then
 * package extensions load in the order declared.
 */
export function resolvePackages(packages: string[], resolver: PackageEntryResolver): ResolvePackagesResult {
  const resolved: ResolvedPackage[] = [];
  const missing: string[] = [];
  const checks: PackageCheck[] = [];

  for (const name of packages) {
    try {
      const path = resolver(name);
      resolved.push({ name, path });
      checks.push({ name, installed: true, path });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      missing.push(name);
      checks.push({ name, installed: false, error: message });
    }
  }

  return { resolved, missing, checks };
}

/**
 * Default entry-point resolver using Node's `require.resolve` to find an
 * installed package's main entry. This is the production resolver; tests inject
 * a fake.
 */
export function defaultPackageResolver(name: string): string {
  // require.resolve resolves a module specifier to its absolute path. For a
  // bare package name, this finds the package's main entry point as defined
  // by its package.json "main" or "exports" field.
  return require.resolve(name);
}
