import { useEffect, useState } from "react";
import { fetchConversationAgents, fetchConversations, startConversation, UnauthorizedError } from "./api";
import type { ConversationAgentEntry } from "./conversation-agents";
import { conversationAudienceSummary, type ConversationRecord } from "./conversations";

/**
 * ADR-0044 — the Dashboard: the default Workbench surface. Presentation over
 * existing authoritative reads ONLY: the local-policy roster from
 * GET /api/conversation-agents and the durable conversation list from
 * GET /api/conversations. The steward explicitly selects one runnable agent
 * and submits exactly one `{agent}` start request; a successful start opens
 * the new Conversation through the existing authoritative route/attach flow
 * (handled by the caller via the durable hash route).
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
  | { phase: "ready"; agents: ConversationAgentEntry[]; conversations: ConversationRecord[] };

type StartState = { phase: "idle" } | { phase: "busy" } | { phase: "error"; message: string };

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

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const [roster, list] = await Promise.all([
          fetchConversationAgents(token, controller.signal),
          fetchConversations(token, controller.signal),
        ]);
        if (cancelled) return;
        setLoad({ phase: "ready", agents: roster.agents, conversations: list.conversations });
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
  }, [token, onUnauthorized, onValidated, reloadKey, retryKey]);

  function handleRetry() {
    // An explicit fresh steward action only — never an automatic retry.
    setLoad({ phase: "loading" });
    setRetryKey((key) => key + 1);
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
          Loading your agents and conversations…
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
      <h2>Dashboard</h2>
      <section className="card" aria-labelledby="dashboard-agents-heading">
        <h3 id="dashboard-agents-heading">Start a conversation</h3>
        {load.agents.length === 0 ? (
          <p className="muted">No agents are defined in this vault.</p>
        ) : (
          <>
            <p className="muted">
              Choose one agent to start a new conversation. Online means runnable on this installation — local
              policy, never a live presence or provider probe.
            </p>
            <ul className="agent-roster">
              {load.agents.map((agent) => (
                <li key={agent.name} className={agent.online ? "agent-entry" : "agent-entry agent-offline"}>
                  <button
                    type="button"
                    data-agent={agent.name}
                    className={selectedAgent === agent.name ? "agent-select agent-selected" : "agent-select"}
                    aria-pressed={selectedAgent === agent.name}
                    disabled={!agent.online || start.phase === "busy"}
                    title={agent.online ? `Select ${agent.name}` : `${agent.name} is not runnable on this installation`}
                    onClick={() => handleSelect(agent)}
                  >
                    <span className="agent-label">
                      <span className="agent-name">{agent.name}</span>
                      {agent.online ? (
                        <span className="agent-status status-ok">Online</span>
                      ) : (
                        <span className="agent-status status-muted">Offline</span>
                      )}
                    </span>
                  </button>
                  {!agent.online && (
                    <p className="agent-offline-note">Not runnable on this installation — local policy, not a live probe.</p>
                  )}
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
                {start.phase === "busy" ? "Starting…" : "Start conversation"}
              </button>
            )}
            {start.phase === "error" && (
              <p className="error-message" role="alert">
                {start.message}
              </p>
            )}
          </>
        )}
      </section>
      <section className="card" aria-labelledby="dashboard-conversations-heading">
        <h3 id="dashboard-conversations-heading">Your conversations</h3>
        {load.conversations.length === 0 ? (
          <p className="muted">No conversations yet.</p>
        ) : (
          <ul className="dashboard-conversation-list">
            {load.conversations.map((conversation) => (
              <li key={conversation.id}>
                <button
                  type="button"
                  data-conversation={conversation.id}
                  className="dashboard-conversation-entry"
                  onClick={() => onOpenConversation(conversation.id)}
                >
                  <span>{conversation.title}</span>
                  <small>{conversationAudienceSummary(conversation.audience)}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
