import { useState, type FormEvent } from "react";
import { sendRoomMessage, UnauthorizedError } from "./api";
import { toMessageRequest, validateComposerInput } from "./composer";

/**
 * Structured room dispatch composer (ADR-0041 R3b-4 / W1, Rooms module).
 *
 * Sends the accepted structured `{agent, text}` body through the existing
 * authenticated `POST /api/rooms/<id>/messages` route for a selected existing
 * room. The selectable target agent comes ONLY from the room's immutable
 * participant record — never from rendered `@text` or free text. The native
 * submit is disabled unless a participant is selected and the trimmed text is
 * non-empty. On send the component renders truthful loading/disabled/error
 * feedback and relies on the existing immutable timeline (history + SSE) for
 * the causal event sequence; it never invents events, retries, queues, or
 * synthetic run status. 401 returns to token entry; a 409 active-run conflict
 * is shown truthfully with no auto-retry.
 */
export function RoomComposer({
  roomId,
  participants,
  token,
  onUnauthorized,
  onAnnounce,
}: {
  roomId: string;
  participants: string[];
  token: string;
  onUnauthorized: () => void;
  onAnnounce: (message: string) => void;
}) {
  const [selectedAgent, setSelectedAgent] = useState("");
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<"idle" | "sending" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const validation = validateComposerInput({ participants, selectedAgent, text });
  const canSend = validation.ok && phase !== "sending";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase === "sending") return;
    const check = validateComposerInput({ participants, selectedAgent, text });
    if (!check.ok) {
      setError("Choose a participant and enter a message to send.");
      return;
    }
    setPhase("sending");
    setError(null);
    try {
      const request = toMessageRequest(selectedAgent, text);
      await sendRoomMessage(roomId, request.agent, request.text, token);
      setText("");
      setPhase("idle");
      onAnnounce(`Message sent to ${request.agent}. Follow the room timeline for the run outcome.`);
    } catch (err) {
      setPhase("error");
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      // Non-secret server message (e.g. active-run conflict) or HTTP status.
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form className="composer card" onSubmit={(event) => void handleSubmit(event)} aria-labelledby="composer-heading">
      <h3 id="composer-heading">Dispatch to a room participant</h3>
      <div className="composer-field">
        <label htmlFor="composer-agent">Target agent</label>
        <select
          id="composer-agent"
          name="agent"
          value={selectedAgent}
          onChange={(event) => setSelectedAgent(event.target.value)}
          disabled={participants.length === 0}
        >
          <option value="">Select a participant…</option>
          {participants.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div className="composer-field">
        <label htmlFor="composer-text">Message</label>
        <textarea
          id="composer-text"
          name="text"
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Structured dispatch: the target agent comes from the participant list, never from @text."
        />
      </div>
      <button type="submit" className="button button-primary" disabled={!canSend}>
        {phase === "sending" ? "Sending…" : "Send"}
      </button>
      {error !== null && (
        <p className="error-message" role="alert" aria-live="polite">
          {error}
        </p>
      )}
      <p className="muted">
        The room timeline shows the durable causal sequence: your message, the lead run, and the
        terminal outcome.
      </p>
    </form>
  );
}
