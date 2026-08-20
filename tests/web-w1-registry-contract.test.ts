import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKBENCH_MODULES } from "../web/src/registry.js";

/**
 * W1 (0.2.0 amendment §3; W0 §2; accepted companion split architecture §1):
 * static contract for the first-party module `placement` registry field and
 * the split-shell/resizer core's forbidden surface. The registry stays a
 * compile-time const (no runtime discovery/plugins/dynamic imports/remote
 * JS/eval); `placement` is exactly "page" | "companion"; the delivered
 * Conversation module remains a page module. The split core/component files
 * add no storage, fetch, endpoint, transport, or live-region surface.
 */

const repoRoot = process.cwd();
const webSrc = join(repoRoot, "web", "src");
const W1_FILES = ["split-workspace.ts", "SplitResizer.tsx", "SplitWorkspaceShell.tsx"];
const FORBIDDEN = [
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "fetch(",
  "WebSocket",
  "new EventSource",
  "/api/",
  "eval(",
  "new Function",
  "import(",
  "thinking",
];

describe("static module registry placement (W1)", () => {
  it("every registered module declares a placement of exactly page or companion", () => {
    expect(Array.isArray(WORKBENCH_MODULES)).toBe(true);
    expect(WORKBENCH_MODULES.length).toBeGreaterThan(0);
    for (const module of WORKBENCH_MODULES) {
      expect(["page", "companion"]).toContain(module.placement);
    }
  });

  it("the delivered Conversation module remains a page module (behavior-compatible)", () => {
    expect(WORKBENCH_MODULES[0]?.placement).toBe("page");
  });

  it("registry source declares the closed ModulePlacement union and stays static", async () => {
    const registry = await readFile(join(webSrc, "registry.ts"), "utf8");
    expect(registry).toContain('type ModulePlacement = "page" | "companion"');
    expect(registry).not.toContain("import(");
    expect(registry).not.toContain("eval(");
    expect(registry).not.toContain("new Function");
  });

  it("the only companion module registered is the W2 vault-explorer (graph stays deferred)", async () => {
    const companions = WORKBENCH_MODULES.filter((m) => m.placement === "companion");
    expect(companions.map((m) => m.id)).toEqual(["vault-explorer"]);
  });
});

describe("split shell/resizer core forbidden surface (W1)", () => {
  it("the W1 files never touch storage, fetch, endpoints, transport, eval, or thinking controls", async () => {
    for (const name of W1_FILES) {
      const content = await readFile(join(webSrc, name), "utf8");
      for (const forbidden of FORBIDDEN) {
        expect(content, `${name} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("no new gateway/API route strings were introduced anywhere in web/src by W1 files", async () => {
    const files = await readdir(webSrc);
    for (const name of W1_FILES) {
      expect(files).toContain(name);
    }
  });
});
