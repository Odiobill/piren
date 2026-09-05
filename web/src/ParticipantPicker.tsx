import type { ConversationAgentEntry } from "./conversation-agents";
import { agentDisplayName } from "./agent-display";

/**
 * Roster-aware participant picker (ADR-0041 R3b-2). Every vault-defined agent
 * is visible; online agents are selectable; offline agents are labelled
 * **Offline**, disabled, and explained. `online` is local installation policy
 * only (membership in this gateway's runnable set) — never a live presence,
 * authentication, transport, or provider probe. Participants are chosen
 * before the create POST and are immutable afterwards (D7).
 */
export function ParticipantPicker({
  agents,
  selected,
  onToggle,
  disabled,
}: {
  agents: ConversationAgentEntry[];
  selected: ReadonlySet<string>;
  onToggle: (name: string, checked: boolean) => void;
  disabled?: boolean;
}) {
  if (agents.length === 0) {
    return (
      <p className="muted" role="status">
        This gateway reported no vault agents.
      </p>
    );
  }
  return (
    <fieldset className="participant-picker" disabled={disabled}>
      <legend>Participants</legend>
      <p className="field-help" id="participant-help">
        Online means runnable on this installation (local policy, not a live status probe). Offline
        agents stay visible but cannot be added.
      </p>
      <ul className="agent-roster" aria-describedby="participant-help">
        {agents.map((agent) => {
          const isSelected = selected.has(agent.name);
          const checkboxId = `participant-${agent.name}`;
          return (
            <li key={agent.name} className={agent.online ? "agent-entry" : "agent-entry agent-offline"}>
              <label htmlFor={checkboxId} className="agent-label">
                <input
                  id={checkboxId}
                  type="checkbox"
                  checked={isSelected}
                  disabled={!agent.online}
                  aria-describedby={agent.online ? undefined : `${checkboxId}-offline-note`}
                  onChange={(event) => onToggle(agent.name, event.target.checked)}
                />
                <span className="agent-name">{agentDisplayName(agent.name)}</span>
                {agent.online ? (
                  <span className="agent-status status-ok">Online</span>
                ) : (
                  <span className="agent-status status-muted">Offline</span>
                )}
              </label>
              {!agent.online && (
                <p className="agent-offline-note" id={`${checkboxId}-offline-note`}>
                  Not runnable on this installation (local policy, not a live probe).
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
