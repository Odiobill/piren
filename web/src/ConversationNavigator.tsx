import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  attachConversation,
  createConversation,
  fetchConversations,
  fetchRoomAgents,
  UnauthorizedError,
} from "./api";
import type { ConversationRecord } from "./conversations";
import { classifyAudienceMembers, type MemberRunnableStatus } from "./attach";
import type { RoomAgentEntry } from "./rooms";
import { ConversationTimeline } from "./ConversationTimeline";
import { ConversationComposer } from "./ConversationComposer";

/**
 * Conversation navigator (C3-A): the Conversation Workbench surface over the
 * accepted C2 API family. Lists conversations, creates one via its FIRST
 * raw-text message, and selects one through the C1/runnable-roster-gated
 * attach route: a successful attach opens the ACTIVE surface (immutable
 * whole-history reread + scoped live SSE + raw-text composer); a rejected
 * attach opens the visibly READ-ONLY inspection surface (history only, no
 * composer, no live stream). The browser never scans, resolves, or derives
 * dispatch recipients from `@text` — the gateway alone parses mentions.
 * No approval or abort controls, vault/graph navigation, configuration
 * controls, storage, or service worker.
 */

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; agents: RoomAgentEntry[]; conversations: ConversationRecord[] };

type SelectionState =
  | { phase: "none" }
  | { phase: "attaching" }
  | { phase: "active"; conversation: ConversationRecord }
  | { phase: "read-only"; conversation: ConversationRecord; message: string };

export function ConversationNavigator({
  token,
  onUnauthorized,
  onValidated,
}: {
  token: string;
  onUnauthorized: () => void;
  onValidated: () => void;
}) {
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [selection, setSelection] = useState<SelectionState>({ phase: "none" });
  const [announcement, setAnnouncement] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const newConversationRef = useRef<HTMLButtonElement>(null);
  const pendingFocusId = useRef<string | null>(null);

  const loadData = useCallback(
    async (signal: AbortSignal) => {
      const [agents, conversations] = await Promise.all([fetchRoomAgents(token, signal), fetchConversations(token, signal)]);
      return { agents: agents.agents, conversations: conversations.conversations };
    },
    [token],
  );

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const data = await loadData(controller.signal);
        if (cancelled) return;
        setLoad({ phase: "ready", agents: data.agents, conversations: data.conversations });
        onValidated();
      } catch (error) {
        if (cancelled) return;
        if (error instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoad({ phase: "error", message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [loadData, onUnauthorized, onValidated, retryKey]);

  useEffect(() => {
    if (selection.phase === "active" || selection.phase === "read-only") {
      detailHeadingRef.current?.focus();
      setAnnouncement(
        selection.phase === "active"
          ? `Conversation attached as active: ${selection.conversation.title}`
          : `Conversation open in read-only inspection: ${selection.conversation.title}`,
      );
    }
  }, [selection]);

  useEffect(() => {
    if (pendingFocusId.current && newConversationRef.current) {
      newConversationRef.current.focus();
      pendingFocusId.current = null;
    }
  }, [load]);

  function handleRetry() {
    setLoad({ phase: "loading" });
    setRetryKey((key) => key + 1);
  }

  async function handleSelect(conversationId: string) {
    setSelection({ phase: "attaching" });
    try {
      const response = await attachConversation(conversationId, token);
      // The rejected attach envelope carries no conversation record (the
      // server keeps the rejection bounded), so the read-only inspection view
      // reuses the durable record from the loaded list (immutable manifest).
      const listed = load.phase === "ready" ? load.conversations.find((entry) => entry.id === conversationId) : undefined;
      if (response.attached) {
        setSelection({ phase: "active", conversation: response.conversation });
      } else if (listed !== undefined) {
        // Rejected conversations stay visibly read-only inspection: history
        // reread only, no composer, no live stream.
        setSelection({ phase: "read-only", conversation: listed, message: response.error });
      } else {
        setSelection({ phase: "none" });
        setAnnouncement("Conversation no longer available.");
      }
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setSelection({ phase: "none" });
      setAnnouncement(error instanceof Error ? error.message : String(error));
    }
  }

  function handleBack() {
    setSelection({ phase: "none" });
    setAnnouncement("Back to the conversation list.");
    listHeadingRef.current?.focus();
  }

  async function handleCreated(conversation: ConversationRecord) {
    setLoad((previous) => {
      if (previous.phase !== "ready") return previous;
      const conversations = [...previous.conversations, conversation];
      return { phase: "ready", agents: previous.agents, conversations };
    });
    pendingFocusId.current = conversation.id;
    setAnnouncement(`Conversation created: ${conversation.title}`);
    // A freshly created conversation's members were validated against the
    // local runnable set at creation, so attach opens it as active.
    await handleSelect(conversation.id);
  }

  if (load.phase === "loading") {
    return (
      <section className="card" aria-live="polite">
        <h2>Loading conversations and agents…</h2>
      </section>
    );
  }

  if (load.phase === "error") {
    return (
      <section className="card card-error" role="alert">
        <h2>Could not load conversations</h2>
        <p className="error-message">
          <code>{load.message}</code>
        </p>
        <button type="button" className="button button-primary" onClick={handleRetry}>
          Retry
        </button>
      </section>
    );
  }

  if (selection.phase === "active" || selection.phase === "read-only") {
    const active = selection.phase === "active";
    return (
      <section className="card" aria-labelledby="conversation-detail-heading">
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
        <button type="button" className="button" onClick={handleBack}>
          ← All conversations
        </button>
        <h2 id="conversation-detail-heading" tabIndex={-1} ref={detailHeadingRef}>
          {selection.conversation.title}
        </h2>
        <p className="muted">
          <code>{selection.conversation.id}</code> — {selection.conversation.status}
        </p>
        <AudienceMembers audience={selection.conversation.audience} agents={load.agents} />
        {active ? (
          <>
            <ConversationTimeline
              conversationId={selection.conversation.id}
              token={token}
              live={true}
              onUnauthorized={onUnauthorized}
            />
            <ConversationComposer
              conversationId={selection.conversation.id}
              token={token}
              onUnauthorized={onUnauthorized}
              onAnnounce={setAnnouncement}
            />
          </>
        ) : (
          <div className="attach-banner" role="status">
            <p>
              <strong>Read-only inspection</strong> — this conversation cannot be attached as active:{" "}
              {selection.message}. History is shown without a composer or live stream; reopening as
              active is gated until every durable member is locally runnable.
            </p>
            <ConversationTimeline
              conversationId={selection.conversation.id}
              token={token}
              live={false}
              onUnauthorized={onUnauthorized}
            />
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby="conversations-heading">
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <h2 id="conversations-heading" tabIndex={-1} ref={listHeadingRef}>
        Conversations
      </h2>
      {load.conversations.length === 0 ? (
        <p className="muted">No conversations yet. Start the first one with a message below.</p>
      ) : (
        <ul className="conversation-list">
          {load.conversations.map((conversation) => (
            <li key={conversation.id}>
              <button
                type="button"
                className="conversation-entry"
                ref={pendingFocusId.current === conversation.id ? newConversationRef : undefined}
                onClick={() => void handleSelect(conversation.id)}
                disabled={selection.phase === "attaching"}
              >
                <span className="conversation-title">{conversation.title}</span>
                <span className="conversation-meta">
                  {conversation.status} · {conversation.audience.length} member
                  {conversation.audience.length === 1 ? "" : "s"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <ConversationCreateForm
        token={token}
        onCreated={(conversation) => void handleCreated(conversation)}
        onError={(message) => setAnnouncement(message)}
        onUnauthorized={onUnauthorized}
        busy={selection.phase === "attaching"}
      />
    </section>
  );
}

function AudienceMembers({ audience, agents }: { audience: string[]; agents: RoomAgentEntry[] }) {
  const members: MemberRunnableStatus[] = classifyAudienceMembers(audience, agents);
  if (members.length === 0) {
    return <p className="muted">No members yet — mention a locally runnable agent to add one.</p>;
  }
  return (
    <div className="audience-members">
      <h3>Members</h3>
      <ul className="member-list">
        {members.map((member) => (
          <li key={member.name} className={member.runnable ? "member-chip" : "member-chip member-offline"}>
            <span className="member-name">{member.name}</span>
            {member.runnable ? (
              <span className="member-status status-ok">Runnable</span>
            ) : (
              <span className="member-status status-muted">Offline</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConversationCreateForm({
  token,
  onCreated,
  onError,
  onUnauthorized,
  busy,
}: {
  token: string;
  onCreated: (conversation: ConversationRecord) => void;
  onError: (message: string) => void;
  onUnauthorized: () => void;
  busy: boolean;
}) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = text.trim();
    if (trimmed === "") {
      setError("Enter the first message to start the conversation.");
      inputRef.current?.focus();
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const created = await createConversation(token, trimmed);
      setText("");
      onCreated(created.conversation);
    } catch (cause) {
      if (cause instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      onError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="conversation-create" onSubmit={handleSubmit}>
      <h3>Start a conversation</h3>
      <label htmlFor="conversation-first-message">First message</label>
      <input
        id="conversation-first-message"
        ref={inputRef}
        type="text"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="The first message activates the conversation"
        disabled={submitting || busy}
      />
      <p className="field-help">
        Mention a locally runnable agent with <code>@name</code> to add it as a member; the gateway
        alone resolves mentions. Zero-mention context messages are fine too.
      </p>
      {error && (
        <p className="error-message" role="status">
          {error}
        </p>
      )}
      <button type="submit" className="button button-primary" disabled={submitting || busy}>
        Start conversation
      </button>
    </form>
  );
}
