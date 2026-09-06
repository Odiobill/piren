/**
 * WUX-C + S9 — pure closed vault-page link target parsing for the read-only
 * Vault Explorer. Framework-free and deterministic; the browser never turns
 * anything except these explicitly bounded forms into an in-place vault
 * navigation:
 *
 * - safe standard Markdown ROOT-RELATIVE links `[Plan](/Projects/Piren/x.md)`
 *   (path used verbatim, no extension mapping; raw spaces rejected — the
 *   safe spelling for a space in a Markdown destination is the encoded
 *   `%20` form, which resolves to the real vault path, never a literal
 *   `%20` filename);
 * - S9 — bounded document-relative Markdown links `[Plan](plans/x.md)`
 *   resolved from the CURRENT open document's parent only (single-dot
 *   segments are dropped — they cannot escape; any `..` fails closed);
 * - existing vault wikilinks `[[Projects/Piren/x]]` / `[[Projects/Piren/x|Plan]]`
 *   (an extensionless wiki target maps deterministically to `.md`; an
 *   explicit extension is retained; S9 — ordinary spaces inside path
 *   segments are valid vault-path characters and are accepted).
 *
 * Everything else fails closed with an exact reason: traversal, backslashes,
 * protocol-relative/absolute URLs, control/ambiguous-space characters,
 * malformed or non-space percent-encoding (decoded separators/traversal are
 * rejected), query/fragment, empty/double-slash paths, and unsupported wiki
 * syntax. Browser-relative links outside the bounded document-relative form
 * are never converted into vault targets. The server remains the path
 * authority; this parser only decides whether a link is a closed vault-page
 * form at all.
 */

export type VaultMarkdownLinkTarget =
  | { ok: true; path: string }
  | { ok: false; reason: string };

export type VaultWikiLinkTarget =
  | { ok: true; path: string; label: string | null }
  | { ok: false; reason: string };

/**
 * Deterministic "has an explicit filename extension" test for the last path
 * segment: a dot after the first character with at least one following
 * character. An explicit extension (any kind) is retained verbatim; an
 * extensionless wiki target maps to `.md`.
 */
function hasExplicitExtension(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1;
}

/** Only Markdown documents are vault pages eligible for in-place navigation. */
function isMarkdownPageName(name: string): boolean {
  const lower = name.toLowerCase();
  return (lower.endsWith(".markdown") && lower.length > ".markdown".length) ||
    (lower.endsWith(".md") && lower.length > ".md".length);
}

/**
 * Shared segment validation for one vault-relative path (no leading slash).
 * Rejects backslashes, control characters, query/fragment markers, and
 * empty / "." / ".." segments (which also covers double slashes and any
 * leading or trailing slash). S9 — ordinary spaces (U+0020) INSIDE a segment
 * are valid vault-path characters and are accepted; a segment with a leading
 * or trailing space (or only spaces) is ambiguous typing and fails closed.
 */
function validateVaultSegments(path: string): string | null {
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return "contains a control character";
    if (path[index] === "\\") return "contains a backslash";
    if (path[index] === "?" || path[index] === "#") return "contains a query or fragment";
  }
  for (const segment of path.split("/")) {
    if (segment === "") return "has an empty path segment";
    if (segment === "." || segment === "..") return "contains a dot traversal segment";
    if (segment.startsWith(".")) return "contains a hidden path segment";
    if (segment !== segment.trim()) return "has a segment with an ambiguous leading or trailing space";
  }
  return null;
}

/**
 * S9 — strict bounded percent-decoding for Markdown destinations: every `%`
 * must introduce two hex digits, and the only decoded value accepted is one
 * ordinary space (U+0020). Malformed escapes, decoded separators (`%2F`),
 * backslashes (`%5C`), dots (`%2E`), controls (`%00`), and any other encoded
 * character fail closed. Inputs without `%` pass through unchanged.
 */
function decodeEncodedSpaces(raw: string): string | null {
  if (!raw.includes("%")) return raw;
  let decoded = "";
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string;
    if (char !== "%") {
      decoded += char;
      continue;
    }
    const hex = raw.slice(index + 1, index + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
    if (parseInt(hex, 16) !== 0x20) return null;
    decoded += " ";
    index += 2;
  }
  return decoded;
}

/**
 * Raw-destination guard shared by both standard Markdown forms: a raw space
 * or control character in the URL text itself fails closed (the safe
 * spelling for a space is the encoded `%20` form). Returns an exact reason
 * or null when the raw text is clean.
 */
function rejectRawSpaceOrControl(raw: string): string | null {
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return "contains a raw space or control character";
  }
  return null;
}

/** Shared final validation for a decoded vault-relative Markdown destination. */
function finishMarkdownTarget(path: string): VaultMarkdownLinkTarget {
  const invalid = validateVaultSegments(path);
  if (invalid !== null) return { ok: false, reason: invalid };
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!isMarkdownPageName(name)) return { ok: false, reason: "does not target a Markdown page" };
  return { ok: true, path };
}

/**
 * Parse the URL of a standard Markdown `[label](url)` link as a safe
 * root-relative vault page. The path is used verbatim (no extension
 * mapping); safely encoded spaces (`%20`) resolve to the real vault path.
 * Browser-relative links are rejected here — see
 * `parseVaultDocumentRelativeHref` for the bounded document-relative form.
 */
export function parseVaultMarkdownHref(raw: string): VaultMarkdownLinkTarget {
  if (!raw.startsWith("/")) return { ok: false, reason: "not a root-relative vault link" };
  // Protocol-relative ("//host/...") fails via the empty first segment.
  const rawInvalid = rejectRawSpaceOrControl(raw);
  if (rawInvalid !== null) return { ok: false, reason: rawInvalid };
  const decoded = decodeEncodedSpaces(raw);
  if (decoded === null) return { ok: false, reason: "contains malformed or unsupported percent-encoding" };
  return finishMarkdownTarget(decoded.slice(1));
}

/**
 * S9 — parse a standard Markdown `[label](url)` link with a DOCUMENT-
 * RELATIVE vault-page destination, resolved ONLY from the current open
 * document's parent directory. Bounded normalization: single-dot segments
 * are dropped (they cannot escape the vault); any `..` segment fails closed.
 * The result must pass the same closed validation as every other target and
 * name a Markdown page.
 */
export function parseVaultDocumentRelativeHref(raw: string, documentPath: string): VaultMarkdownLinkTarget {
  if (raw.startsWith("/")) return { ok: false, reason: "not a document-relative vault link" };
  // A URI-scheme prefix is never a vault-relative filename. Reject it before
  // path joining even when the remainder happens to end in `.md`.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) {
    return { ok: false, reason: "contains a URI scheme" };
  }
  const rawInvalid = rejectRawSpaceOrControl(raw);
  if (rawInvalid !== null) return { ok: false, reason: rawInvalid };
  const decoded = decodeEncodedSpaces(raw);
  if (decoded === null) return { ok: false, reason: "contains malformed or unsupported percent-encoding" };
  const normalized: string[] = [];
  for (const segment of decoded.split("/")) {
    if (segment === "..") return { ok: false, reason: "contains a dot traversal segment" };
    if (segment === ".") continue;
    normalized.push(segment);
  }
  if (normalized.length === 0) return { ok: false, reason: "has an empty path segment" };
  const cut = documentPath.lastIndexOf("/");
  const base = cut === -1 ? "" : documentPath.slice(0, cut);
  const joined = base === "" ? normalized.join("/") : `${base}/${normalized.join("/")}`;
  return finishMarkdownTarget(joined);
}

/**
 * S9 — combined safe Markdown destination resolver: root-relative targets
 * (`/...`) are used verbatim; every other target is a document-relative form
 * resolved from the current open document's parent. With no current document
 * context, relative targets fail closed.
 */
export function resolveVaultMarkdownTarget(raw: string, documentPath: string | null): VaultMarkdownLinkTarget {
  if (raw.startsWith("/")) return parseVaultMarkdownHref(raw);
  if (documentPath !== null) return parseVaultDocumentRelativeHref(raw, documentPath);
  return { ok: false, reason: "document-relative link without a current document" };
}

/**
 * Parse the inner text of a `[[...]]` vault wikilink as a closed vault-page
 * target. At most one `|` label separator is supported; the optional label
 * may be empty only in the sense that it is then absent. An extensionless
 * target maps deterministically to `.md`; an explicit extension is retained.
 * S9 — ordinary spaces inside path segments are accepted.
 */
export function parseVaultWikiLink(inner: string): VaultWikiLinkTarget {
  const trimmed = inner.trim();
  if (trimmed === "") return { ok: false, reason: "empty wikilink target" };
  const pipeCount = (trimmed.match(/\|/g) ?? []).length;
  if (pipeCount > 1) return { ok: false, reason: "unsupported wikilink syntax" };
  const pipeIndex = trimmed.indexOf("|");
  const rawTarget = pipeIndex === -1 ? trimmed : trimmed.slice(0, pipeIndex).trim();
  const rawLabel = pipeIndex === -1 ? null : trimmed.slice(pipeIndex + 1).trim();
  if (rawTarget === "") return { ok: false, reason: "empty wikilink target" };
  const invalid = validateVaultSegments(rawTarget);
  if (invalid !== null) return { ok: false, reason: invalid };
  const segments = rawTarget.split("/");
  const name = segments[segments.length - 1] as string;
  const resolvedName = hasExplicitExtension(name) ? name : `${name}.md`;
  if (!isMarkdownPageName(resolvedName)) return { ok: false, reason: "does not target a Markdown page" };
  const path = [...segments.slice(0, -1), resolvedName].join("/");
  return { ok: true, path, label: rawLabel };
}
