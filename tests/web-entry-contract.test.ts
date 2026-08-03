import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import viteConfig from "../web/vite.config.js";

/**
 * ADR-0041 R3b-1: static contract for the React/Vite workbench foundation.
 *
 * Pins the accepted ESM-safe build contract before any implementation:
 *   - `web/index.html` is the Vite entry and mounts `#root` from `/src/main.tsx`;
 *   - `web/vite.config.ts` derives its root from `import.meta.url` and emits to
 *     an absolute `<repo>/dist/public` (the compiled CLI's static directory);
 *   - the repo build script runs `vite build --config web/vite.config.ts` and
 *     no longer copies a legacy `public/` directory;
 *   - React stays a devDependency: the shipped runtime deps remain typebox+yaml;
 *   - the workbench source never touches browser storage (R3a-1 §3 rule).
 */
const repoRoot = process.cwd();
const webRoot = join(repoRoot, "web");

describe("web workbench entry and build contract (R3b-1)", () => {
  it("web/index.html is the Vite entry referencing the React mount", async () => {
    const html = await readFile(join(webRoot, "index.html"), "utf8");
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('src="/src/main.tsx"');
  });

  it("vite.config.ts derives root from import.meta.url and emits to <repo>/dist/public", () => {
    const cfg = viteConfig as {
      root: string;
      build: { outDir: string; emptyOutDir: boolean };
    };
    // Root is the web/ directory, derived ESM-safely (not CWD-dependent).
    expect(resolve(cfg.root)).toBe(resolve(webRoot));
    // Absolute outDir resolves to the compiled CLI's static dir.
    expect(cfg.build.outDir).toBe(join(repoRoot, "dist", "public"));
    expect(cfg.build.emptyOutDir).toBe(true);
  });

  it("build script runs vite build and drops the legacy cpSync copy", async () => {
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.build).toContain("vite build --config web/vite.config.ts");
    expect(pkg.scripts.build).not.toContain("cpSync");
    expect(pkg.scripts.build).not.toContain("'public'");
  });

  it("keeps React a devDependency and runtime deps unchanged", async () => {
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies).toEqual({ typebox: "1.2.19", yaml: "^2.8.1" });
    expect(pkg.devDependencies.react).toBeDefined();
    expect(pkg.devDependencies["react-dom"]).toBeDefined();
    expect(pkg.devDependencies.vite).toBeDefined();
  });

  it("workbench source never uses browser storage APIs", async () => {
    const srcDir = join(webRoot, "src");
    const files = await readdir(srcDir, { recursive: true });
    const tsFiles = files.filter((f) => typeof f === "string" && (f.endsWith(".ts") || f.endsWith(".tsx")));
    expect(tsFiles.length).toBeGreaterThan(0);
    for (const f of tsFiles) {
      const content = await readFile(join(srcDir, f), "utf8");
      expect(content, `${f} must not use localStorage`).not.toContain("localStorage");
      expect(content, `${f} must not use sessionStorage`).not.toContain("sessionStorage");
    }
  });
});
