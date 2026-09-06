import { useEffect, useRef, useState, type ReactElement } from "react";
import { fetchVaultList, fetchVaultRead, UnauthorizedError } from "./api";
import {
  isVaultDirectoryEntry,
  parseVaultReadResponse,
  presentVaultEntries,
  vaultBreadcrumb,
  VAULT_ROOT_PATH,
  type VaultEntry,
  type VaultExplorerLocation,
  type VaultListResponse,
  type VaultOrdering,
  type VaultReadResponse,
} from "./vault-explorer";
import { SafeMarkdownBody } from "./SafeMarkdown";
import { isMarkdownFileName, parseFrontmatterCard, presentFrontmatterLinkValues, type FrontmatterFieldValue, type FrontmatterLinkValue } from "./vault-explorer";
import { ArrowLeftIcon, ClockIcon, FileIcon, FolderIcon, RetryIcon } from "./icons";

/**
 * W2 (0.2.0 scope amendment §4; accepted companion architecture Phase B) —
 * the first companion module: a read-only Vault Explorer surface over the
 * EXISTING vault list and vault read routes. Presentation
 * only: bounded root/directory navigation with breadcrumbs, directories-then-
 * files listing, explicit file selection, and safe Markdown rendering through
 * the existing renderer. No editor/write, no POST, no inbox action, no draft
 * contribution, no Graph request, no hidden retry/polling/cache authority:
 * every read is an explicit user choice (or a fresh mount), and the closed
 * explorer re-reads on reopen (in-memory state only). A 401 surfaces through
 * onUnauthorized; other failures are bounded, non-secret UI errors.
 */

const LIST_CAP_NOTICE = "List capped at 500 entries.";
const READ_CAP_NOTICE = "File truncated at 500 KB.";

type ListPhase =
  | { kind: "loading" }
  | { kind: "ready"; response: VaultListResponse }
  | { kind: "error"; bounded: string };
type ReadPhase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; response: VaultReadResponse }
  | { kind: "error"; bounded: string };

/** Bounded, non-secret failure text: a fixed prefix plus the HTTP status when known. */
function boundedFailure(prefix: string, cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const status = /HTTP (\d{3})/.exec(message)?.[1];
  return status === undefined ? `${prefix} ` : `${prefix} (HTTP ${status}).`;
}

export function VaultExplorer({
  token,
  onUnauthorized,
  onValidated,
  initialLocation,
  onLocationChange,
  ordering,
  onOrderingChange,
}: {
  token: string;
  onUnauthorized: () => void;
  onValidated: () => void;
  /**
   * WUX-B — the retained in-memory location to restore on mount (a
   * presentation switch remounts the component; a fresh bounded reread of
   * exactly this location happens, never a reset to the root).
   */
  initialLocation?: VaultExplorerLocation;
  /** WUX-B — reports each navigation so the host can retain the location. */
  onLocationChange?: (location: VaultExplorerLocation) => void;
  /**
   * WUX-B — lifted list ordering so it survives presentation remounts.
   * Absent props fall back to component-local in-memory state ("name").
   */
  ordering?: VaultOrdering;
  onOrderingChange?: (ordering: VaultOrdering) => void;
}) {
  const [path, setPath] = useState(initialLocation?.path ?? VAULT_ROOT_PATH);
  const [listPhase, setListPhase] = useState<ListPhase>({ kind: "loading" });
  const [documentEntry, setDocumentEntry] = useState<{ path: string; name: string } | null>(
    initialLocation?.document ?? null,
  );
  const [readPhase, setReadPhase] = useState<ReadPhase>(initialLocation?.document ? { kind: "loading" } : { kind: "idle" });
  const [internalOrdering, setInternalOrdering] = useState<VaultOrdering>("name");
  const activeOrdering: VaultOrdering = ordering ?? internalOrdering;
  const listControllerRef = useRef<AbortController | null>(null);
  const readControllerRef = useRef<AbortController | null>(null);

  /** One bounded listing fetch; no selection/location side effects. */
  function fetchList(target: string, order: VaultOrdering): void {
    listControllerRef.current?.abort();
    const controller = new AbortController();
    listControllerRef.current = controller;
    setListPhase({ kind: "loading" });
    const request =
      order === "recent"
        ? fetchVaultList(target, token, controller.signal, "recent")
        : fetchVaultList(target, token, controller.signal);
    void request
      .then((response) => {
        if (controller.signal.aborted) return;
        setListPhase({ kind: "ready", response });
        onValidated();
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setListPhase({ kind: "error", bounded: boundedFailure("The vault listing failed", cause) });
      });
  }

  /** Explicit navigation: clears any open document and reports the location. */
  function loadList(target: string): void {
    setPath(target);
    setDocumentEntry(null);
    setReadPhase({ kind: "idle" });
    onLocationChange?.({ path: target, document: null });
    fetchList(target, activeOrdering);
  }

  /**
   * WUX-C — open one vault-relative document path (from an entry click or a
   * closed in-page vault link). The listing location moves to the document's
   * parent directory so the breadcrumb/back behavior stay consistent, and
   * the retained in-memory location is reported. The server stays the path
   * authority; a bad read surfaces through the existing bounded error UI.
   */
  function openDocumentAt(filePath: string): void {
    const cut = filePath.lastIndexOf("/");
    const parent = cut === -1 ? VAULT_ROOT_PATH : filePath.slice(0, cut);
    const name = cut === -1 ? filePath : filePath.slice(cut + 1);
    if (name === "") return;
    const document = { path: filePath, name };
    setPath(parent);
    setDocumentEntry(document);
    setReadPhase({ kind: "loading" });
    onLocationChange?.({ path: parent, document });
    void loadRead(filePath);
  }

  /** WUX-B — explicit order toggle over the current directory, in-memory only. */
  function toggleOrdering(): void {
    const next: VaultOrdering = activeOrdering === "recent" ? "name" : "recent";
    onOrderingChange?.(next);
    setInternalOrdering(next);
    // Re-request the SAME directory with the new ordering; an open document
    // stays open (the listing is not visible while a document is shown).
    fetchList(path, next);
  }

  function loadRead(filePath: string): void {
    readControllerRef.current?.abort();
    const controller = new AbortController();
    readControllerRef.current = controller;
    setReadPhase({ kind: "loading" });
    void fetchVaultRead(filePath, token, controller.signal)
      .then((json) => {
        if (controller.signal.aborted) return;
        // The transport already ran the strict parser; the defensive re-parse
        // keeps the render path fail-closed against any future bypass.
        setReadPhase({ kind: "ready", response: parseVaultReadResponse(json) });
        onValidated();
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setReadPhase({ kind: "error", bounded: boundedFailure("The document could not be read", cause) });
      });
  }

  // Fresh listing on mount. WUX-B: the mounted location is the retained
  // in-memory location (never a forced root reset), so a presentation switch
  // re-reads exactly where the steward was; the closed explorer still
  // re-reads on reopen. No location is reported on mount.
  useEffect(() => {
    fetchList(path, activeOrdering);
    if (initialLocation?.document) {
      void loadRead(initialLocation.document.path);
    }
    return () => {
      listControllerRef.current?.abort();
      readControllerRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, onUnauthorized, onValidated]);

  function selectEntry(entry: VaultEntry): void {
    if (isVaultDirectoryEntry(entry)) {
      loadList(entry.path);
      return;
    }
    if (entry.type === "file") {
      openDocumentAt(entry.path);
    }
    // "other" entries are never selectable (disabled in the render).
  }

  const crumbs = vaultBreadcrumb(path);

  return (
    <section className="vault-explorer" aria-label="Vault Explorer">
      <nav className="vault-explorer-breadcrumb" aria-label="Vault path">
        <button type="button" onClick={() => loadList(VAULT_ROOT_PATH)}>
          <FolderIcon size={13} />
          Vault
        </button>
        {crumbs.map((crumb) => (
          <span key={crumb.path} className="vault-explorer-crumb">
            <span aria-hidden="true">/</span>
            <button type="button" onClick={() => loadList(crumb.path)}>
              <FolderIcon size={13} />
              {crumb.name}
            </button>
          </span>
        ))}
        {/* WUX-B: one concise icon-bearing order control with a visible
            current-order indication (aria-pressed). In-memory only. */}
        <button
          type="button"
          className="vault-explorer-order-toggle"
          aria-pressed={activeOrdering === "recent"}
          title={activeOrdering === "recent" ? "Ordered by most recently modified" : "Ordered by name"}
          onClick={toggleOrdering}
        >
          <ClockIcon size={13} />
          <span>{activeOrdering === "recent" ? "Recent" : "Name"}</span>
        </button>
      </nav>

      {documentEntry !== null && readPhase.kind !== "idle" ? (
        <div className="vault-explorer-document" role="region" aria-label={`Document: ${documentEntry.name}`}>
          <div className="vault-explorer-document-header">
            <button type="button" className="vault-explorer-back" onClick={() => loadList(path)}>
              <ArrowLeftIcon size={13} />
              Back to listing
            </button>
            <span className="vault-explorer-document-name">{documentEntry.name}</span>
          </div>
          {readPhase.kind === "loading" && <p className="muted">Loading document…</p>}
          {readPhase.kind === "error" && (
            <div className="vault-explorer-error" role="alert">
              <p>{readPhase.bounded}</p>
              <button type="button" onClick={() => void loadRead(documentEntry.path)}>
                <RetryIcon size={13} />
                Retry
              </button>
            </div>
          )}
          {readPhase.kind === "ready" && (() => {
            // V2 — filename-based rendering gate (case-insensitive). Only
            // Markdown files render through the safe renderer; every other
            // readable file renders literal bounded text. A valid initial
            // YAML frontmatter block becomes a separate presentation-only
            // metadata card; missing/malformed frontmatter fails quiet to
            // whole-file safe Markdown. Never written or sent anywhere.
            if (!isMarkdownFileName(documentEntry.name)) {
              return <pre className="vault-explorer-literal">{readPhase.response.content}</pre>;
            }
            const card = parseFrontmatterCard(readPhase.response.content);
            return (
              <>
                {card !== null && (
                  <dl className="vault-explorer-frontmatter">
                    {card.fields.map((field) => (
                      <div className="vault-explorer-frontmatter-row" key={field.key}>
                        <dt>{field.key}</dt>
                        <dd>
                          <FrontmatterFieldValue
                            field={field}
                            documentPath={documentEntry.path}
                            onNavigateVaultPath={openDocumentAt}
                          />
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
                <SafeMarkdownBody
                  text={card === null ? readPhase.response.content : card.body}
                  vaultDocumentPath={documentEntry.path}
                  onNavigateVaultPath={openDocumentAt}
                />
              </>
            );
          })()}
          {readPhase.kind === "ready" && readPhase.response.capped && (
            <p className="vault-explorer-capped" role="status">
              {READ_CAP_NOTICE}
            </p>
          )}
        </div>
      ) : (
        <div className="vault-explorer-body">
          {listPhase.kind === "loading" && <p className="muted">Loading vault…</p>}
          {listPhase.kind === "error" && (
            <div className="vault-explorer-error" role="alert">
              <p>{listPhase.bounded}</p>
              <button type="button" onClick={() => loadList(path)}>
                <RetryIcon size={13} />
                Retry
              </button>
            </div>
          )}
          {listPhase.kind === "ready" &&
            (listPhase.response.entries.length === 0 ? (
              <p className="muted">Empty directory.</p>
            ) : (
              <ul className="vault-explorer-entries">
                {presentVaultEntries(listPhase.response.entries, activeOrdering).map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className="vault-explorer-entry"
                      disabled={entry.type === "other"}
                      aria-label={`${entry.type === "directory" ? "Open directory" : "Read file"} ${entry.name}`}
                      onClick={() => selectEntry(entry)}
                    >
                      <span className="vault-entry-icon" aria-hidden="true">
                        {/* V2 — decorative folder/file glyphs replaced the textual dir/file labels; the button's aria-label carries type + name. */}
                        {entry.type === "directory" ? <FolderIcon size={14} /> : <FileIcon size={14} />}
                      </span>
                      <span>{entry.name}</span>
                      {entry.type === "file" && entry.bytes !== undefined && (
                        <small className="vault-entry-bytes">{entry.bytes} B</small>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            ))}
          {listPhase.kind === "ready" && listPhase.response.capped && (
            <p className="vault-explorer-capped" role="status">
              {LIST_CAP_NOTICE}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * S9 — metadata presentation for one frontmatter field. Only the recognized
 * `links` field becomes interactive: internal vault Markdown targets are
 * in-place navigation buttons, safe absolute HTTP(S) targets are new-tab
 * anchors, and every unsupported value stays non-interactive text. Arbitrary
 * scalar fields keep the existing joined plain-text presentation.
 */
function FrontmatterFieldValue({
  field,
  documentPath,
  onNavigateVaultPath,
}: {
  field: { key: string; value: FrontmatterFieldValue };
  documentPath: string;
  onNavigateVaultPath: (path: string) => void;
}): ReactElement {
  const links = presentFrontmatterLinkValues(field, documentPath);
  if (links === null) {
    return <>{Array.isArray(field.value) ? field.value.join(", ") : String(field.value)}</>;
  }
  const single = links.length === 1 ? links[0] : undefined;
  if (single !== undefined) {
    return <FrontmatterLinkControl value={single} onNavigateVaultPath={onNavigateVaultPath} />;
  }
  return (
    <ul className="vault-explorer-frontmatter-links">
      {links.map((value, index) => (
        <li key={index}>
          <FrontmatterLinkControl value={value} onNavigateVaultPath={onNavigateVaultPath} />
        </li>
      ))}
    </ul>
  );
}

/** One metadata link value as its truthful, individually operable control. */
function FrontmatterLinkControl({
  value,
  onNavigateVaultPath,
}: {
  value: FrontmatterLinkValue;
  onNavigateVaultPath: (path: string) => void;
}): ReactElement {
  if (value.kind === "vault") {
    return (
      <button
        type="button"
        className="vault-explorer-frontmatter-link"
        onClick={() => onNavigateVaultPath(value.path)}
      >
        {value.label}
      </button>
    );
  }
  if (value.kind === "external") {
    return (
      <a className="vault-explorer-frontmatter-link" href={value.url} target="_blank" rel="noopener noreferrer">
        {value.label}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  return <span className="vault-explorer-frontmatter-text">{value.text}</span>;
}
