import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Release-tree guard (0.2.1 blocker): the committed `dist/` tree must contain
 * every generated module the compiled gateway imports. A local `npm run build`
 * emits into the gitignored `dist/` directory, which can mask an omitted
 * committed file; `git ls-files --error-unmatch` proves the module is tracked
 * in the index (not merely present from a local build), so this test also runs
 * correctly in a clean CI checkout where no build has happened yet.
 */
const root = process.cwd();

function gitTracked(rel: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", rel], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

describe("release tree: committed generated dist modules (0.2.1 blocker)", () => {
  it("tracks the compiled workbench-config module required by the gateway", () => {
    for (const rel of [
      "dist/src/workbench-config.js",
      "dist/src/workbench-config.d.ts",
      "dist/src/workbench-config.js.map",
    ]) {
      expect(existsSync(join(root, rel)), `${rel} must exist`).toBe(true);
      expect(gitTracked(rel), `${rel} must be git-tracked`).toBe(true);
    }
  });

  it("pins the gateway's compiled import target inside the release tree", () => {
    const gateway = readFileSync(join(root, "dist/src/gateway-http.js"), "utf8");
    expect(gateway).toContain('"./workbench-config.js"');
  });
});
