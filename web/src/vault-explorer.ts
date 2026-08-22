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

/** Safe deterministic frontmatter field values: scalars and scalar lists only. */
export type FrontmatterFieldValue = string | number | boolean | readonly (string | number | boolean)[];

export interface FrontmatterField {
  key: string;
  value: FrontmatterFieldValue;
}

export interface FrontmatterCard {
  fields: readonly FrontmatterField[];
  body: string;
}

const FRONTMATTER_NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;

function parseFrontmatterScalar(raw: string): string | number | boolean | null {
  const text = raw.trim();
  if (text === "") return null;
  // Fully quoted values stay literal strings (no comment stripping inside).
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }
  // Unquoted: strip a trailing " #comment".
  const hashIndex = text.indexOf(" #");
  const bare = hashIndex === -1 ? text : text.slice(0, hashIndex).trim();
  if (bare === "true" || bare === "false") return bare === "true";
  if (FRONTMATTER_NUMBER_PATTERN.test(bare)) return Number(bare);
  return bare;
}

/**
 * Parse a valid INITIAL YAML frontmatter block into a bounded presentation
 * card: safe top-level scalar fields and scalar lists in document order
 * (first occurrence of a duplicate key wins). Nested/object/flow values are
 * omitted rather than stringified. Returns null — the caller's signal to
 * render the existing whole-file safe Markdown — for a missing block, an
 * unterminated block, malformed top-level lines, or a block with zero
 * supported fields. Never throws.
 */
export function parseFrontmatterCard(content: string): FrontmatterCard | null {
  if (!content.startsWith("---\n")) return null;
  const lines = content.split("\n");
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === "---") {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) return null;

  const fields: FrontmatterField[] = [];
  const seenKeys = new Set<string>();
  // Index of the field currently accumulating a scalar list, or -1.
  let listFieldIndex = -1;
  let supported = false;

  for (let i = 1; i < closeIndex; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    if (line.startsWith(" ") || line.startsWith("\t")) {
      const itemMatch = /^[\t ]+-\s+(.*)$/.exec(line);
      if (itemMatch !== null && listFieldIndex !== -1) {
        // A scalar list item under the pending `key:` field.
        const value = parseFrontmatterScalar(itemMatch[1] ?? "");
        if (value === null) return null;
        const field = fields[listFieldIndex];
        if (field !== undefined && Array.isArray(field.value)) {
          fields[listFieldIndex] = { key: field.key, value: [...field.value, value] };
        }
        continue;
      }
      // Any other indented content makes the pending key unsupported
      // (nested/object) — omit it rather than stringifying or failing.
      if (listFieldIndex !== -1) {
        fields.splice(listFieldIndex, 1);
        listFieldIndex = -1;
      }
      continue;
    }

    const separator = line.indexOf(":");
    if (separator <= 0) return null; // malformed top-level line -> fail quiet
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) return null;
    listFieldIndex = -1;
    if (seenKeys.has(key)) continue; // first occurrence wins

    const rawValue = line.slice(separator + 1);
    if (rawValue.trim() === "") {
      // Pending: either a scalar list follows or the key is unsupported.
      seenKeys.add(key);
      fields.push({ key, value: [] });
      listFieldIndex = fields.length - 1;
      continue;
    }
    const trimmedValue = rawValue.trim();
    if (trimmedValue.startsWith("[") || trimmedValue.startsWith("{")) {
      // Flow collections are unsupported -> omit.
      continue;
    }
    const value = parseFrontmatterScalar(rawValue);
    if (value === null) continue; // empty-ish unsupported value -> omit
    seenKeys.add(key);
    fields.push({ key, value });
    supported = true;
  }

  // A trailing pending list that never received items is unsupported -> omit.
  if (listFieldIndex !== -1 && Array.isArray(fields[listFieldIndex]?.value) && (fields[listFieldIndex]?.value as readonly unknown[]).length === 0) {
    fields.splice(listFieldIndex, 1);
  } else if (fields.some((f) => Array.isArray(f.value) && f.value.length > 0)) {
    supported = true;
  }

  if (!supported || fields.length === 0) return null;
  const bodyLines = lines.slice(closeIndex + 1);
  while (bodyLines[0] === "") bodyLines.shift();
  return { fields, body: bodyLines.join("\n") };
}
