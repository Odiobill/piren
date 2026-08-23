/**
 * WUX-C — pure closed vault-page link target parsing for the read-only
 * Vault Explorer. Framework-free and deterministic; the browser never turns
 * anything except these two explicitly bounded forms into an in-place vault
 * navigation:
 *
 * - safe standard Markdown ROOT-RELATIVE links `[Plan](/Projects/Piren/x.md)`
 *   (path used verbatim, no extension mapping);
 * - existing vault wikilinks `[[Projects/Piren/x]]` / `[[Projects/Piren/x|Plan]]`
 *   (an extensionless wiki target maps deterministically to `.md`; an
 *   explicit extension is retained).
 *
 * Everything else fails closed with an exact reason: traversal, backslashes,
 * protocol-relative/absolute URLs, control/space characters, query/fragment,
 * empty/double-slash paths, and unsupported wiki syntax. Browser-relative
 * links are never converted into vault targets. The server remains the path
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

/**
 * Shared segment validation for one vault-relative path (no leading slash).
 * Rejects backslashes, control/space characters, query/fragment markers, and
 * empty / "." / ".." segments (which also covers double slashes and any
 * leading or trailing slash).
 */
function validateVaultSegments(path: string): string | null {
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return "contains a space or control character";
    if (path[index] === "\\") return "contains a backslash";
    if (path[index] === "?" || path[index] === "#") return "contains a query or fragment";
  }
  for (const segment of path.split("/")) {
    if (segment === "") return "has an empty path segment";
    if (segment === "." || segment === "..") return "contains a dot traversal segment";
  }
  return null;
}

/**
 * Parse the URL of a standard Markdown `[label](url)` link as a safe
 * root-relative vault page. The path is used verbatim (no extension
 * mapping). Browser-relative links are rejected, never converted.
 */
export function parseVaultMarkdownHref(raw: string): VaultMarkdownLinkTarget {
  if (!raw.startsWith("/")) return { ok: false, reason: "not a root-relative vault link" };
  // Protocol-relative ("//host/...") fails via the empty first segment.
  const path = raw.slice(1);
  const invalid = validateVaultSegments(path);
  if (invalid !== null) return { ok: false, reason: invalid };
  return { ok: true, path };
}

/**
 * Parse the inner text of a `[[...]]` vault wikilink as a closed vault-page
 * target. At most one `|` label separator is supported; the optional label
 * may be empty only in the sense that it is then absent. An extensionless
 * target maps deterministically to `.md`; an explicit extension is retained.
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
  const path = [...segments.slice(0, -1), resolvedName].join("/");
  return { ok: true, path, label: rawLabel };
}
