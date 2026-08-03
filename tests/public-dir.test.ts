import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePublicDir } from "../src/public-dir.js";

/**
 * ADR-0041 R3b-1: source-vs-compiled public-dir resolution.
 *
 * The compiled CLI (dist/src/cli.js) resolves dist/src/../public -> dist/public.
 * A source runtime (tsx src/cli.ts) must now select the built dist/public
 * assets directly because the legacy public/ directory is retired by the
 * in-place React/Vite migration. Both branches must deterministically converge
 * on <repo>/dist/public, with no filesystem probe and no legacy fallback.
 */
describe("resolvePublicDir (R3b-1 source-vs-compiled static path)", () => {
  it("resolves a source module dir (src/cli.ts via tsx) to <repo>/dist/public", () => {
    const repo = join(process.cwd(), "repo");
    expect(resolvePublicDir(join(repo, "src"))).toBe(join(repo, "dist", "public"));
  });

  it("resolves a compiled module dir (dist/src/cli.js) to <repo>/dist/public", () => {
    const repo = join(process.cwd(), "repo");
    expect(resolvePublicDir(join(repo, "dist", "src"))).toBe(join(repo, "dist", "public"));
  });

  it("never resolves a source module dir to the retired legacy public/ directory", () => {
    const repo = join(process.cwd(), "repo");
    expect(resolvePublicDir(join(repo, "src"))).not.toBe(join(repo, "public"));
  });
});
