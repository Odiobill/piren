import { useEffect, useRef, useState } from "react";
import logoUrl from "./assets/piren-logo.png";
import { fetchConversationAgents, fetchServiceStatus, startConversation, UnauthorizedError } from "./api";
import type { ConversationAgentEntry } from "./conversation-agents";
import {
  SERVICE_MANAGER_LABELS,
  SERVICE_STATE_LABELS,
  SERVICE_TARGET_LABELS,
  serviceStateStatusClass,
  type ServiceStatusSnapshot,
} from "./service-observation";
import { MessageIcon } from "./icons";

/**
 * ADR-0044 + D1 — the Dashboard: the default Workbench surface. Presentation
 * over existing authoritative reads ONLY: the local-policy roster from
 * GET /api/conversation-agents. The steward explicitly selects one runnable
 * agent and submits exactly one `{agent}` start request; a successful start
 * opens the new Conversation through the existing authoritative route/attach
 * flow (handled by the caller via the durable hash route). D1 removed the
 * duplicate Dashboard Conversation list: the sidebar is the sole Conversation
 * navigator, so the Dashboard no longer issues a conversation-list read.
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
}: {
  token: string;
  onUnauthorized: () => void;
  onValidated: () => void;
  /** Open one conversation through the existing authoritative route/attach flow. */
  onOpenConversation: (id: string) => void;
  /** Bumped by the shell when conversations change (start/rename/lifecycle). */
  reloadKey: number;
}) {
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [retryKey, setRetryKey] = useState(0);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [start, setStart] = useState<StartState>({ phase: "idle" });
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
    if (!agent.online || start.phase === "busy") return;
    setSelectedAgent((previous) => (previous === agent.name ? previous : agent.name));
    setStart({ phase: "idle" });
  }

  async function handleStart() {
    if (selectedAgent === null || start.phase === "busy") return;
    const agent = selectedAgent;
    setStart({ phase: "busy" });
    try {
      // Exactly one {agent} start request; the response is never used to
      // claim a run outcome — the caller re-reads/re-gates through the
      // existing authoritative route/attach flow.
      const result = await startConversation(token, agent);
      setStart({ phase: "idle" });
      setSelectedAgent(null);
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
          Retry
        </button>
      </section>
    );
  }

  const onlineAgents = load.agents.filter((agent) => agent.online);

  return (
    <section className="dashboard" aria-label="Dashboard">
      <header className="dashboard-welcome">
        {/* D1: the transparent Piren mark only — no white-background wordmark
            on a dark surface; the mark ships as a self-contained transparent PNG. */}
        <img src={logoUrl} alt="" className="dashboard-mark" width={72} height={72} />
        <div className="dashboard-welcome-text">
          <h2>Dashboard</h2>
          <p className="muted">
            Welcome to your Piren Workbench. Choose one local agent below to start a conversation — your
            conversations always live in the sidebar.
          </p>
        </div>
      </header>
      <section className="card" aria-labelledby="dashboard-agents-heading">
        <h3 id="dashboard-agents-heading">Start a conversation</h3>
        {load.agents.length === 0 ? (
          <p className="muted">No agents are defined in this vault.</p>
        ) : (
          <>
            <p className="muted">
              Online means runnable on this installation — local policy, never a live presence or provider probe.
            </p>
            <ul className="agent-card-grid">
              {load.agents.map((agent) => (
                <li key={agent.name} className={agent.online ? "agent-card" : "agent-card agent-offline"}>
                  <button
                    type="button"
                    data-agent={agent.name}
                    className={selectedAgent === agent.name ? "agent-select agent-selected" : "agent-select"}
                    aria-pressed={selectedAgent === agent.name}
                    disabled={!agent.online || start.phase === "busy"}
                    title={agent.online ? `Select ${agent.name}` : `${agent.name} is not runnable on this installation`}
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
                        <span className="agent-name">{agent.name}</span>
                        {agent.online ? (
                          <span className="agent-status status-ok">Online</span>
                        ) : (
                          <span className="agent-status status-muted">Offline</span>
                        )}
                      </span>
                      <span className="agent-card-description">
                        {/* D5: the gateway-projected configured model replaces the
                            redundant runnable/not-runnable copy; the label names it
                            as the declared startup configuration, never live
                            Pi/provider/session state. Absent (malformed or missing
                            configuration) is truthfully unavailable — never an
                            invented or inferred value. */}
                        {agent.model !== undefined ? `Configured model: ${agent.model}` : "Configured model unavailable"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {onlineAgents.length > 0 && (
              <button
                type="button"
                className="button button-primary dashboard-start"
                disabled={selectedAgent === null || start.phase === "busy"}
                onClick={() => void handleStart()}
              >
                <MessageIcon size={16} />
                <span>Start conversation</span>
              </button>
            )}
            {start.phase === "busy" && selectedAgent !== null && (
              <p className="dashboard-start-busy" role="status">
                Preparing your conversation with {selectedAgent}. Please wait
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
      <section className="card dashboard-services" aria-labelledby="dashboard-services-heading">
        <h3 id="dashboard-services-heading">Service information</h3>
        <ul className="dashboard-service-list">
          <li>
            <span className="dashboard-service-name">Gateway</span>
            <span className="agent-status status-ok">Connected</span>
          </li>
        </ul>
        <p className="muted">
          Connected means this Dashboard's authenticated read just succeeded. It is a separate fact from the
          gateway-sampled service observation below.
        </p>
        <div className="dashboard-service-observation" aria-labelledby="dashboard-service-observation-heading">
          <h4 id="dashboard-service-observation-heading">Managed service observation</h4>
          {observation.phase === "loading" && (
            <p className="muted" role="status">
              Sampling local service status…
            </p>
          )}
          {observation.phase === "error" && (
            <>
              <p className="error-message" role="alert">
                Service observation unavailable.
              </p>
              <button type="button" className="button" onClick={handleObservationRetry}>
                Retry service observation
              </button>
            </>
          )}
          {observation.phase === "ready" && (
            <>
              <p className="muted">
                Sampled by this gateway through {SERVICE_MANAGER_LABELS[observation.snapshot.manager]} at{" "}
                <time dateTime={observation.snapshot.observedAt}>{observation.snapshot.observedAt}</time>.
              </p>
              <ul className="dashboard-service-list dashboard-service-observation-list">
                {observation.snapshot.targets.map((entry) => (
                  <li key={entry.target}>
                    <span className="dashboard-service-name">{SERVICE_TARGET_LABELS[entry.target]}</span>
                    <span className={`agent-status ${serviceStateStatusClass(entry.state)}`}>
                      {SERVICE_STATE_LABELS[entry.state]}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </section>
    </section>
  );
}
