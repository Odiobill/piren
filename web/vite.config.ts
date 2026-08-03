import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ESM-safe root derivation (ADR-0041 R3a-2 accepted contract): this
// repository is "type": "module", so __dirname is unavailable; the root and
// outDir are derived from import.meta.url so the build is independent of the
// invoking working directory. The absolute outDir emits the workbench into
// dist/public, the compiled CLI's static directory (src/public-dir.ts).
const webRoot = dirname(fileURLToPath(import.meta.url));

export default {
  root: webRoot,
  logLevel: "error",
  esbuild: {
    // React 19 automatic JSX runtime: no per-file React import needed and no
    // @vitejs/plugin-react dependency (keeps the devDependency surface small).
    jsx: "automatic",
  },
  build: {
    outDir: resolve(webRoot, "../dist/public"),
    emptyOutDir: true,
  },
};
