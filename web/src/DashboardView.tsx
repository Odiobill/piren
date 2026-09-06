import { useEffect, useRef, useState } from "react";
import logoUrl from "./assets/piren-logo.png";
import { assignInboxTask, fetchConversationAgents, fetchServiceStatus, PeerStartAmbiguousError, startConversation, startPeerConversation, UnauthorizedError } from "./api";
import { AssignTaskModal } from "./AssignTaskModal";
import type { ConversationAgentEntry } from "./conversation-agents";
import { parseConfiguredModelLabel } from "./conversation-agents";
import {
  SERVICE_STATE_LABELS,
  SERVICE_TARGET_LABELS,
  serviceStatePillClass,
  serviceStateStatusClass,
  type ServiceStatusSnapshot,
} from "./service-observation";
import { ClipboardIcon, MessageIcon, RefreshIcon, RetryIcon } from "./icons";
import { agentDisplayName } from "./agent-display";

/**
 * ADR-0044 + D1 — the Dashboard: the default Workbench surface. Presentation
 * over existing authoritative reads ONLY: the local-policy roster from
 * GET /api/conversation-agents. WUX-A: ONE multi-selection model by default.
 * Agent cards are membership toggles; the single visible Start control routes
 * by cardinality: exactly one selected runnable agent submits the exact
 * existing `{agent}` start request, and 2-8 selected peers submit the exact
 * existing peer-audience start. A successful start opens the new Conversation
 * through the existing authoritative route/attach flow (handled by the caller
 * via the durable hash route). D1 removed the duplicate Dashboard Conversation
 * list: the sidebar is the sole Conversation navigator, so the Dashboard no
 * longer issues a conversation-list read.
 *
 * Truthfulness rules: "online" means locally runnable on this gateway
 * (local installation policy, never presence/provider health); start
 * controls are disabled while that exact request is busy; errors stay
 * visible and any retry is an explicit fresh steward action; there is no
 * storage, no polling, no recipient/text/title derivation, and no focus
 * theft during loading or errors.
 */

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; agents: ConversationAgentEntry[] };

type StartState = { phase: "idle" } | { phase: "busy" } | { phase: "error"; message: string };

/**
 * The three compact model-card lines: provider, visually emphasized model id,
 * and a visually secondary thinking level. Presentation over the existing
 * authenticated configured-model data only; a malformed value keeps the raw
 * string truthfully and is never interpreted or invented.
 */
function ConfiguredModelPresentation({ model }: { model: string }) {
  const parts = parseConfiguredModelLabel(model);
  if (parts === null) {
    return <span className="agent-model-raw">{model}</span>;
  }
  return (
    <span className="agent-model">
      <span className="agent-model-provider">{parts.provider}</span>
      <span className="agent-model-id">{parts.modelId}</span>
      {parts.thinking !== null && <span className="agent-model-thinking">{parts.thinking}</span>}
    </span>
  );
}

/**
 * D2.3 observation state. "loading" also clears any previous snapshot so a
 * failed refresh never shows stale target values.
 */
type ObservationState = { phase: "loading" } | { phase: "ready"; snapshot: ServiceStatusSnapshot } | { phase: "error" };

export function DashboardView({
  token,
  onUnauthorized,
  onValidated,
  onOpenConversation,
  reloadKey,
  onRefreshConversations,
}: {
  token: string;
  onUnauthorized: () => void;
  onValidated: () => void;
  /** Open one conversation through the existing authoritative route/attach flow. */
  onOpenConversation: (id: string) => void;
  /** Bumped by the shell when conversations change (start/rename/lifecycle). */
  reloadKey: number;
  /**
   * P3.3: the narrow shell callback for the peer-start ambiguous-failure
   * recovery — an explicit durable-list refresh only. Never an automatic
   * retry, resubmission, or background read.
   */
  onRefreshConversations?: () => void;
}) {
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [retryKey, setRetryKey] = useState(0);
  // WUX-A: ONE selection model. Agent cards are always membership toggles;
  // cardinality routes the visible Start control (exactly one -> the existing
  // single-agent start path, 2-8 -> the existing peer-start path).
  const [selection, setSelection] = useState<string[]>([]);
  const [start, setStart] = useState<StartState>({ phase: "idle" });
  // Peer-audience start state: component-local only, never persisted.
  const [peerStart, setPeerStart] = useState<
    | { phase: "idle" }
    | { phase: "busy" }
    | { phase: "error"; message: string }
    | { phase: "ambiguous" }
  >({ phase: "idle" });
  // T1 — Assign-task affordance state. Browser-only modal draft + a bounded
  // truthful creation notice; no storage, no polling, no retry.
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [assignNotice, setAssignNotice] = useState<string | null>(null);
  // Focus return target for the assign-task modal (U2 dialog pattern).
  const assignButtonRef = useRef<HTMLButtonElement>(null);
  const [observation, setObservation] = useState<ObservationState>({ phase: "loading" });
  const [observationRetryKey, setObservationRetryKey] = useState(0);
  // This changes only after a successful roster read. It gates the separate
  // observation effect so every Dashboard reload proves Gateway Connected
  // before requesting a fresh manager sample.
  const [rosterReadyKey, setRosterReadyKey] = useState(0);
  // Callback identity is not Dashboard-load authority. Keep the latest shell
  // handlers without turning an ordinary parent render into a fresh read.
  const onUnauthorizedRef = useRef(onUnauthorized);
  const onValidatedRef = useRef(onValidated);
  onUnauthorizedRef.current = onUnauthorized;
  onValidatedRef.current = onValidated;

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    // Invalidate any prior roster authority and abort its observation effect
    // before this fresh roster read settles.
    setRosterReadyKey(0);
    setObservation({ phase: "loading" });
    (async () => {
      try {
        // The roster read is also this surface's authenticated gateway check:
        // a successful response is the only "gateway connected" evidence.
        const roster = await fetchConversationAgents(token, controller.signal);
        if (cancelled) return;
        setLoad({ phase: "ready", agents: roster.agents });
        setRosterReadyKey((key) => key + 1);
        onValidatedRef.current();
      } catch (error) {
        if (cancelled) return;
        if (error instanceof UnauthorizedError) {
          onUnauthorizedRef.current();
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
  }, [token, reloadKey, retryKey]);

  function handleRetry() {
    // An explicit fresh steward action only — never an automatic retry.
    setLoad({ phase: "loading" });
    setRetryKey((key) => key + 1);
  }

  // D2.3: one fresh observation read, only after the roster read succeeded
  // (that success remains the sole "Gateway connection — Connected" fact).
  // One Dashboard load takes one snapshot; every retry is explicit and manual.
  useEffect(() => {
    if (load.phase !== "ready" || rosterReadyKey === 0) return;
    let cancelled = false;
    const controller = new AbortController();
    // Clear any previous snapshot up front: a failed refresh must never
    // leave stale target values on screen.
    setObservation({ phase: "loading" });
    (async () => {
      try {
        const snapshot = await fetchServiceStatus(token, controller.signal);
        if (cancelled) return;
        setObservation({ phase: "ready", snapshot });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof UnauthorizedError) {
          onUnauthorizedRef.current();
          return;
        }
        if (error instanceof DOMException && error.name === "AbortError") return;
        setObservation({ phase: "error" });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [token, load.phase, rosterReadyKey, observationRetryKey]);

  function handleObservationRetry() {
    // Explicit manual retry: a fresh observation read ONLY — the roster (the
    // Gateway connection fact) is never re-fetched by this action.
    setObservationRetryKey((key) => key + 1);
  }

  function handleSelect(agent: ConversationAgentEntry) {
    if (!agent.online || start.phase === "busy" || peerStart.phase === "busy") return;
    // Cards are membership toggles (aria-pressed) in the one default model.
    setSelection((previous) =>
      previous.includes(agent.name) ? previous.filter((name) => name !== agent.name) : [...previous, agent.name],
    );
    setStart({ phase: "idle" });
    setPeerStart({ phase: "idle" });
    // A selection change invalidates any stale creation notice.
    setAssignNotice(null);
  }

  /**
   * P3.3 — one explicit authenticated peer start for 2-8 distinct selected
   * locally-runnable agents. Success reports creation evidence only (the
   * durable hash-route open does the rest); a definitive 4xx keeps its
   * bounded message with explicit fresh retry; an ambiguous network/result
   * failure makes no retry or success claim and offers only an explicit
   * durable-list refresh.
   */
  async function handlePeerStart() {
    if (selection.length < 2 || selection.length > 8 || peerStart.phase === "busy") return;
    const peers = [...selection].sort();
    setPeerStart({ phase: "busy" });
    try {
      const result = await startPeerConversation(peers, token);
      setPeerStart({ phase: "idle" });
      setSelection([]);
      onOpenConversation(result.conversation.id);
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      if (error instanceof PeerStartAmbiguousError) {
        setPeerStart({ phase: "ambiguous" });
        return;
      }
      setPeerStart({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  function handlePeerRefresh() {
    // Explicit refresh-only recovery: clear the ambiguous state and refresh
    // the durable sidebar list through the narrow shell callback. No resubmit.
    setPeerStart({ phase: "idle" });
    onRefreshConversations?.();
  }

  /**
   * T1 — one explicit authenticated inbox-create submission for the
   * exactly-one selected agent. Throws a bounded message on failure; on
   * success reports ONLY that a task was created — never contact,
   * notification, wakeup, or execution.
   */
  async function handleAssign(title: string, details: string): Promise<void> {
    // Exact-one gating: the modal only opens with exactly one selected agent.
    if (selection.length !== 1) throw new Error("Exactly one agent must be selected.");
    const agent = selection[0] ?? "";
    try {
      await assignInboxTask(agent, title, details, token);
    } catch (cause) {
      // A 401 follows the Dashboard's established auth handling: surface it
      // to the shell's recovery callback; the modal still shows its bounded
      // state (never an automatic retry).
      if (cause instanceof UnauthorizedError) onUnauthorizedRef.current();
      throw cause;
    }
    setAssignModalOpen(false);
    setAssignNotice(`A task was created for ${agentDisplayName(agent)}.`);
  }

  async function handleStart() {
    if (selection.length !== 1 || start.phase === "busy") return;
    const agent = selection[0];
    if (agent === undefined) return;
    setStart({ phase: "busy" });
    try {
      // Exactly one {agent} start request; the response is never used to
      // claim a run outcome — the caller re-reads/re-gates through the
      // existing authoritative route/attach flow.
      const result = await startConversation(token, agent);
      setStart({ phase: "idle" });
      setSelection([]);
      onOpenConversation(result.conversation.id);
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setStart({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (load.phase === "loading") {
    return (
      <section className="card" aria-live="polite" aria-label="Dashboard">
        <h2>Dashboard</h2>
        <p className="muted" role="status">
          Loading your agents…
        </p>
      </section>
    );
  }

  if (load.phase === "error") {
    return (
      <section className="card card-error" aria-label="Dashboard">
        <h2>Dashboard</h2>
        <p className="error-message" role="alert">
          Could not load the dashboard: <code>{load.message}</code>
        </p>
        <button type="button" className="button button-primary" onClick={handleRetry}>
          <RetryIcon size={14} />
          Retry
        </button>
      </section>
    );
  }

  const onlineAgents = load.agents.filter((agent) => agent.online);
  // Exact-one Assign-task target (noUncheckedIndexedAccess-safe narrowing).
  const assignTarget = selection.length === 1 ? (selection[0] ?? null) : null;

  return (
    <section className="dashboard" aria-label="Dashboard">
      <header className="dashboard-welcome wb-page-header">
        {/* D1: the transparent Piren mark only — no white-background wordmark
            on a dark surface; the mark ships as a self-contained transparent PNG. */}
        <img src={logoUrl} alt="" className="dashboard-mark" width={72} height={72} />
        <div className="dashboard-welcome-text wb-page-heading">
          <h2>Dashboard</h2>
          <p className="muted wb-page-lede">
            Start a Conversation with one agent or several peers, or assign a task to exactly one agent.
            Your conversations always live in the sidebar.
          </p>
        </div>
      </header>
      <section className="card wb-surface" aria-labelledby="dashboard-agents-heading">
        <h3 id="dashboard-agents-heading">Start a conversation</h3>
        {load.agents.length === 0 ? (
          <p className="muted">No agents are defined in this vault.</p>
        ) : (
          <>
            <ul className="agent-card-grid">
              {load.agents.map((agent) => (
                <li key={agent.name} className={agent.online ? "agent-card" : "agent-card agent-offline"}>
                  <button
                    type="button"
                    data-agent={agent.name}
                    className={
                      selection.includes(agent.name) ? "agent-select agent-selected" : "agent-select"
                    }
                    aria-pressed={selection.includes(agent.name)}
                    disabled={!agent.online || start.phase === "busy" || peerStart.phase === "busy"}
                    title={agent.online ? `Select ${agentDisplayName(agent.name)}` : `${agentDisplayName(agent.name)} is not runnable on this installation`}
                    onClick={() => handleSelect(agent)}
                  >
                    {/* D1 bounded presentation slots: avatar/accent now, a
                        future accepted vault-backed presentation design may
                        fill them; this slice adds no schema or persistence. */}
                    <span className="agent-card-avatar" aria-hidden="true">
                      {agent.name.charAt(0).toUpperCase()}
                    </span>
                    <span className="agent-card-body">
                      <span className="agent-card-title-row">
                        <span className="agent-name">{agentDisplayName(agent.name)}</span>
                        {agent.online ? (
                          <span className="agent-status status-ok wb-pill wb-pill-ok">Online</span>
                        ) : (
                          <span className="agent-status status-muted wb-pill wb-pill-muted">Offline</span>
                        )}
                      </span>
                      <span className="agent-card-description">
                        {/* Three compact lines with no "Configured model:"
                            prefix: provider; visually emphasized model id;
                            visually secondary thinking level. Existing
                            authenticated configuration-derived presentation,
                            never a live provider/model claim. Absent
                            (malformed or missing configuration) stays
                            truthfully unavailable; a malformed value keeps
                            the raw string. */}
                        {agent.model !== undefined ? <ConfiguredModelPresentation model={agent.model} /> : "Configured model unavailable"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {onlineAgents.length > 0 && (
              <div className="dashboard-actions">
                {/* WUX-A: one visible Start control routes by cardinality:
                    exactly one -> the single-agent start path; 2-8 -> the
                    existing peer-start path. */}
                <button
                  type="button"
                  className="button button-primary dashboard-start"
                  disabled={
                    selection.length === 0 ||
                    selection.length > 8 ||
                    start.phase === "busy" ||
                    peerStart.phase === "busy" ||
                    peerStart.phase === "ambiguous"
                  }
                  onClick={() => void (selection.length === 1 ? handleStart() : handlePeerStart())}
                >
                  <MessageIcon size={16} />
                  <span>Start conversation</span>
                </button>
                {/* T1 — enabled only with the exactly-one selected runnable
                    agent; visible but otherwise disabled (never broadened to
                    multi-agent). */}
                <button
                  type="button"
                  ref={assignButtonRef}
                  className="button dashboard-assign"
                  disabled={selection.length !== 1 || start.phase === "busy"}
                  onClick={() => {
                    setAssignNotice(null);
                    setAssignModalOpen(true);
                  }}
                >
                  <ClipboardIcon size={14} />
                  Assign task
                </button>
              </div>
            )}
            {peerStart.phase === "busy" && (
              <p className="dashboard-start-busy" role="status">
                Creating your peer conversation…
              </p>
            )}
            {peerStart.phase === "error" && (
              <p className="error-message" role="alert">
                {peerStart.message}
              </p>
            )}
            {peerStart.phase === "ambiguous" && (
              <div className="error-message" role="alert">
                <p>The peer conversation may or may not have been created. Check your conversations list.</p>
                <button type="button" className="button button-small dashboard-peer-refresh" onClick={handlePeerRefresh}>
                  <RefreshIcon size={12} />
                  Refresh conversations list
                </button>
              </div>
            )}
            {assignNotice !== null && (
              <p className="dashboard-assign-notice" role="status">
                {assignNotice}
              </p>
            )}
            {start.phase === "busy" && selection.length === 1 && (
              <p className="dashboard-start-busy" role="status">
                Preparing your conversation with {agentDisplayName(selection[0] ?? "")}. Please wait
                <span className="dashboard-busy-dots" aria-hidden="true">
                  <span>.</span>
                  <span>.</span>
                  <span>.</span>
                </span>
              </p>
            )}
            {start.phase === "error" && (
              <p className="error-message" role="alert">
                {start.message}
              </p>
            )}
          </>
        )}
      </section>
      <section className="card dashboard-services wb-surface" aria-labelledby="dashboard-services-heading">
        <h3 id="dashboard-services-heading">Services</h3>
        {/* WUX-A: ONE concise service list. Gateway Connected is the
            authenticated Dashboard-load fact; the three targets keep their
            truthful gateway-observed states. Manager/probe/timestamp
            implementation details are not rendered. */}
        <ul className="dashboard-service-list">
          <li>
            <span className="dashboard-service-name">Gateway</span>
            <span className="agent-status status-ok wb-pill wb-pill-ok">Connected</span>
          </li>
          {observation.phase === "loading" &&
            (['telegram', 'discord', 'scheduler'] as const).map((target) => (
              <li key={target}>
                <span className="dashboard-service-name">{SERVICE_TARGET_LABELS[target]}</span>
                <span className="agent-status status-muted wb-pill wb-pill-muted">Checking…</span>
              </li>
            ))}
          {observation.phase === "ready" &&
            observation.snapshot.targets.map((entry) => (
              <li key={entry.target}>
                <span className="dashboard-service-name">{SERVICE_TARGET_LABELS[entry.target]}</span>
                <span className={`agent-status ${serviceStateStatusClass(entry.state)} ${serviceStatePillClass(entry.state)}`}>
                  {SERVICE_STATE_LABELS[entry.state]}
                </span>
              </li>
            ))}
        </ul>
        {observation.phase === "error" && (
          <>
            <p className="error-message" role="alert">
              Service status unavailable.
            </p>
            <button type="button" className="button" onClick={handleObservationRetry}>
              <RetryIcon size={14} />
              Retry service status
            </button>
          </>
        )}
      </section>
      {assignModalOpen && assignTarget !== null && (
        <AssignTaskModal
          agent={assignTarget}
          onAssign={handleAssign}
          onClose={() => {
            setAssignModalOpen(false);
            assignButtonRef.current?.focus();
          }}
        />
      )}
    </section>
  );
}
