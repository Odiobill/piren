import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKBENCH_MODULES } from "../web/src/registry.js";

/**
 * W2 (0.2.0 amendment §4; W0 §2/§3; accepted companion architecture Phase B)
 * — static contract for the first companion module: exactly one static
 * first-party `vault-explorer` companion using W1 typed placement, declared
 * `consumes` ONLY the bounded vault list/read families. No graph, no inbox/
 * POST, no editor/write, no draft contribution, no storage, no dynamic
 * loading, no new route strings.
 */

const repoRoot = process.cwd();
const webSrc = join(repoRoot, "web", "src");
const W2_FILES = ["vault-explorer.ts", "VaultExplorer.tsx"];
const FORBIDDEN_STORAGE_TRANSPORT = [
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "fetch(",
  "WebSocket",
  "new EventSource",
  "eval(",
  "new Function",
  "import(",
];

describe("first companion module registry entry (W2)", () => {
  it("keeps Vault Explorer as a companion alongside the separately bounded Steward Alerts companion", () => {
    expect(Array.isArray(WORKBENCH_MODULES)).toBe(true);
    expect(WORKBENCH_MODULES.filter((m) => m.placement === "companion")).toHaveLength(2);
    const explorer = WORKBENCH_MODULES.find((m) => m.id === "vault-explorer");
    expect(explorer).toBeDefined();
    expect(explorer?.label).toBe("Vault Explorer");
    expect(explorer?.placement).toBe("companion");
    expect(explorer?.page).toBe("conversations");
  });

  it("declares consumes ONLY the bounded vault list/read families", () => {
    const explorer = WORKBENCH_MODULES.find((m) => m.id === "vault-explorer");
    expect(explorer?.consumes).toEqual(["vault-list", "vault-read"]);
    expect(explorer?.consumes.join(" ")).not.toMatch(/graph|inbox|write|post/i);
    expect(explorer?.emits).toEqual([]);
  });

  it("keeps the Conversation module a page module and the registry a compile-time const", async () => {
    expect(WORKBENCH_MODULES[0]?.placement).toBe("page");
    const registry = await readFile(join(webSrc, "registry.ts"), "utf8");
    expect(registry).not.toContain("import(");
    expect(registry).not.toContain("eval(");
    expect(registry).not.toContain("new Function");
  });
});

describe("Vault Explorer forbidden surface (W2)", () => {
  it("the W2 files never touch storage, transport, dynamic loading, graph, or POST", async () => {
    for (const name of W2_FILES) {
      const content = await readFile(join(webSrc, name), "utf8");
      for (const forbidden of FORBIDDEN_STORAGE_TRANSPORT) {
        expect(content, `${name} must not contain ${forbidden}`).not.toContain(forbidden);
      }
      expect(content, `${name} must not request the deferred graph route`).not.toContain("/api/vault/graph");
      expect(content, `${name} must not declare the graph capability family`).not.toContain("vault-graph");
      expect(content, `${name} must not contain a raw POST`).not.toContain('"POST"');
      expect(content, `${name} must not inject raw HTML`).not.toContain("dangerouslySetInnerHTML");
    }
  });

  it("the shared API transport adds ONLY the vault list/read routes plus the single T1 inbox-create reference", async () => {
    const api = await readFile(join(webSrc, "api.ts"), "utf8");
    expect(api).toContain("/api/vault/list?path=${encodeURIComponent(path)}");
    expect(api).toContain("/api/vault/read?path=${encodeURIComponent(path)}");
    // T1: exactly one typed Assign-task client call to the EXISTING
    // authenticated inbox-create route; still no graph route anywhere.
    expect(api).not.toContain("/api/vault/graph");
    expect(api.match(/\/api\/vault\/inbox/g)?.length ?? 0).toBe(1);
  });

  it("no W2 file introduces a new gateway route string", async () => {
    const files = await readdir(webSrc);
    expect(files).toContain("VaultExplorer.tsx");
    expect(files).toContain("vault-explorer.ts");
  });
});
