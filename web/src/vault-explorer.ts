import { parse as parseYaml } from "yaml";
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

/**
 * WUX-B — the explorer's retained in-memory location. It survives
 * presentation changes (split <-> full-page remounts) so navigation is never
 * reset to the root; each new presentation makes a fresh bounded reread of
 * exactly this location. Never persisted; server-derived paths only.
 */
export interface VaultExplorerLocation {
  /** Current listing directory (the bounded root or a server-derived dir). */
  path: string;
  /** The currently open document (server-derived path + name), or null. */
  document: { path: string; name: string } | null;
}

/**
 * WUX-B — closed typed list ordering. "name" is the default dirs-first
 * alphabetical ordering; "recent" is server-derived mtimeMs descending with
 * a deterministic name tie-break, applied before the bounded entry trim.
 */
export type VaultOrdering = "name" | "recent";

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

/**
 * WUX-B — deterministic rendering for one ordering value. "name" keeps the
 * dirs-first alphabetical assertion; "recent" re-asserts the server's
 * mtimeMs-descending order with a name tie-break so rendering never depends
 * on server ordering in either mode.
 */
export function presentVaultEntries(entries: readonly VaultEntry[], ordering: VaultOrdering): VaultEntry[] {
  if (ordering === "recent") {
    return [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  }
  return sortVaultEntries(entries);
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

// ---------------------------------------------------------------------------
// V2 — Explorer document/listing presentation cores (display-only).
//
// Filename-based Markdown gating and a fail-quiet initial-YAML frontmatter
// card. Presentation only: frontmatter is never written, normalized, treated
// as authority, or sent anywhere. Anything missing/malformed/unsupported
// fails quiet so the caller renders the existing whole-file safe Markdown.
// ---------------------------------------------------------------------------

/** Case-insensitive Markdown filename gate: exactly `.md` / `.markdown`. */
export function isMarkdownFileName(name: string): boolean {
  const lower = name.toLowerCase();
  // A bare extension (".md") has no filename stem and is not a Markdown file.
  if (lower.endsWith(".markdown")) return lower.length > ".markdown".length;
  return lower.endsWith(".md") && lower.length > ".md".length;
}

/**
 * Safe deterministic frontmatter field values: scalars and scalar lists only.
 */
export type FrontmatterFieldValue = string | number | boolean | readonly (string | number | boolean)[];

export interface FrontmatterField {
  key: string;
  value: FrontmatterFieldValue;
}

export interface FrontmatterCard {
  fields: readonly FrontmatterField[];
  body: string;
}

function isFrontmatterScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function presentScalar(value: string): string {
  // Presentation trim only: a multiline block/folded scalar keeps its real
  // content without the trailing newline the block form appends.
  return value.replace(/\n+$/, "");
}

/**
 * Parse standards-valid INITIAL YAML frontmatter into a bounded presentation
 * card, using the already-declared production `yaml` parser (no handwritten
 * YAML subset, no misrepresentation of valid YAML). The presentation filter
 * keeps ONLY top-level scalar values and arrays entirely made of those
 * scalars, in parsed document order; nested/object/null/unsupported values
 * are omitted rather than stringified.
 *
 * Returns null — the caller's signal to render the existing whole-file safe
 * Markdown — for a missing initial fence, an unterminated block, a parser
 * error, a non-mapping document, or zero supported fields. Never throws.
 * The body after the closing fence keeps one leading newline stripped,
 * matching the established presentation contract.
 */
export function parseFrontmatterCard(content: string): FrontmatterCard | null {
  const openMatch = /^---\r?\n/.exec(content);
  if (openMatch === null) return null;
  const rest = content.slice(openMatch[0].length);
  const closeMatch = /\n---\r?(?:\n|$)/.exec(rest);
  if (closeMatch === null) return null;
  // Normalize CRLF inside the frontmatter text only — the YAML scalar values
  // must not retain a stray carriage return, and the body is left untouched.
  const frontmatterText = rest.slice(0, closeMatch.index).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const fields: FrontmatterField[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
    if (isFrontmatterScalar(value)) {
      fields.push({ key, value: typeof value === "string" ? presentScalar(value) : value });
    } else if (Array.isArray(value) && value.every((entry) => isFrontmatterScalar(entry))) {
      fields.push({ key, value: value.map((entry) => (typeof entry === "string" ? presentScalar(entry) : entry)) });
    }
    // Nested/object/null/unsupported values: omitted, never stringified.
  }

  if (fields.length === 0) return null;
  let body = rest.slice(closeMatch.index + closeMatch[0].length);
  while (body.startsWith("\n")) body = body.slice(1);
  return { fields, body };
}
