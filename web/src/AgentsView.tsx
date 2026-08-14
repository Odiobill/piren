import { useEffect, useState } from "react";
import { fetchConversationAgents, UnauthorizedError } from "./api";
import type { ConversationAgentEntry } from "./conversation-agents";

/**
 * Read-only agent roster page (ADR-0041 R3b-2.5). Shows the local-policy
 * roster from GET /api/conversation-agents: online means runnable on this
 * installation (never a live probe); offline agents are labelled and
 * explained. Direct chat is NOT implemented here — the entries are
 * non-interactive, and this page never calls the chat API surface,
 * switches agents, or starts any chat.
 */
export function AgentsView({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "error"; message: string }
    | { phase: "ready"; agents: ConversationAgentEntry[] }
  >({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const roster = await fetchConversationAgents(token, controller.signal);
        if (cancelled) return;
        setState({ phase: "ready", agents: roster.agents });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [token, onUnauthorized]);

  return (
    <section className="card" aria-labelledby="agents-heading">
      <h2 id="agents-heading">Agents</h2>
      <p className="muted">
        Direct chat is not available yet — it arrives in a later separately-authorized slice. This
        roster is local installation policy only: online means runnable on this gateway, never a
        live presence or provider probe.
      </p>
      {state.phase === "loading" && (
        <p className="muted" role="status">
          Loading the agent roster…
        </p>
      )}
      {state.phase === "error" && (
        <p className="error-message" role="alert">
          Could not load the roster: <code>{state.message}</code>. Reload the page to retry.
        </p>
      )}
      {state.phase === "ready" && (
        <ul className="agent-roster">
          {state.agents.map((agent) => (
            <li key={agent.name} className={agent.online ? "agent-entry" : "agent-entry agent-offline"}>
              <span className="agent-label">
                <span className="agent-name">{agent.name}</span>
                {agent.online ? (
                  <span className="agent-status status-ok">Online</span>
                ) : (
                  <span className="agent-status status-muted">Offline</span>
                )}
              </span>
              {!agent.online && (
                <p className="agent-offline-note">Not runnable on this installation — local policy, not a live probe.</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
