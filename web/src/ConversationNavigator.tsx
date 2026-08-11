import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import {
  abortConversationRun,
  approveConversationApproval,
  archiveConversation,
  attachConversation,
  ConversationControlHttpError,
  createConversation,
  fetchConversation,
  fetchConversations,
  fetchRoomAgents,
  LifecycleHttpError,
  reopenConversation,
  UnauthorizedError,
} from "./api";
import type { ConversationRecord, ConversationEventRecord } from "./conversations";
import { classifyAudienceMembers, type MemberRunnableStatus } from "./attach";
import {
  abortAnnouncement,
  approvalCardMessage,
  approvalCardTitle,
  approvalRequestedAnnouncement,
  approvalResponseAnnouncement,
  conversationHandoffGateLabel,
  handoffGateRequestedAnnouncement,
  networkConversationControlError,
  parseConversationHandoffGate,
  type ApprovalResponse,
  type ConversationControlError,
  type PendingApproval,
} from "./conversation-controls";
import {
  archiveConfirmationCopy,
  type ConversationLifecycleAction,
  type LifecycleActionError,
} from "./conversation-lifecycle";
import { formatConversationHash, parseHashRoute, routeToIntent, urlWithoutHash } from "./hash-route";
import type { RoomAgentEntry } from "./rooms";
import { ConversationTimeline } from "./ConversationTimeline";
import { ConversationComposer } from "./ConversationComposer";

/**
 * Conversation navigator (C3-A + C4-A + L3): the Conversation Workbench
 * surface over the accepted C2 API family. Lists conversations, creates one
 * via its FIRST raw-text message, and selects one through the
 * C1/runnable-roster-gated attach route: a successful attach opens the ACTIVE
 * surface (immutable whole-history reread + scoped live SSE + raw-text
 * composer); a rejected attach opens the visibly READ-ONLY inspection surface
 * (history only, no composer, no live stream).
 *
 * L3 adds the minimal first-party lifecycle controls over the accepted L2
 * routes: Archive (on every selected open Conversation — active or read-only
 * due to a non-runnable audience, behind a non-modal inline confirmation) and
 * Reopen (only on selected archived read-only inspection). The browser only
 * sends the fixed action + selected id; after ANY successful lifecycle POST
 * (including transitioned:false) it re-runs the C4-A fresh manifest/attach
 * gate before deciding active/read-only — never an implicit attach, stream,
 * or composer from the POST response. A live scoped SSE lifecycle event
 * requests the same fresh re-gate exactly once per received event; archive
 * from another client becomes inspection-only, reopen only becomes active if
 * the attach gate accepts every durable member.
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

/** L3 lifecycle control state: idle | busy | bounded error with manual Retry. */
type LifecycleControlState =
  | { phase: "idle" }
  | { phase: "busy"; action: ConversationLifecycleAction }
  | { phase: "error"; action: ConversationLifecycleAction; error: LifecycleActionError };

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
  /** L3 lifecycle state + archive confirmation. */
  const [lifecycle, setLifecycle] = useState<LifecycleControlState>({ phase: "idle" });
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  /** L3 announcement intent consumed by the selection effect on re-gate. */
  const lifecycleNoticeRef = useRef<"archive" | "reopen" | "derived" | null>(null);
  const archiveButtonRef = useRef<HTMLButtonElement>(null);
  const confirmArchiveRef = useRef<HTMLButtonElement>(null);
  /** C3-C3: pending approval cards derived ONLY from scoped live frames. */
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  /** C3-C3: in-flight/errored approval response per request id (manual Retry). */
  const [approvalSubmit, setApprovalSubmit] = useState<
    | { phase: "idle" }
    | { phase: "busy"; requestId: string }
    | { phase: "error"; requestId: string; attempted: ApprovalResponse; error: ConversationControlError }
  >({ phase: "idle" });
  /** C3-C3: abort control state (active surface only; one conversation×agent run). */
  const [abortState, setAbortState] = useState<
    | { phase: "idle" }
    | { phase: "busy"; agent: string }
    | { phase: "error"; agent: string; error: ConversationControlError }
  >({ phase: "idle" });

  /** Reset the lifecycle controls when leaving the current view. */
  function resetLifecycleControls() {
    setLifecycle({ phase: "idle" });
    setConfirmingArchive(false);
    // Clear any unconsumed announcement intent: a failed or superseded
    // lifecycle action must never mis-announce on a later selection.
    lifecycleNoticeRef.current = null;
  }

  /** C3-C3: clear stale approval/abort UI state on re-gate or navigation. */
  function resetApprovalControls() {
    setPendingApprovals([]);
    setApprovalSubmit({ phase: "idle" });
    setAbortState({ phase: "idle" });
  }

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
      // L3: a lifecycle re-gate (explicit action or live SSE) announces the
      // lifecycle state via the polite status seam; otherwise the attach-based
      // presentation announcement is used.
      const lifecycleNotice = lifecycleNoticeRef.current;
      lifecycleNoticeRef.current = null;
      if (lifecycleNotice === "archive") {
        setAnnouncement("Conversation archived.");
      } else if (lifecycleNotice === "reopen") {
        setAnnouncement("Conversation reopened.");
      } else if (lifecycleNotice === "derived") {
        setAnnouncement(selection.conversation.status === "open" ? "Conversation reopened." : "Conversation archived.");
      } else if (selection.phase === "active") {
        setAnnouncement(`Conversation attached as active: ${selection.conversation.title}`);
      } else {
        setAnnouncement(`Conversation open in read-only inspection: ${selection.conversation.title}`);
      }
    }
  }, [selection]);

  // L3: opening the archive confirmation moves focus to the Confirm button;
  // cancelling returns focus to the Archive button (usable focus path).
  useEffect(() => {
    if (confirmingArchive) confirmArchiveRef.current?.focus();
  }, [confirmingArchive]);

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
      // C3-C3: every fresh attach/lifecycle gate clears stale pending
      // approval/abort UI state; controls never activate or attach anything.
      resetApprovalControls();
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
          lifecycleNoticeRef.current = null;
          onUnauthorized();
          return;
        }
        // The open flow failed: no selection is presented, so no lifecycle
        // announcement intent may survive to a later selection.
        lifecycleNoticeRef.current = null;
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
        resetLifecycleControls();
        setSelection({ phase: "none" });
        setNotice(null);
        setAnnouncement("");
        return;
      }
      if (intent.kind === "invalid-route") {
        // Malformed/unknown hash: fail truthfully to the list, no request.
        cancelPendingOpen();
        resetLifecycleControls();
        setSelection({ phase: "none" });
        setNotice("Unknown route — showing the conversation list.");
        setAnnouncement("");
        listHeadingRef.current?.focus();
        return;
      }
      resetLifecycleControls();
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
    resetLifecycleControls();
    writeHash(formatConversationHash(conversationId));
    await openConversationById(conversationId);
  }

  function handleBack() {
    cancelPendingOpen();
    resetLifecycleControls();
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
    resetLifecycleControls();
    writeHash(formatConversationHash(conversation.id));
    // A freshly created conversation's members were validated against the
    // local runnable set at creation, so attach opens it as active.
    await openConversationById(conversation.id);
  }

  /**
   * L3: one fixed lifecycle action (archive|reopen) sent to the L2 route.
   * Gateway-authoritative only: the POST response is parsed for envelope
   * validity but NEVER drives presentation — after ANY successful lifecycle
   * POST (including transitioned:false) the C4-A fresh manifest/attach gate
   * decides active/read-only. 404 returns to the list with a bounded status;
   * 409 is a bounded visible error with a manual Retry; a bounded L2 500
   * fresh-gates before presenting any status (the manifest may already have
   * transitioned without an event — no rollback/repair/fabrication).
   */
  async function handleLifecycleAction(action: ConversationLifecycleAction) {
    if (selection.phase !== "active" && selection.phase !== "read-only") return;
    const conversationId = selection.conversation.id;
    setConfirmingArchive(false);
    setLifecycle({ phase: "busy", action });
    lifecycleNoticeRef.current = action;
    try {
      await (action === "archive" ? archiveConversation(conversationId, token) : reopenConversation(conversationId, token));
      await openConversationById(conversationId);
      setLifecycle({ phase: "idle" });
    } catch (cause) {
      if (cause instanceof UnauthorizedError) {
        lifecycleNoticeRef.current = null;
        onUnauthorized();
        return;
      }
      if (cause instanceof LifecycleHttpError) {
        if (cause.kind === "not-found") {
          // 404: return safely to the list with a bounded status.
          lifecycleNoticeRef.current = null;
          setLifecycle({ phase: "idle" });
          setSelection({ phase: "none" });
          setNotice("Conversation not found.");
          listHeadingRef.current?.focus();
          return;
        }
        if (cause.kind === "server") {
          // Bounded L2 500: the manifest may already have transitioned (the
          // L2 event-append residual). Fresh-gate before presenting any
          // status; never assume rollback or fabricate an event/status.
          lifecycleNoticeRef.current = "derived";
          void openConversationById(conversationId);
          setLifecycle({ phase: "error", action, error: cause });
          return;
        }
        // 409 conflict: bounded error with a manual Retry; no announcement.
        lifecycleNoticeRef.current = null;
        setLifecycle({ phase: "error", action, error: cause });
        return;
      }
      lifecycleNoticeRef.current = null;
      setLifecycle({
        phase: "error",
        action,
        error: { kind: "network", message: cause instanceof Error ? cause.message : String(cause) },
      });
    }
  }

  /**
   * C3-C3: a scoped live `approval` frame for the selected active
   * conversation creates one card (deduped by agent+requestId). The browser
   * never invents recipients, request ids, or approval state. C5-4: a frame
   * recognized as a C5 initial-handoff gate is announced truthfully as a
   * handoff gate (source → target); every other frame keeps the generic
   * approval announcement.
   */
  const handleApprovalFrame = useCallback((approval: PendingApproval) => {
    setPendingApprovals((previous) => {
      if (previous.some((pending) => pending.agent === approval.agent && pending.requestId === approval.requestId)) {
        return previous;
      }
      return [...previous, approval];
    });
    const gate = parseConversationHandoffGate(approval);
    setAnnouncement(gate !== null ? handoffGateRequestedAnnouncement(approval, gate) : approvalRequestedAnnouncement(approval));
  }, []);

  /**
   * C3-C3: submit one exactly-one approval response to the declared approve
   * route. Success is delivery acceptance only (never a fabricated agent
   * outcome); errors are bounded with a manual Retry.
   */
  async function handleApprovalResponse(approval: PendingApproval, response: ApprovalResponse) {
    if (selection.phase !== "active") return;
    setApprovalSubmit({ phase: "busy", requestId: approval.requestId });
    try {
      await approveConversationApproval(selection.conversation.id, approval.agent, approval.requestId, response, token);
      setPendingApprovals((previous) => previous.filter((pending) => pending.requestId !== approval.requestId));
      setApprovalSubmit({ phase: "idle" });
      setAnnouncement(approvalResponseAnnouncement(approval.agent));
    } catch (cause) {
      if (cause instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      if (cause instanceof ConversationControlHttpError) {
        setApprovalSubmit({
          phase: "error",
          requestId: approval.requestId,
          attempted: response,
          error: { kind: cause.kind, message: cause.message },
        });
        return;
      }
      setApprovalSubmit({
        phase: "error",
        requestId: approval.requestId,
        attempted: response,
        error: networkConversationControlError(cause),
      });
    }
  }

  /**
   * C3-C3: abort the active run for exactly one conversation×agent member.
   * The bounded cancelled|no-active-run outcome is announced truthfully;
   * errors are bounded with a manual Retry.
   */
  async function handleAbort(agent: string) {
    if (selection.phase !== "active") return;
    setAbortState({ phase: "busy", agent });
    try {
      const outcome = await abortConversationRun(selection.conversation.id, agent, token);
      setAbortState({ phase: "idle" });
      setAnnouncement(abortAnnouncement(outcome));
    } catch (cause) {
      if (cause instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setAbortState({
        phase: "error",
        agent,
        error:
          cause instanceof ConversationControlHttpError
            ? { kind: cause.kind, message: cause.message }
            : networkConversationControlError(cause),
      });
    }
  }

  /**
   * L3: a live scoped SSE lifecycle event for the selected Conversation
   * requests the SAME fresh navigator re-gate exactly once per received
   * event. The fresh attach result decides presentation (archive from
   * another client ends inspection-only; reopen still relies on the gate).
   */
  const handleLifecycleEvent = useCallback(
    (event: ConversationEventRecord) => {
      lifecycleNoticeRef.current = "derived";
      void openConversationById(event.conversationId);
    },
    [openConversationById],
  );

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
        <ConversationLifecycleControls
          status={selection.conversation.status}
          phase={lifecycle.phase}
          error={lifecycle.phase === "error" ? lifecycle.error : null}
          confirmingArchive={confirmingArchive}
          archiveButtonRef={archiveButtonRef}
          confirmArchiveRef={confirmArchiveRef}
          onArchiveRequest={() => setConfirmingArchive(true)}
          onCancelArchive={() => {
            setConfirmingArchive(false);
            archiveButtonRef.current?.focus();
          }}
          onConfirmArchive={() => void handleLifecycleAction("archive")}
          onReopen={() => void handleLifecycleAction("reopen")}
          onRetry={() => {
            if (lifecycle.phase === "error") void handleLifecycleAction(lifecycle.action);
          }}
        />
        {active ? (
          <>
            <ConversationApprovalCards
              approvals={pendingApprovals}
              submit={approvalSubmit}
              onRespond={(approval, response) => void handleApprovalResponse(approval, response)}
            />
            <ConversationAbortControls
              members={selection.conversation.audience}
              state={abortState}
              onAbort={(agent) => void handleAbort(agent)}
            />
            <ConversationTimeline
              conversationId={selection.conversation.id}
              token={token}
              live={true}
              onUnauthorized={onUnauthorized}
              onLifecycleTransition={handleLifecycleEvent}
              onApproval={handleApprovalFrame}
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

/**
 * L3 minimal lifecycle controls: Archive on every selected open Conversation
 * (active or read-only due to a non-runnable audience) behind an explicit
 * non-modal inline confirmation; Reopen only on selected archived read-only
 * inspection. No list-row or batch actions; never a native/browser modal.
 */
function ConversationLifecycleControls({
  status,
  phase,
  error,
  confirmingArchive,
  archiveButtonRef,
  confirmArchiveRef,
  onArchiveRequest,
  onCancelArchive,
  onConfirmArchive,
  onReopen,
  onRetry,
}: {
  status: string;
  phase: "idle" | "busy" | "error";
  error: LifecycleActionError | null;
  confirmingArchive: boolean;
  archiveButtonRef: RefObject<HTMLButtonElement | null>;
  confirmArchiveRef: RefObject<HTMLButtonElement | null>;
  onArchiveRequest: () => void;
  onCancelArchive: () => void;
  onConfirmArchive: () => void;
  onReopen: () => void;
  onRetry: () => void;
}) {
  const busy = phase === "busy";
  if (status === "archived") {
    return (
      <div className="lifecycle-controls">
        <button type="button" className="button" onClick={onReopen} disabled={busy}>
          Reopen
        </button>
        {phase === "error" && error !== null && <LifecycleErrorNotice error={error} onRetry={onRetry} />}
      </div>
    );
  }
  const copy = archiveConfirmationCopy();
  return (
    <div className="lifecycle-controls">
      <button type="button" ref={archiveButtonRef} className="button" onClick={onArchiveRequest} disabled={busy}>
        Archive
      </button>
      {confirmingArchive && (
        <div className="confirmation-card" role="group" aria-label="Confirm archive">
          <p>{copy.intro}</p>
          <div className="confirmation-actions">
            <button type="button" ref={confirmArchiveRef} className="button button-primary" onClick={onConfirmArchive} disabled={busy}>
              {copy.confirm}
            </button>
            <button type="button" className="button" onClick={onCancelArchive} disabled={busy}>
              {copy.cancel}
            </button>
          </div>
        </div>
      )}
      {phase === "error" && error !== null && <LifecycleErrorNotice error={error} onRetry={onRetry} />}
    </div>
  );
}

/** Bounded lifecycle error with an explicit manual Retry (never automatic). */
function LifecycleErrorNotice({ error, onRetry }: { error: LifecycleActionError; onRetry: () => void }) {
  return (
    <div className="lifecycle-error" role="alert">
      <p className="error-message">{error.message}</p>
      <button type="button" className="button button-small" onClick={onRetry}>
        Retry
      </button>
    </div>
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

/**
 * C3-C3: non-modal approval cards for the selected ACTIVE conversation's
 * pending approvals, derived ONLY from scoped live frames. Confirm / Cancel
 * (and a labeled input for select/input) submit exactly-one response bodies;
 * success is delivery acceptance only. Errors are bounded with a manual
 * Retry; focus moves into the card on arrival; the polite announcement is
 * made by the navigator.
 */
function ConversationApprovalCards({
  approvals,
  submit,
  onRespond,
}: {
  approvals: PendingApproval[];
  submit:
    | { phase: "idle" }
    | { phase: "busy"; requestId: string }
    | { phase: "error"; requestId: string; attempted: ApprovalResponse; error: ConversationControlError };
  onRespond: (approval: PendingApproval, response: ApprovalResponse) => void;
}) {
  if (approvals.length === 0) return null;
  return (
    <div className="approval-cards" aria-label="Pending approvals">
      {approvals.map((approval) => (
        <ApprovalCard
          key={approval.requestId}
          approval={approval}
          submitting={submit.phase === "busy" && submit.requestId === approval.requestId}
          failure={submit.phase === "error" && submit.requestId === approval.requestId ? { attempted: submit.attempted, error: submit.error } : null}
          onRespond={onRespond}
        />
      ))}
    </div>
  );
}

function ApprovalCard({
  approval,
  submitting,
  failure,
  onRespond,
}: {
  approval: PendingApproval;
  submitting: boolean;
  /** Bounded failure carrying the exact attempted response for manual Retry. */
  failure: { attempted: ApprovalResponse; error: ConversationControlError } | null;
  onRespond: (approval: PendingApproval, response: ApprovalResponse) => void;
}) {
  const [inputValue, setInputValue] = useState("");
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const needsInput = approval.method === "select" || approval.method === "input";
  // C5-4: display-only recognition of an eligible C5 initial-handoff gate. A
  // recognized gate is titled as a handoff request naming the source agent
  // and proposed target with the bounded handoff text; every other frame
  // keeps the generic card. Confirm/Cancel, exactly-one, focus, error/Retry,
  // and announcement semantics are unchanged.
  const gate = parseConversationHandoffGate(approval);
  const message = gate !== null ? gate.text : approvalCardMessage(approval);
  // Deliberate focus policy: on arrival, focus the input (select/input) or
  // the Confirm button (confirm), so the steward can act without hunting.
  useEffect(() => {
    if (needsInput) {
      inputRef.current?.focus();
    } else {
      confirmButtonRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only intent
  }, []);
  const primary = () =>
    onRespond(approval, needsInput ? { value: inputValue } : { confirmed: true });
  return (
    <div
      className="approval-card"
      role="group"
      aria-label={
        gate !== null
          ? `Handoff request: ${conversationHandoffGateLabel(gate, approval.agent)}`
          : `Approval requested by ${approval.agent}`
      }
    >
      <p className="approval-title">{gate !== null ? "Handoff request" : approvalCardTitle(approval)}</p>
      {message !== "" && <p className="muted">{message}</p>}
      {gate !== null ? (
        <p className="approval-meta">
          <code>{approval.agent}</code> → <code>{gate.to}</code>
        </p>
      ) : (
        <p className="approval-meta">
          <code>{approval.agent}</code> · {approval.method}
        </p>
      )}
      {needsInput && (
        <>
          <label htmlFor={`approval-input-${approval.requestId}`}>Response</label>
          <input
            id={`approval-input-${approval.requestId}`}
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            disabled={submitting}
          />
        </>
      )}
      <div className="confirmation-actions">
        <button type="button" ref={confirmButtonRef} className="button button-primary" disabled={submitting} onClick={primary}>
          {needsInput ? "Submit" : "Confirm"}
        </button>
        <button
          type="button"
          className="button"
          disabled={submitting}
          onClick={() => onRespond(approval, { cancelled: true })}
        >
          Cancel
        </button>
      </div>
      {failure !== null && (
        <div className="lifecycle-error" role="alert">
          <p className="error-message">{failure.error.message}</p>
          <button type="button" className="button button-small" disabled={submitting} onClick={() => onRespond(approval, failure.attempted)}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * C3-C3: Abort control for the selected ACTIVE conversation only. One Abort
 * per audience member sends only `{agent}` to the declared route; the bounded
 * cancelled|no-active-run outcome is announced truthfully. Never shown on
 * read-only/archived/gate-rejected inspection.
 */
function ConversationAbortControls({
  members,
  state,
  onAbort,
}: {
  members: string[];
  state:
    | { phase: "idle" }
    | { phase: "busy"; agent: string }
    | { phase: "error"; agent: string; error: ConversationControlError };
  onAbort: (agent: string) => void;
}) {
  if (members.length === 0) return null;
  return (
    <div className="run-controls" aria-label="Active run controls">
      <h3>Active run</h3>
      <ul className="run-control-list">
        {members.map((agent) => (
          <li key={agent} className="run-control-row">
            <span className="member-name">{agent}</span>
            <button
              type="button"
              className="button button-small"
              disabled={state.phase === "busy"}
              onClick={() => onAbort(agent)}
            >
              Abort
            </button>
            {state.phase === "busy" && state.agent === agent && <span className="muted">Aborting…</span>}
            {state.phase === "error" && state.agent === agent && (
              <div className="lifecycle-error" role="alert">
                <p className="error-message">{state.error.message}</p>
                <button type="button" className="button button-small" onClick={() => onAbort(agent)}>
                  Retry
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
