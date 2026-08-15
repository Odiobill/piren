import { useEffect, useState } from "react";
import { fetchConversations, UnauthorizedError } from "./api";
import { formatConversationHash, selectedConversationIdFromHash } from "./hash-route";
import { conversationAudienceSummary, type ConversationRecord } from "./conversations";
import type { Page } from "./nav";

/** ADR-0044: the Dashboard is the default surface; the sidebar stays the conversation switcher. */
const NAV_ITEMS: ReadonlyArray<{ page: Page; label: string }> = [{ page: "dashboard", label: "Dashboard" }];

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
}: {
  page: Page;
  token: string;
  onSelect: (page: Page) => void;
  onValidated: () => void;
  onUnauthorized: () => void;
  conversationsReloadKey: number;
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
              className={page === item.page ? "nav-item active" : "nav-item"}
              aria-current={page === item.page ? "page" : undefined}
              onClick={() => onSelect(item.page)}
            >
              {item.label}
            </button>
          </li>
        ))}
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
                    <span>{conversation.title}</span>
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
