import { useEffect, useState, type FormEvent } from "react";
import { createConversation, fetchConversations, UnauthorizedError } from "./api";
import { formatConversationHash } from "./hash-route";
import type { ConversationRecord } from "./conversations";
import type { Page } from "./nav";

const NAV_ITEMS: ReadonlyArray<{ page: Page; label: string }> = [
  { page: "conversations", label: "Conversations" },
  { page: "agents", label: "Agents" },
  { page: "about", label: "About" },
];

/** The sidebar is the conversation switcher; the main workspace stays focused on one selected chat. */
export function Sidebar({
  page,
  token,
  onSelect,
  onValidated,
  onUnauthorized,
}: {
  page: Page;
  token: string;
  onSelect: (page: Page) => void;
  onValidated: () => void;
  onUnauthorized: () => void;
}) {
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
  }, [token, onValidated, onUnauthorized]);

  function openConversation(id: string) {
    onSelect("conversations");
    window.location.hash = formatConversationHash(id);
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const firstMessage = text.trim();
    if (firstMessage === "") {
      setError("Enter a first message to start the conversation.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = await createConversation(token, firstMessage);
      setConversations((previous) => [created.conversation, ...previous]);
      setText("");
      setShowCreate(false);
      openConversation(created.conversation.id);
    } catch (cause) {
      if (cause instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
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
          <button type="button" className="button button-primary button-new-conversation" onClick={() => { onSelect("conversations"); setShowCreate(true); }}>
            + New conversation
          </button>
        </div>
        {showCreate && (
          <form className="sidebar-create" onSubmit={(event) => void handleCreate(event)}>
            <label htmlFor="sidebar-first-message">First message</label>
            <textarea id="sidebar-first-message" value={text} onChange={(event) => setText(event.target.value)} disabled={submitting} placeholder="What would you like to work on?" />
            <button type="submit" className="button button-primary" disabled={submitting}>Start</button>
          </form>
        )}
        {error !== null && <p className="error-message" role="status">{error}</p>}
        {loading ? <p className="muted">Loading…</p> : conversations.length === 0 ? <p className="muted">No conversations yet.</p> : (
          <ul className="sidebar-conversation-list">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <button type="button" className="sidebar-conversation-entry" onClick={() => openConversation(conversation.id)}>
                  <span>{conversation.title}</span>
                  <small>{conversation.audience.length === 0 ? "No agents yet" : `${conversation.audience.length} member${conversation.audience.length === 1 ? "" : "s"}`}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </nav>
  );
}
