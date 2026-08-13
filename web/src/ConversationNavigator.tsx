import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  abortConversationRun,
  approveConversationApproval,
  archiveConversation,
  attachConversation,
  ConversationControlHttpError,
  fetchConversation,
  fetchRoomAgents,
  LifecycleHttpError,
  RenameHttpError,
  renameConversation,
  reopenConversation,
  UnauthorizedError,
} from "./api";
import type { ConversationRecord, ConversationEventRecord } from "./conversations";
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
  type ConversationLifecycleAction,
  type LifecycleActionError,
} from "./conversation-lifecycle";
import { formatConversationHash, parseHashRoute, routeToIntent } from "./hash-route";
import { renameAnnouncement, type RenameError } from "./conversation-details";
import { InfoIcon } from "./icons";
import type { RoomAgentEntry } from "./rooms";
import { ConversationDetailsModal, ConversationLifecycleControls } from "./ConversationDetailsModal";
import { ConversationTimeline } from "./ConversationTimeline";
import { ConversationComposer } from "./ConversationComposer";
import {
  applyConversationScrollWiring,
  EMPTY_CONVERSATION_SCROLL_WIRING,
  type ConversationScrollWiringState,
} from "./conversation-scroll-wiring";

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
 * hashes and nonexistent conversations fail truthfully to the new-conversation
 * draft with a bounded message and never create a draft, dispatch, mutate, or
 * fabricate client state.
 *
 * The browser never scans, resolves, or derives dispatch recipients from
 * `@text` — the gateway alone parses mentions. No approval or abort
 * controls, vault/graph navigation, configuration controls, storage, or
 * service worker.
 */

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; agents: RoomAgentEntry[] };

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
  onConversationsChanged,
  onSelectionChange,
}: {
  token: string;
  onUnauthorized: () => void;
  onValidated: () => void;
  /** U1/U2: a conversation was created or renamed (sidebar list refresh). */
  onConversationsChanged: () => void;
  /**
   * P2: the shell subtitle follows the selected gateway-authoritative title
   * (active or read-only), or null when the draft/list is shown.
   */
  onSelectionChange?: (title: string | null) => void;
}) {
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [selection, setSelection] = useState<SelectionState>({ phase: "none" });
  const [announcement, setAnnouncement] = useState("");
  /** Visible bounded route/error notice shown above the conversation list. */
  const [notice, setNotice] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  /** P2: focus target for the uncarded selected-conversation surface. */
  const surfaceRef = useRef<HTMLElement>(null);
  /**
   * P2: a silent manifest refresh (accepted message) must not steal focus or
   * re-announce the attach; only the manifest/subtitle follow the fresh read.
   */
  const silentRefreshRef = useRef(false);
  /** Generation guard so only the newest open flow applies its result. */
  const openSeqRef = useRef(0);
  /** L3 lifecycle state + archive confirmation. */
  const [lifecycle, setLifecycle] = useState<LifecycleControlState>({ phase: "idle" });
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  /** L3 announcement intent consumed by the selection effect on re-gate. */
  const lifecycleNoticeRef = useRef<"archive" | "reopen" | "derived" | null>(null);
  /** U2 announcement intent (the returned authoritative title) consumed on re-gate. */
  const renameNoticeRef = useRef<string | null>(null);
  const archiveButtonRef = useRef<HTMLButtonElement>(null);
  const confirmArchiveRef = useRef<HTMLButtonElement>(null);
  /** U2 details modal: open state + the invoking button for focus return. */
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
  /** P6: the single transcript scroll region (bottom-anchored by default). */
  const scrollRef = useRef<HTMLDivElement>(null);
  /** P8 (§5): commit-time anchor wiring — pre-commit metrics ref + one-shot
      initial-anchor flag, driven by the content-version layout effect. */
  const scrollWiringRef = useRef<ConversationScrollWiringState>(EMPTY_CONVERSATION_SCROLL_WIRING);
  /** P8 (§5): bumped by every durable/activity/summary append and the initial
      history load; the layout effect applies the anchor decision per commit. */
  const [contentVersion, setContentVersion] = useState(0);
  const bumpContentVersion = useCallback(() => setContentVersion((version) => version + 1), []);
  /** P8 (§1): one-shot first-draft-send focus intent for the ACTIVE composer. */
  const [justCreatedFocus, setJustCreatedFocus] = useState(false);

  /**
   * P8 (§5): apply the commit-time bottom-anchor decision in a layout effect
   * that runs AFTER React commits appended content (durable items, permitted
   * activity, retained summaries). The pure core decides with the PRE-commit
   * metrics ref: anchored reader follows to the new bottom (auto behavior);
   * an upward reader keeps the exact position; batch appends in one commit
   * produce one decision; reduced-motion stays auto. The initial whole-history
   * load forces the bottom. Focus restoration uses preventScroll and the
   * composer lives outside the scroll region, so it never breaks anchoring.
   */
  const surfaceKey =
    selection.phase === "active"
      ? selection.conversation.id
      : selection.phase === "read-only"
        ? selection.conversation.id
        : "draft";

  useEffect(() => {
    scrollWiringRef.current = EMPTY_CONVERSATION_SCROLL_WIRING;
  }, [surfaceKey]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    scrollWiringRef.current = applyConversationScrollWiring(el, scrollWiringRef.current);
  }, [contentVersion, surfaceKey]);

  // P8 (§1): the one-shot first-draft-send focus intent is consumed by the
  // freshly mounted ACTIVE composer (child effect runs before this one) and
  // then cleared so it can never re-fire on re-render, reselect, or nav.
  useEffect(() => {
    if (selection.phase === "active" && justCreatedFocus) {
      setJustCreatedFocus(false);
    }
  }, [selection, justCreatedFocus]);
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
    setDetailsOpen(false);
    // Clear any unconsumed announcement intent: a failed or superseded
    // lifecycle action or rename must never mis-announce on a later selection.
    lifecycleNoticeRef.current = null;
    renameNoticeRef.current = null;
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
      const response = await fetchRoomAgents(token, signal);
      return { agents: response.agents };
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
        setLoad({ phase: "ready", agents: data.agents });
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
      // P2: the subtitle follows the re-gated gateway-authoritative title.
      onSelectionChange?.(selection.conversation.title);
      const silent = silentRefreshRef.current;
      silentRefreshRef.current = false;
      if (!silent) {
        surfaceRef.current?.focus();
      }
      // U2: a rename re-gate announces the returned authoritative title;
      // otherwise the L3 lifecycle notice or the attach-based presentation
      // announcement is used. A silent P2 manifest refresh announces nothing.
      const renameNotice = renameNoticeRef.current;
      renameNoticeRef.current = null;
      const lifecycleNotice = lifecycleNoticeRef.current;
      lifecycleNoticeRef.current = null;
      if (silent) {
        // no announcement for a silent refresh
      } else if (renameNotice !== null) {
        setAnnouncement(renameAnnouncement(renameNotice));
      } else if (lifecycleNotice === "archive") {
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
  }, [selection, onSelectionChange]);

  // L3: opening the archive confirmation moves focus to the Confirm button;
  // cancelling returns focus to the Archive button (usable focus path).
  useEffect(() => {
    if (confirmingArchive) confirmArchiveRef.current?.focus();
  }, [confirmingArchive]);

  function handleRetry() {
    setLoad({ phase: "loading" });
    setRetryKey((key) => key + 1);
  }

  /**
   * Fresh open flow for one conversation id (initial hash, hashchange, and
   * list selection share it): a fresh manifest read, then the existing
   * stateless attach gate. A successful attach presents the active surface;
   * a rejected attach (unavailable audience, archived, ...) presents visibly
   * read-only inspection with the fresh durable record. A nonexistent or
   * unavailable conversation fails truthfully to the draft surface — never a
   * draft, dispatch, mutation, or fabricated client state.
   */
  const openConversationById = useCallback(
    async (conversationId: string) => {
      const seq = ++openSeqRef.current;
      // C3-C3: every fresh attach/lifecycle gate clears stale pending
      // approval/abort UI state; controls never activate or attach anything.
      resetApprovalControls();
      // U2: a fresh selection never re-opens the details modal from a
      // previous conversation.
      setDetailsOpen(false);
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
        renameNoticeRef.current = null;
        setSelection({ phase: "none" });
        // P2: the draft keeps the calm generic shell subtitle.
        onSelectionChange?.(null);
        setNotice(error instanceof Error ? error.message : String(error));
        surfaceRef.current?.focus();
      }
    },
    [token, onUnauthorized, onSelectionChange],
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
        // P2: the draft keeps the calm generic shell subtitle.
        onSelectionChange?.(null);
        return;
      }
      if (intent.kind === "invalid-route") {
        // Malformed/unknown hash: fail truthfully to the draft surface, no request.
        cancelPendingOpen();
        resetLifecycleControls();
        setSelection({ phase: "none" });
        setNotice("Unknown route — showing the new-conversation draft.");
        setAnnouncement("");
        onSelectionChange?.(null);
        surfaceRef.current?.focus();
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
      // P2: after an accepted lifecycle action, refresh the sidebar list from
      // the existing list read, then the fresh manifest/attach re-gate.
      onConversationsChanged();
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
          surfaceRef.current?.focus();
          return;
        }
        if (cause.kind === "server") {
          // Bounded L2 500: the manifest may already have transitioned (the
          // L2 event-append residual). Fresh-gate before presenting any
          // status; never assume rollback or fabricate an event/status. The
          // sidebar list also refreshes to the gateway truth.
          lifecycleNoticeRef.current = "derived";
          onConversationsChanged();
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

  /**
   * U1: the main-window draft's first message persisted a conversation. The
   * sidebar refreshes its list; the durable hash route opens the conversation
   * through the same fresh attach gate as any sidebar selection.
   */
  function handleCreated(conversation: ConversationRecord) {
    onConversationsChanged();
    resetLifecycleControls();
    // P8 (§1): the one-shot focus intent for the freshly mounted ACTIVE
    // composer — consumed exactly once on mount, never for nav/reselect.
    setJustCreatedFocus(true);
    setAnnouncement(`Conversation created: ${conversation.title}`);
    window.location.hash = formatConversationHash(conversation.id);
  }

  /**
   * P2 — after an accepted ACTIVE send (including a validated membership
   * addition), refresh the sidebar list and the selected manifest strictly
   * from existing gateway reads: never an optimistic/invented audience and
   * never a new API/schema. A bounded read failure keeps the last known
   * gateway manifest (no fabrication, no retry) and never steals focus or
   * re-announces the attach (silent refresh).
   */
  const handleMessageSent = useCallback(() => {
    if (selection.phase !== "active") return;
    const conversationId = selection.conversation.id;
    onConversationsChanged();
    void (async () => {
      try {
        const conversation = await fetchConversation(conversationId, token);
        silentRefreshRef.current = true;
        setSelection((previous) =>
          previous.phase === "active" && previous.conversation.id === conversationId ? { ...previous, conversation } : previous,
        );
      } catch (cause) {
        if (cause instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        // Bounded: keep the last known gateway manifest; never fabricate.
      }
    })();
  }, [selection, token, onUnauthorized, onConversationsChanged]);

  /**
   * U2: the details modal invokes this with the normalized title. The raw
   * title goes to the authenticated rename route only; on success the
   * sidebar refreshes, the modal closes, and the C4-A fresh re-read/re-gate
   * presents the authoritative result (announced via renameNoticeRef). A
   * bounded failure returns a typed error for the modal's visible Retry.
   */
  async function handleRenameRequest(title: string): Promise<RenameError | null> {
    if (selection.phase !== "active" && selection.phase !== "read-only") return null;
    const conversationId = selection.conversation.id;
    try {
      const result = await renameConversation(conversationId, title, token);
      renameNoticeRef.current = result.conversation.title;
      onConversationsChanged();
      setDetailsOpen(false);
      void openConversationById(conversationId);
      return null;
    } catch (cause) {
      if (cause instanceof UnauthorizedError) {
        onUnauthorized();
        return null;
      }
      if (cause instanceof RenameHttpError) {
        return { kind: cause.kind, message: cause.message };
      }
      return { kind: "network", message: "The rename request failed. Check the gateway and retry." };
    }
  }

  function openDetails() {
    setDetailsOpen(true);
  }

  function closeDetails() {
    setDetailsOpen(false);
    detailsButtonRef.current?.focus();
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
      <section
        className="conversation-surface"
        aria-label={`Conversation: ${selection.conversation.title}`}
        tabIndex={-1}
        ref={surfaceRef}
      >
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
        {active ? (
          <>
            <div className="conversation-workspace">
              <div className="conversation-scroll" ref={scrollRef}>
                <ConversationApprovalCards
                  approvals={pendingApprovals}
                  submit={approvalSubmit}
                  onRespond={(approval, response) => void handleApprovalResponse(approval, response)}
                />
                <ConversationTimeline
                  conversationId={selection.conversation.id}
                  token={token}
                  live={true}
                  onUnauthorized={onUnauthorized}
                  onLifecycleTransition={handleLifecycleEvent}
                  onApproval={handleApprovalFrame}
                  onAbortRun={(agent) => void handleAbort(agent)}
                  abortState={abortState}
                  onAppend={bumpContentVersion}
                  onHistoryLoaded={() => {
                    scrollWiringRef.current = { ...scrollWiringRef.current, initialAnchor: true };
                    bumpContentVersion();
                  }}
                />
              </div>
              {/* U3: the composer is anchored at the bottom of the full
                  workspace; messages flow/scroll above it. U2's composer-right
                  details action is preserved. */}
              <div className="composer-action-row">
                <ConversationComposer
                  mode="active"
                  conversationId={selection.conversation.id}
                  token={token}
                  agents={load.phase === "ready" ? load.agents : []}
                  initialFocus={justCreatedFocus}
                  onUnauthorized={onUnauthorized}
                  onAnnounce={setAnnouncement}
                  onSent={handleMessageSent}
                />
                <DetailsToggleButton buttonRef={detailsButtonRef} onClick={openDetails} />
              </div>
            </div>
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
              onHistoryLoaded={() => {
                scrollWiringRef.current = { ...scrollWiringRef.current, initialAnchor: true };
                bumpContentVersion();
              }}
            />
            {/* U2: read-only inspection has no composer, so the details action
                lives in a minimal inspection action row (Archive/Reopen stay
                reachable inside the modal). */}
            <div className="inspection-actions">
              <DetailsToggleButton buttonRef={detailsButtonRef} onClick={openDetails} />
            </div>
          </div>
        )}
        {detailsOpen && (
          <ConversationDetailsModal
            key={selection.conversation.id}
            conversation={selection.conversation}
            agents={load.phase === "ready" ? load.agents : []}
            lifecyclePhase={lifecycle.phase}
            lifecycleError={lifecycle.phase === "error" ? lifecycle.error : null}
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
            onLifecycleRetry={() => {
              if (lifecycle.phase === "error") void handleLifecycleAction(lifecycle.action);
            }}
            onRename={handleRenameRequest}
            onClose={closeDetails}
          />
        )}
      </section>
    );
  }

  return (
    <section
      className="conversation-surface"
      aria-label="New conversation"
      tabIndex={-1}
      ref={surfaceRef}
    >
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {notice !== null && <p className="route-notice" role="status">{notice}</p>}
      {/* P5+P6: the empty draft uses the SAME full-height chat layout, the SAME
          timeline component path (zero history: no fetch/stream/durable
          state), and the SAME docked composer as an active Conversation. The
          shared dock includes the details action DISABLED with a truthful
          title — no modal, no durable title/state until the first accepted
          send creates the record. */}
      <div className="conversation-workspace">
        <div className="conversation-scroll" ref={scrollRef} aria-label="Conversation history">
          <ConversationTimeline
            conversationId=""
            token={token}
            live={false}
            onUnauthorized={onUnauthorized}
            draft
          />
        </div>
        <div className="composer-action-row">
          <ConversationComposer
            mode="draft"
            token={token}
            agents={load.phase === "ready" ? load.agents : []}
            onUnauthorized={onUnauthorized}
            onAnnounce={setAnnouncement}
            onCreated={(conversation) => void handleCreated(conversation)}
          />
          <DetailsToggleButton
            buttonRef={detailsButtonRef}
            disabled
            title="Conversation details become available after the first message is sent"
          />
        </div>
      </div>
    </section>
  );
}

/**
 * U2: the details action — a familiar information icon button with the
 * accessible name "Conversation details". On the active surface it sits
 * composer-right; on read-only inspection it lives in the minimal inspection
 * action row (no composer exists there); on the browser-local draft dock it
 * is present but DISABLED with a truthful title (P6). The navigator keeps
 * its ref so dismissing the modal returns focus to the invoking button.
 */
export function DetailsToggleButton({
  buttonRef,
  onClick,
  disabled,
  title,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  onClick?: () => void;
  /** P6: the empty draft dock carries the details action disabled (truthful). */
  disabled?: boolean;
  /** P6: truthful accessible disabled reason (draft has no durable title yet). */
  title?: string;
}) {
  return (
    <button
      type="button"
      ref={buttonRef}
      className="conversation-details-toggle"
      aria-label="Conversation details"
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <InfoIcon size={18} />
    </button>
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
