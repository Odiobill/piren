import { useEffect, useState, type RefObject } from "react";
import { fetchConversations, UnauthorizedError } from "./api";
import { formatConversationHash, selectedConversationIdFromHash } from "./hash-route";
import { conversationAudienceSummary, formatConversationCreatedTimestamp, type ConversationRecord } from "./conversations";
import { ExpandIcon, FolderIcon, GearIcon, HomeIcon, MessageIcon } from "./icons";
import type { Page } from "./nav";

/** ADR-0044: the Dashboard is the default surface; the sidebar stays the conversation switcher. */
const NAV_ITEMS: ReadonlyArray<{ page: Page; label: string; Icon: typeof HomeIcon }> = [
  { page: "dashboard", label: "Dashboard", Icon: HomeIcon },
  // W3 (0.2.0 amendment §5): the static full-page Settings shell — a normal
  // typed nav page (not a companion, not a route/hash change).
  { page: "settings", label: "Settings", Icon: GearIcon },
];

/**
 * The sidebar is the conversation switcher. Conversation creation happens
 * ONLY through the Dashboard's explicit agent-first start (ADR-0044); the
 * retired sidebar creation button is gone. The list is re-fetched when
 * `conversationsReloadKey` changes (for example after a Dashboard start
 * or a rename).
 */
export function Sidebar({
  page,
  token,
  onSelect,
  onValidated,
  onUnauthorized,
  conversationsReloadKey,
  explorerOpen,
  onToggleExplorer,
  explorerToggleRef,
  onOpenExplorerFullPage,
  explorerFullPage = false,
}: {
  page: Page;
  token: string;
  onSelect: (page: Page) => void;
  onValidated: () => void;
  onUnauthorized: () => void;
  conversationsReloadKey: number;
  /** W2: the companion open/close affordance state (aria-pressed). */
  explorerOpen: boolean;
  onToggleExplorer: () => void;
  /** Desktop toggle for close-returns-focus; drawer instances return to Menu. */
  explorerToggleRef?: RefObject<HTMLButtonElement | null>;
  /**
   * V1: the distinct sibling full-page action (never nested inside the
   * toggle). The shell decides hash/selection behavior; the sidebar only
   * reports the explicit click.
   */
  onOpenExplorerFullPage: () => void;
  /**
   * WUX-A: true while the Explorer owns the whole workspace (no selected
   * Conversation). The Explorer is then the SOLE highlighted sidebar module:
   * Dashboard/Settings lose their visible highlight until it closes, even
   * though the underlying page stays mounted underneath.
   */
  explorerFullPage?: boolean;
}) {
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** P2: the selected row comes from the same durable hash route the navigator gates. */
  const [selectedId, setSelectedId] = useState<string | null>(() => selectedConversationIdFromHash(window.location.hash));

  // The selection is hash-driven (the navigator's sole durable route), so the
  // sidebar tracks hash changes to visibly distinguish the selected row. No
  // polling: this is a browser hashchange event only.
  useEffect(() => {
    const handleHash = () => setSelectedId(selectedConversationIdFromHash(window.location.hash));
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetchConversations(token, controller.signal);
        if (cancelled) return;
        setConversations(response.conversations);
        setLoading(false);
        onValidated();
      } catch (cause) {
        if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return;
        if (cause instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [token, onValidated, onUnauthorized, conversationsReloadKey]);

  function openConversation(id: string) {
    onSelect("conversations");
    window.location.hash = formatConversationHash(id);
  }

  return (
    <nav className="sidebar-nav" aria-label="Main">
      <ul className="sidebar-pages">
        {NAV_ITEMS.map((item) => (
          <li key={item.page}>
            <button
              type="button"
              className={
                !explorerFullPage && page === item.page ? "nav-item active" : "nav-item"
              }
              aria-current={!explorerFullPage && page === item.page ? "page" : undefined}
              onClick={() => onSelect(item.page)}
            >
              <item.Icon size={14} />
              <span>{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
      {/* W2: the single explicit companion open/close affordance in the
          Conversation context (a shell-level workspace state, not a nav
          page, no URL/hash change). aria-pressed reflects the open state. */}
      <ul className="sidebar-companions">
        <li className="sidebar-companion-row">
          <button
            type="button"
            ref={explorerToggleRef}
            className={explorerOpen ? "nav-item active" : "nav-item"}
            aria-pressed={explorerOpen}
            onClick={onToggleExplorer}
          >
            <FolderIcon size={14} />
            <span>Vault Explorer</span>
          </button>
          {/* V1: a DISTINCT SIBLING full-page action — never a nested
              interactive control inside the toggle. Icon-only with its own
              accessible name (P1 icon primitive pattern). */}
          <button
            type="button"
            className="nav-item sidebar-companion-fullpage"
            aria-label="Open Vault Explorer full page"
            title="Open Vault Explorer full page"
            onClick={onOpenExplorerFullPage}
          >
            <ExpandIcon size={14} />
          </button>
        </li>
      </ul>
      <section className="sidebar-conversations" aria-labelledby="sidebar-conversations-heading">
        <div className="sidebar-section-heading">
          <h2 id="sidebar-conversations-heading">Your conversations</h2>
        </div>
        {error !== null && <p className="error-message" role="status">{error}</p>}
        {loading ? <p className="muted">Loading…</p> : conversations.length === 0 ? <p className="muted">No conversations yet.</p> : (
          <ul className="sidebar-conversation-list">
            {conversations.map((conversation) => {
              const selected = conversation.id === selectedId;
              return (
                <li key={conversation.id}>
                  <button
                    type="button"
                    className={selected ? "sidebar-conversation-entry active" : "sidebar-conversation-entry"}
                    aria-current={selected ? "true" : undefined}
                    onClick={() => openConversation(conversation.id)}
                  >
                    {/* WUX-A: decorative conversation glyph on each entry.
                        WUX-C: the glyph and the durable created date share
                        ONE compact meta line above the title. */}
                    <span className="sidebar-conversation-meta">
                      <MessageIcon size={13} />
                      {/* Origin-fact timestamp: the durable created value renders
                          above the title with a machine-readable time value;
                          malformed/unavailable values fail quiet (no fabricated
                          date, no fetch, no state). */}
                      <ConversationCreatedTimestamp created={conversation.created} />
                    </span>
                    <span className="sidebar-conversation-title">{conversation.title}</span>
                    <small>{conversationAudienceSummary(conversation.audience)}</small>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </nav>
  );
}

/**
 * Origin-fact created timestamp above a sidebar conversation title: an
 * accessible local date/time with a machine-readable `dateTime` value when
 * the durable `created` is valid; malformed/unavailable values fail quiet
 * (render nothing — never a fabricated date).
 */
function ConversationCreatedTimestamp({ created }: { created: string }) {
  const parts = formatConversationCreatedTimestamp(created);
  if (parts === null) return null;
  return (
    <time className="sidebar-conversation-created" dateTime={parts.dateTime}>
      {parts.text}
    </time>
  );
}
