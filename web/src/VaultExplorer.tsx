import { useEffect, useRef, useState } from "react";
import { fetchVaultList, fetchVaultRead, UnauthorizedError } from "./api";
import {
  isVaultDirectoryEntry,
  parseVaultReadResponse,
  sortVaultEntries,
  vaultBreadcrumb,
  VAULT_ROOT_PATH,
  type VaultEntry,
  type VaultListResponse,
  type VaultReadResponse,
} from "./vault-explorer";
import { SafeMarkdownBody } from "./SafeMarkdown";
import { isMarkdownFileName, parseFrontmatterCard } from "./vault-explorer";
import { ArrowLeftIcon, FileIcon, FolderIcon, RetryIcon } from "./icons";

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

const LIST_CAP_NOTICE = "List capped at 100 entries.";
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
}: {
  token: string;
  onUnauthorized: () => void;
  onValidated: () => void;
}) {
  const [path, setPath] = useState(VAULT_ROOT_PATH);
  const [listPhase, setListPhase] = useState<ListPhase>({ kind: "loading" });
  const [selected, setSelected] = useState<VaultEntry | null>(null);
  const [readPhase, setReadPhase] = useState<ReadPhase>({ kind: "idle" });
  const listControllerRef = useRef<AbortController | null>(null);
  const readControllerRef = useRef<AbortController | null>(null);

  function loadList(target: string): void {
    listControllerRef.current?.abort();
    const controller = new AbortController();
    listControllerRef.current = controller;
    setPath(target);
    setSelected(null);
    setReadPhase({ kind: "idle" });
    setListPhase({ kind: "loading" });
    void fetchVaultList(target, token, controller.signal)
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

  // Fresh root listing on mount (reread when the closed explorer reopens).
  useEffect(() => {
    loadList(VAULT_ROOT_PATH);
    return () => {
      listControllerRef.current?.abort();
      readControllerRef.current?.abort();
    };
  }, [token, onUnauthorized, onValidated]);

  function selectEntry(entry: VaultEntry): void {
    if (isVaultDirectoryEntry(entry)) {
      loadList(entry.path);
      return;
    }
    if (entry.type === "file") {
      setSelected(entry);
      loadRead(entry.path);
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
      </nav>

      {selected !== null && readPhase.kind !== "idle" ? (
        <div className="vault-explorer-document" role="region" aria-label={`Document: ${selected.name}`}>
          <div className="vault-explorer-document-header">
            <button type="button" className="vault-explorer-back" onClick={() => loadList(path)}>
              <ArrowLeftIcon size={13} />
              Back to listing
            </button>
            <span className="vault-explorer-document-name">{selected.name}</span>
          </div>
          {readPhase.kind === "loading" && <p className="muted">Loading document…</p>}
          {readPhase.kind === "error" && (
            <div className="vault-explorer-error" role="alert">
              <p>{readPhase.bounded}</p>
              <button type="button" onClick={() => loadRead(selected.path)}>
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
            if (!isMarkdownFileName(selected.name)) {
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
                        <dd>{Array.isArray(field.value) ? field.value.join(", ") : String(field.value)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                <SafeMarkdownBody text={card === null ? readPhase.response.content : card.body} />
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
                {sortVaultEntries(listPhase.response.entries).map((entry) => (
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
