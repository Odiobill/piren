import { describe, expect, it } from "vitest";
import {
  parseVaultListResponse,
  parseVaultReadResponse,
  sortVaultEntries,
  vaultBreadcrumb,
  isVaultDirectoryEntry,
  VAULT_ROOT_PATH,
  type VaultEntry,
} from "../web/src/vault-explorer.js";

/**
 * W2 (accepted companion split architecture Phase B; 0.2.0 amendment §4) —
 * pure Vault Explorer cores: strict fail-closed parsers for the EXISTING
 * GET /api/vault/list and GET /api/vault/read response shapes, plus the
 * deterministic navigation helpers (dirs-then-files ordering and breadcrumb
 * paths). Framework-free; the browser never derives vault paths from
 * anything other than server entries or the bounded root.
 */

function fileEntry(name: string, overrides: Partial<VaultEntry> = {}): VaultEntry {
  const entry: VaultEntry = { name, path: name, type: "file", bytes: 10, mtimeMs: 1, ...overrides };
  return entry;
}

describe("parseVaultListResponse", () => {
  it("parses a valid list response exactly", () => {
    const response = parseVaultListResponse({
      path: ".",
      entries: [
        { name: "team", path: "team", type: "directory", mtimeMs: 5 },
        { name: "index.md", path: "index.md", type: "file", bytes: 12, mtimeMs: 3 },
      ],
      capped: false,
    });
    expect(response).toEqual({
      path: ".",
      entries: [
        { name: "team", path: "team", type: "directory", mtimeMs: 5 },
        { name: "index.md", path: "index.md", type: "file", bytes: 12, mtimeMs: 3 },
      ],
      capped: false,
    });
  });

  it("fails closed on a non-record payload", () => {
    expect(() => parseVaultListResponse(null)).toThrow();
    expect(() => parseVaultListResponse([])).toThrow();
    expect(() => parseVaultListResponse("x")).toThrow();
  });

  it("fails closed on a missing/non-array entries list", () => {
    expect(() => parseVaultListResponse({ path: ".", capped: false })).toThrow();
    expect(() => parseVaultListResponse({ path: ".", entries: "x", capped: false })).toThrow();
  });

  it("fails closed on an unknown entry type or a malformed entry", () => {
    const base = { path: ".", capped: false };
    expect(() => parseVaultListResponse({ ...base, entries: [{ name: "x", path: "x", type: "symlink", mtimeMs: 1 }] })).toThrow();
    expect(() => parseVaultListResponse({ ...base, entries: [{ name: 5, path: "x", type: "file", mtimeMs: 1 }] })).toThrow();
    expect(() => parseVaultListResponse({ ...base, entries: [{ name: "x", path: "x", type: "file" }] })).toThrow();
    expect(() => parseVaultListResponse({ ...base, entries: [{ name: "x", path: "x", type: "file", mtimeMs: "1" }] })).toThrow();
  });

  it("fails closed on a malformed bytes or capped value", () => {
    const base = { path: ".", entries: [fileEntry("a.md")] };
    expect(() => parseVaultListResponse({ ...base, entries: [{ ...fileEntry("a.md"), bytes: "10" }] })).toThrow();
    expect(() => parseVaultListResponse({ ...base, capped: "no" })).toThrow();
  });

  it("tolerates a missing optional bytes (directories) but requires a valid mtimeMs", () => {
    const response = parseVaultListResponse({
      path: "team",
      entries: [{ name: "dipu", path: "team/dipu", type: "directory", mtimeMs: 7 }],
      capped: true,
    });
    expect(response.entries[0]?.bytes).toBeUndefined();
    expect(response.capped).toBe(true);
  });
});

describe("parseVaultReadResponse", () => {
  it("parses a valid read response exactly", () => {
    const response = parseVaultReadResponse({
      path: "index.md",
      content: "# Hello",
      bytes: 8,
      mtimeMs: 3,
      capped: false,
    });
    expect(response).toEqual({ path: "index.md", content: "# Hello", bytes: 8, mtimeMs: 3, capped: false });
  });

  it("fails closed on missing/malformed fields", () => {
    expect(() => parseVaultReadResponse({ path: "x", bytes: 1, mtimeMs: 1, capped: false })).toThrow();
    expect(() => parseVaultReadResponse({ path: "x", content: "c", bytes: "1", mtimeMs: 1, capped: false })).toThrow();
    expect(() => parseVaultReadResponse({ path: "x", content: "c", bytes: 1, mtimeMs: 1 })).toThrow();
    expect(() => parseVaultReadResponse("bad")).toThrow();
  });
});

describe("vault navigation helpers", () => {
  it("uses the bounded root path dot", () => {
    expect(VAULT_ROOT_PATH).toBe(".");
  });

  it("isVaultDirectoryEntry recognizes directories only", () => {
    expect(isVaultDirectoryEntry({ name: "d", path: "d", type: "directory", mtimeMs: 1 })).toBe(true);
    expect(isVaultDirectoryEntry(fileEntry("f.md"))).toBe(false);
    expect(isVaultDirectoryEntry({ name: "o", path: "o", type: "other", mtimeMs: 1 })).toBe(false);
  });

  it("builds the breadcrumb from vault-relative segments with accumulated paths", () => {
    expect(vaultBreadcrumb(".")).toEqual([]);
    expect(vaultBreadcrumb("team")).toEqual([{ name: "team", path: "team" }]);
    expect(vaultBreadcrumb("team/dipu")).toEqual([
      { name: "team", path: "team" },
      { name: "dipu", path: "team/dipu" },
    ]);
  });

  it("sorts directories first then files (alpha within each), other last", () => {
    const entries: VaultEntry[] = [
      fileEntry("zeta.md"),
      { name: "alpha", path: "alpha", type: "directory", mtimeMs: 1 },
      fileEntry("beta.md"),
      { name: "gamma", path: "gamma", type: "directory", mtimeMs: 1 },
      { name: "odd", path: "odd", type: "other", mtimeMs: 1 },
    ];
    const sorted = sortVaultEntries(entries);
    expect(sorted.map((e) => e.name)).toEqual(["alpha", "gamma", "beta.md", "zeta.md", "odd"]);
  });
});
