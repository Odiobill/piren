import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  attachConversation,
  createConversation,
  fetchConversation,
  fetchConversations,
  fetchRoomAgents,
  UnauthorizedError,
} from "./api";
import type { ConversationRecord } from "./conversations";
import { classifyAudienceMembers, type MemberRunnableStatus } from "./attach";
import { formatConversationHash, parseHashRoute, routeToIntent, urlWithoutHash } from "./hash-route";
import type { RoomAgentEntry } from "./rooms";
import { ConversationTimeline } from "./ConversationTimeline";
import { ConversationComposer } from "./ConversationComposer";

/**
 * Conversation navigator (C3-A + C4-A): the Conversation Workbench surface
 * over the accepted C2 API family. Lists conversations, creates one via its
 * FIRST raw-text message, and selects one through the C1/runnable-roster-
 * gated attach route: a successful attach opens the ACTIVE surface
 * (immutable whole-history reread + scoped live SSE + raw-text composer); a
 * rejected attach opens the visibly READ-ONLY inspection surface (history
 * only, no composer, no live stream).
 *
 * C4-A adds the sole durable hash route `#conversation/<id>`: the initial
 * hash and every later browser `hashchange` each perform a FRESH manifest
 * read + the existing stateless attach gate before presenting any active
 * surface. Own navigations write the hash with history.pushState (which
 * fires no hashchange), so Back/Forward re-opens via the fresh gate without
 * duplicate writes, attaches, or stream subscriptions. Malformed/unknown
 * hashes and nonexistent conversations fail truthfully to the list with a
 * bounded message and never create a draft, dispatch, mutate, or fabricate
 * client state.
 *
 * The browser never scans, resolves, or derives dispatch recipients from
 * `@text` — the gateway alone parses mentions. No approval or abort
 * controls, vault/graph navigation, configuration controls, storage, or
 * service worker.
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
  /** Visible bounded route/error notice shown above the conversation list. */
  const [notice, setNotice] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const newConversationRef = useRef<HTMLButtonElement>(null);
  const pendingFocusId = useRef<string | null>(null);
  /** Generation guard so only the newest open flow applies its result. */
  const openSeqRef = useRef(0);

  /** Invalidate any in-flight open flow (navigation home/back/invalid). */
  function cancelPendingOpen() {
    openSeqRef.current += 1;
  }

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

  /** Own navigations write the hash via pushState (fires no hashchange). */
  function writeHash(hash: string) {
    if (window.location.hash === hash) return;
    history.pushState(null, "", hash);
  }

  /** Return to the list: clear the fragment without a hashchange event. */
  function clearHash() {
    const url = urlWithoutHash(window.location.href);
    if (window.location.href === url) return;
    history.pushState(null, "", url);
  }

  /**
   * Fresh open flow for one conversation id (initial hash, hashchange, and
   * list selection share it): a fresh manifest read, then the existing
   * stateless attach gate. A successful attach presents the active surface;
   * a rejected attach (unavailable audience, archived, ...) presents visibly
   * read-only inspection with the fresh durable record. A nonexistent or
   * unavailable conversation fails truthfully to the list — never a draft,
   * dispatch, mutation, or fabricated client state.
   */
  const openConversationById = useCallback(
    async (conversationId: string) => {
      const seq = ++openSeqRef.current;
      setSelection({ phase: "attaching" });
      setNotice(null);
      try {
        const conversation = await fetchConversation(conversationId, token);
        if (seq !== openSeqRef.current) return;
        const response = await attachConversation(conversationId, token);
        if (seq !== openSeqRef.current) return;
        if (response.attached) {
          setSelection({ phase: "active", conversation: response.conversation });
        } else {
          // Rejected: read-only inspection (history only, no composer, no
          // live stream) using the fresh durable manifest.
          setSelection({ phase: "read-only", conversation, message: response.error });
        }
      } catch (error) {
        if (seq !== openSeqRef.current) return;
        if (error instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setSelection({ phase: "none" });
        setNotice(error instanceof Error ? error.message : String(error));
        listHeadingRef.current?.focus();
      }
    },
    [token, onUnauthorized],
  );

  // Initial hash navigation + every later browser hashchange (Back/Forward,
  // manual edits) performs a FRESH read + attach. Own pushState writes never
  // fire hashchange, so they cannot double-attach or double-subscribe.
  useEffect(() => {
    let cancelled = false;
    const handleHash = () => {
      if (cancelled) return;
      const intent = routeToIntent(parseHashRoute(window.location.hash));
      if (intent.kind === "show-home") {
        cancelPendingOpen();
        setSelection({ phase: "none" });
        setNotice(null);
        setAnnouncement("");
        return;
      }
      if (intent.kind === "invalid-route") {
        // Malformed/unknown hash: fail truthfully to the list, no request.
        cancelPendingOpen();
        setSelection({ phase: "none" });
        setNotice("Unknown route — showing the conversation list.");
        setAnnouncement("");
        listHeadingRef.current?.focus();
        return;
      }
      void openConversationById(intent.conversationId);
    };
    handleHash(); // initial deep link (or home)
    window.addEventListener("hashchange", handleHash);
    return () => {
      cancelled = true;
      window.removeEventListener("hashchange", handleHash);
    };
  }, [openConversationById]);

  async function handleSelect(conversationId: string) {
    writeHash(formatConversationHash(conversationId));
    await openConversationById(conversationId);
  }

  function handleBack() {
    cancelPendingOpen();
    clearHash();
    setSelection({ phase: "none" });
    setNotice(null);
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
    writeHash(formatConversationHash(conversation.id));
    // A freshly created conversation's members were validated against the
    // local runnable set at creation, so attach opens it as active.
    await openConversationById(conversation.id);
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
        <AudienceMembers audience={selection.conversation.audience} agents={load.phase === "ready" ? load.agents : []} />
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
      {notice !== null && (
        <p className="route-notice" role="status">
          {notice}
        </p>
      )}
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
      {selection.phase === "attaching" && (
        <p className="muted" role="status">
          Attaching conversation…
        </p>
      )}
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
