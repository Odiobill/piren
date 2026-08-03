import { basename, dirname, join } from "node:path";

/**
 * Resolve the gateway's static frontend directory relative to this module's
 * location (ADR-0041 R3b-1).
 *
 * Compiled CLI (dist/src/cli.js): `dist/src/../public` -> `dist/public`.
 * Source runtime (src/cli.ts via tsx): the legacy `public/` directory is
 * retired by the in-place React/Vite migration, so select the built
 * `dist/public` assets directly. Both branches deterministically converge on
 * `<repo>/dist/public`, with no filesystem probe and no legacy fallback.
 *
 * Consequence: a source `piren gateway` requires the build to have run first
 * (the vite build emits `dist/public`); until then static GETs return 404.
 */
export function resolvePublicDir(moduleDir: string): string {
  const isCompiled = basename(dirname(moduleDir)) === "dist";
  return isCompiled
    ? join(moduleDir, "..", "public")
    : join(moduleDir, "..", "dist", "public");
}
