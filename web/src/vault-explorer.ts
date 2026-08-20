/**
 * W2 (0.2.0 scope amendment §4; accepted companion split architecture
 * Phase B) — pure Vault Explorer cores: strict fail-closed parsers for the
 * EXISTING vault list and vault read response shapes, and
 * deterministic navigation helpers. Framework-free; the browser never derives
 * a vault path from anything other than a server entry's `path` or the
 * bounded root; query paths are encoded by the api transport.
 */

/** The bounded explorer root path (the vault root). */
export const VAULT_ROOT_PATH = ".";

export type VaultEntryType = "file" | "directory" | "other";

export interface VaultEntry {
  name: string;
  /** Vault-relative path from the server listing (never client-derived). */
  path: string;
  type: VaultEntryType;
  /** File size in bytes (directories omit it). */
  bytes?: number;
  mtimeMs: number;
}

export interface VaultListResponse {
  path: string;
  entries: VaultEntry[];
  capped: boolean;
}

export interface VaultReadResponse {
  path: string;
  content: string;
  bytes: number;
  mtimeMs: number;
  capped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const VALID_ENTRY_TYPES: readonly VaultEntryType[] = ["file", "directory", "other"];

/** Fail-closed parser for one list entry; throws on any structural violation. */
export function parseVaultEntry(json: unknown): VaultEntry {
  if (!isRecord(json) || !isString(json.name) || !isString(json.path)) {
    throw new Error("unexpected vault entry");
  }
  if (json.name === "" || json.path === "") {
    throw new Error("unexpected vault entry");
  }
  if (!VALID_ENTRY_TYPES.includes(json.type as VaultEntryType)) {
    throw new Error("unexpected vault entry type");
  }
  if (!isFiniteNumber(json.mtimeMs)) {
    throw new Error("unexpected vault entry mtime");
  }
  const entry: VaultEntry = {
    name: json.name,
    path: json.path,
    type: json.type as VaultEntryType,
    mtimeMs: json.mtimeMs,
  };
  if (json.bytes !== undefined) {
    if (!isFiniteNumber(json.bytes) || (json.bytes as number) < 0) {
      throw new Error("unexpected vault entry bytes");
    }
    entry.bytes = json.bytes;
  }
  return entry;
}

/** Fail-closed parser for the vault list response. */
export function parseVaultListResponse(json: unknown): VaultListResponse {
  if (!isRecord(json) || !isString(json.path) || !Array.isArray(json.entries) || typeof json.capped !== "boolean") {
    throw new Error("unexpected vault list response");
  }
  return { path: json.path, entries: json.entries.map(parseVaultEntry), capped: json.capped };
}

/** Fail-closed parser for the vault read response. */
export function parseVaultReadResponse(json: unknown): VaultReadResponse {
  if (
    !isRecord(json) ||
    !isString(json.path) ||
    !isString(json.content) ||
    !isFiniteNumber(json.bytes) ||
    !isFiniteNumber(json.mtimeMs) ||
    typeof json.capped !== "boolean"
  ) {
    throw new Error("unexpected vault read response");
  }
  return { path: json.path, content: json.content, bytes: json.bytes, mtimeMs: json.mtimeMs, capped: json.capped };
}

/** True for directory entries (the only navigable kind). */
export function isVaultDirectoryEntry(entry: VaultEntry): boolean {
  return entry.type === "directory";
}

/**
 * Deterministic display ordering: directories first (alpha), then files
 * (alpha), then other entries (alpha). The server already sorts, but the
 * explorer re-asserts so rendering never depends on server ordering.
 */
export function sortVaultEntries(entries: readonly VaultEntry[]): VaultEntry[] {
  const order = (entry: VaultEntry): number =>
    entry.type === "directory" ? 0 : entry.type === "file" ? 1 : 2;
  return [...entries].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
}

export interface VaultCrumb {
  name: string;
  /** Accumulated vault-relative path for the crumb. */
  path: string;
}

/**
 * Breadcrumb segments from a vault-relative path. The root (".") has none;
 * "team/dipu" yields [{team, team}, {dipu, team/dipu}]. Built only from
 * server-derived paths.
 */
export function vaultBreadcrumb(path: string): VaultCrumb[] {
  if (path === VAULT_ROOT_PATH || path === "") return [];
  const segments = path.split("/").filter((segment) => segment !== "");
  const crumbs: VaultCrumb[] = [];
  let accumulated = "";
  for (const segment of segments) {
    accumulated = accumulated === "" ? segment : `${accumulated}/${segment}`;
    crumbs.push({ name: segment, path: accumulated });
  }
  return crumbs;
}
