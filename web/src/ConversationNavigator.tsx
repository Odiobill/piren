import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  abortConversationRun,
  approveConversationApproval,
  archiveConversation,
  attachConversation,
  ConversationControlHttpError,
  fetchConversation,
  fetchConversationAgents,
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
import { parseHashRoute, routeToIntent } from "./hash-route";
import { renameAnnouncement, type RenameError } from "./conversation-details";
import { InfoIcon, StopIcon } from "./icons";
import type { ConversationAgentEntry } from "./conversation-agents";
import { ConversationDetailsModal, ConversationLifecycleControls } from "./ConversationDetailsModal";
import { ConversationTimeline } from "./ConversationTimeline";
import { ConversationComposer } from "./ConversationComposer";
import {
  applyConversationScrollWiring,
  conversationScrollTarget,
  EMPTY_CONVERSATION_SCROLL_WIRING,
  shouldApplyConversationScroll,
  type ConversationScrollWiringState,
} from "./conversation-scroll-wiring";
import {
  approvalSelectionForIndex,
  nextApprovalSelection,
} from "./conversation-approval-pager";
import {
  conversationActivityRunStateLabel,
  type ConversationCompactActivityRun,
} from "./conversation-activity";

/**
 * Conversation navigator (C3-A + C4-A + L3): the Conversation Workbench
 * surface over the accepted C2 API family. Selects one conversation through
 * the C1/runnable-roster-gated attach route: a successful attach opens the
 * ACTIVE surface (immutable whole-history reread + scoped live SSE +
 * raw-text composer); a rejected attach opens the visibly READ-ONLY
 * inspection surface (history only, no composer, no live stream). New
 * Conversations start only from the Dashboard's explicit agent-first start
 * (ADR-0044); the composer appends raw-text follow-up messages.
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
 * hashes and nonexistent conversations fail truthfully to the no-selection
 * surface with a bounded message and never dispatch, mutate, or fabricate
 * client state.
 *
 * ADR-0044: the browser-local empty/new-Conversation draft entry surface is
 * REMOVED. Conversation creation happens only through the Dashboard's
 * explicit agent-first start; the home route shows a truthful no-selection
 * placeholder with no composer and no creation control.
 *
 * The browser never scans, resolves, or derives dispatch recipients from
 * `@text` — the gateway alone parses mentions. No approval or abort
 * controls, vault/graph navigation, configuration controls, storage, or
 * service worker.
 */

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; agents: ConversationAgentEntry[] };

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
   * (active or read-only), or null when no conversation is selected.
   */
  onSelectionChange?: (title: string | null, active: boolean) => void;
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
  /** P8 (§5): commit-time anchor wiring — pre-commit metrics ref + one-shot
      initial-anchor flag, driven by the content-version layout effect. */
  const scrollWiringRef = useRef<ConversationScrollWiringState>(EMPTY_CONVERSATION_SCROLL_WIRING);
  /** P8 (§5): bumped by every durable/activity/summary append and the initial
      history load; the layout effect applies the anchor decision per commit. */
  const [contentVersion, setContentVersion] = useState(0);
  const bumpContentVersion = useCallback(() => setContentVersion((version) => version + 1), []);
  /**
   * R2 — compact source-truthful live run state for the stable bottom dock:
   * reported by the subscribed timeline (agent + working/typing only, never
   * partial work content); cleared on every fail-closed cleanup path and on
   * every fresh open flow. Dock-height changes participate in the existing
   * content-version anchor wiring so an anchored reader stays at the newest
   * content immediately above the dock (R1 contract §6).
   */
  const [dockRuns, setDockRuns] = useState<ConversationCompactActivityRun[]>([]);
  const handleActivityChange = useCallback((runs: ConversationCompactActivityRun[]) => setDockRuns(runs), []);
  useEffect(() => {
    bumpContentVersion();
  }, [dockRuns]);

  /**
   * R1 — apply the commit-time bottom-anchor decision to the BROWSER ROOT
   * document (the sole Conversation scroll host) in a layout effect that runs
   * AFTER React commits appended content (durable items, permitted activity,
   * retained summaries). The pure core decides with the PRE-commit metrics
   * ref: anchored reader follows to the new bottom (auto behavior); an upward
   * reader keeps the exact position; batch appends in one commit produce one
   * decision; reduced-motion stays auto. The initial whole-history load
   * forces the bottom. Focus restoration uses preventScroll and the composer
   * dock is sticky outside the reading region, so it never breaks anchoring.
   */
  const surfaceKey =
    selection.phase === "active"
      ? selection.conversation.id
      : selection.phase === "read-only"
        ? selection.conversation.id
        : "none";

  useEffect(() => {
    scrollWiringRef.current = EMPTY_CONVERSATION_SCROLL_WIRING;
  }, [surfaceKey]);

  useLayoutEffect(() => {
    // The persistent Conversation surface may be hidden while the steward is
    // using the Dashboard. A live append must not root-scroll that other page.
    if (!shouldApplyConversationScroll(surfaceRef.current)) return;
    // ADR-0044 Tracer B: the anchor target is the ACTUAL history scroll host
    // (the active Conversation's named history region); surfaces without one
    // (read-only/no-selection) keep the R1 document-root behavior.
    const el = conversationScrollTarget(surfaceRef.current, document);
    if (!el) return;
    scrollWiringRef.current = applyConversationScrollWiring(el, scrollWiringRef.current);
  }, [contentVersion, surfaceKey]);

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
    // R2: the compact dock live state is session-scoped and never survives a
    // fresh open flow (the timeline also clears it on reread/selection).
    setDockRuns([]);
  }

  /** Invalidate any in-flight open flow (navigation home/back/invalid). */
  function cancelPendingOpen() {
    openSeqRef.current += 1;
  }

  const loadData = useCallback(
    async (signal: AbortSignal) => {
      const response = await fetchConversationAgents(token, signal);
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
      // P2: the subtitle follows the re-gated gateway-authoritative title;
      // Tracer B: the shell also learns whether the selection is ACTIVE so it
      // can clip the viewport for the history-host layout (read-only keeps
      // the R1 document flow).
      onSelectionChange?.(selection.conversation.title, selection.phase === "active");
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
   * unavailable conversation fails truthfully to the no-selection surface —
   * never a dispatch, mutation, or fabricated client state.
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
        // P2: no selection keeps the calm generic shell subtitle.
        onSelectionChange?.(null, false);
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
        // P2: no selection keeps the calm generic shell subtitle.
        onSelectionChange?.(null, false);
        return;
      }
      if (intent.kind === "invalid-route") {
        // Malformed/unknown hash: fail truthfully to the no-selection surface, no request.
        cancelPendingOpen();
        resetLifecycleControls();
        setSelection({ phase: "none" });
        setNotice("Unknown route — no conversation selected.");
        setAnnouncement("");
        onSelectionChange?.(null, false);
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
            {/* ADR-0044 Tracer B — the active Conversation viewport: the
                named .conversation-history region is the SOLE Conversation
                scroll host (the durable timeline lives inside it); the
                bottom .interaction-tray is a natural flex child OUTSIDE it,
                carrying the exact approval cards, the compact broker-
                authoritative live-run/abort state, and the composer/details
                controls. The tray never scrolls and never clips required
                actions; its content reduces the history region. */}
            <div className="conversation-workspace">
              <div
                className="conversation-history"
                role="region"
                aria-label="Conversation history"
                tabIndex={0}
              >
                <ConversationTimeline
                  conversationId={selection.conversation.id}
                  token={token}
                  live={true}
                  onUnauthorized={onUnauthorized}
                  onLifecycleTransition={handleLifecycleEvent}
                  onApproval={handleApprovalFrame}
                  onActivityChange={handleActivityChange}
                  onAppend={bumpContentVersion}
                  onHistoryLoaded={() => {
                    scrollWiringRef.current = { ...scrollWiringRef.current, initialAnchor: true };
                    bumpContentVersion();
                  }}
                />
              </div>
              <div className="interaction-tray">
                <ConversationApprovalCards
                  approvals={pendingApprovals}
                  submit={approvalSubmit}
                  onRespond={(approval, response) => void handleApprovalResponse(approval, response)}
                />
                {/* U3/R2: the composer is the bottom of the tray. U2's
                    composer-right details action is preserved. R2 — compact
                    source-truthful live run state (agent + working/typing +
                    scoped abort) renders in the dock, never as a transcript
                    panel; partial work content is gone. */}
                <div className="composer-action-row">
                  {dockRuns.length > 0 && (
                    <div className="dock-run-status" aria-label="Live agent runs" aria-live="polite">
                      {dockRuns.map((run) => {
                        const aborting = abortState?.phase === "busy" && abortState.agent === run.agent;
                        const failed = abortState?.phase === "error" && abortState.agent === run.agent;
                        return (
                          <div key={run.runId} className={`dock-run dock-run-${run.phase}`}>
                            <span className="dock-run-agent">{run.agent}</span>
                            <span className="dock-run-state">{conversationActivityRunStateLabel(run.phase)}</span>
                            <button
                              type="button"
                              className="transient-run-abort"
                              aria-label={`Abort ${run.agent} run`}
                              title={`Abort ${run.agent} run`}
                              disabled={aborting}
                              onClick={() => void handleAbort(run.agent)}
                            >
                              <StopIcon size={14} />
                            </button>
                            {failed && (
                              <p className="transient-run-error" role="alert">
                                {abortState?.phase === "error" ? abortState.error.message : ""}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <ConversationComposer
                    conversationId={selection.conversation.id}
                    token={token}
                    agents={load.phase === "ready" ? load.agents : []}
                    onUnauthorized={onUnauthorized}
                    onAnnounce={setAnnouncement}
                    onSent={handleMessageSent}
                  />
                  <DetailsToggleButton buttonRef={detailsButtonRef} onClick={openDetails} />
                </div>
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
      aria-label="Conversations"
      tabIndex={-1}
      ref={surfaceRef}
    >
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {notice !== null && <p className="route-notice" role="status">{notice}</p>}
      {/* ADR-0044: no browser-local draft entry surface remains. The home
          route shows a truthful no-selection placeholder; new Conversations
          start only from the Dashboard's explicit agent-first start. */}
      <div className="conversation-workspace">
        <section className="card">
          <h2>No conversation selected</h2>
          <p className="muted">
            Select a conversation from the sidebar, or start a new one from the Dashboard.
          </p>
        </section>
      </div>
    </section>
  );
}

/**
 * U2: the details action — a familiar information icon button with the
 * accessible name "Conversation details". On the active surface it sits
 * composer-right; on read-only inspection it lives in the minimal inspection
 * action row (no composer exists there). The navigator keeps its ref so
 * dismissing the modal returns focus to the invoking button.
 */
export function DetailsToggleButton({
  buttonRef,
  onClick,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      ref={buttonRef}
      className="conversation-details-toggle"
      aria-label="Conversation details"
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
 * Retry; the polite announcement is made by the navigator.
 *
 * ADR-0044 Tracer B correction — bounded accessible pager: with more than
 * one pending approval the tray renders EXACTLY ONE selected card plus an
 * ordinal Previous/Next navigator (no hidden off-page cards). A new arrival
 * becomes selected with the existing focus-on-arrival; manual navigation
 * keeps focus on the invoked pager button; an answered card is replaced by
 * the deterministic clamped remaining card. All pending approvals remain in
 * the in-memory list — nothing is dropped, persisted, auto-responded, or
 * reordered.
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
  // Derived-from-props selection (documented during-render adjustment
  // pattern): recomputed only when the approvals list reference changes, so
  // the committed render always carries the final selection and the selected
  // card mounts exactly once with the correct focus intent.
  const [tracked, setTracked] = useState<readonly PendingApproval[]>([]);
  const [selection, setSelection] = useState<{ selectedId: string; focusCard: boolean } | null>(null);
  if (approvals !== tracked) {
    setTracked(approvals);
    const decision = nextApprovalSelection({
      approvals,
      previousIds: tracked.map((approval) => approval.requestId),
      selectedId: selection?.selectedId ?? null,
    });
    setSelection(decision);
  }

  if (approvals.length === 0) return null;
  const selectedIndex = approvals.findIndex((approval) => approval.requestId === selection?.selectedId);
  const effectiveIndex = selectedIndex === -1 ? 0 : selectedIndex;
  const selected = approvals[effectiveIndex];
  if (selected === undefined) return null;

  // Manual pager navigation: select the already-pending indexed card WITHOUT
  // card auto-focus, so focus stays on the invoked pager button.
  function goTo(index: number): void {
    const decision = approvalSelectionForIndex(approvals, index);
    if (decision === null) return;
    setSelection(decision);
  }

  return (
    <div className="approval-cards" aria-label="Pending approvals">
      {approvals.length > 1 && (
        <div className="approval-pager" role="group" aria-label="Pending approval navigator">
          <button
            type="button"
            className="approval-pager-button"
            aria-label="Previous approval"
            disabled={effectiveIndex === 0}
            onClick={() => goTo(effectiveIndex - 1)}
          >
            ‹
          </button>
          <span className="approval-pager-status">
            Approval {effectiveIndex + 1} of {approvals.length}
          </span>
          <button
            type="button"
            className="approval-pager-button"
            aria-label="Next approval"
            disabled={effectiveIndex >= approvals.length - 1}
            onClick={() => goTo(effectiveIndex + 1)}
          >
            ›
          </button>
        </div>
      )}
      <ApprovalCard
        key={selected.requestId}
        approval={selected}
        autoFocus={selection?.focusCard ?? true}
        submitting={submit.phase === "busy" && submit.requestId === selected.requestId}
        failure={
          submit.phase === "error" && submit.requestId === selected.requestId
            ? { attempted: submit.attempted, error: submit.error }
            : null
        }
        onRespond={onRespond}
      />
    </div>
  );
}

function ApprovalCard({
  approval,
  submitting,
  failure,
  onRespond,
  autoFocus,
}: {
  approval: PendingApproval;
  submitting: boolean;
  /** Bounded failure carrying the exact attempted response for manual Retry. */
  failure: { attempted: ApprovalResponse; error: ConversationControlError } | null;
  onRespond: (approval: PendingApproval, response: ApprovalResponse) => void;
  /**
   * Tracer B correction: the pager gates the mount-time focus intent. True
   * only for a fresh arrival or the deterministic post-answer replacement;
   * false after manual pager navigation so the pager button keeps focus.
   */
  autoFocus: boolean;
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
  // Gated by the pager's autoFocus intent (suppressed after manual
  // navigation so the invoked pager button keeps focus).
  useEffect(() => {
    if (!autoFocus) return;
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
