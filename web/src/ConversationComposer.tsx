import { useRef, useState, type FormEvent } from "react";
import { sendConversationMessage, UnauthorizedError } from "./api";
import { toConversationMessageRequest, validateConversationText } from "./conversation-composer";

/**
 * Raw-text Conversation composer (C3-A). Sends the raw follow-up text to the
 * accepted `POST /api/conversations/<id>/messages` route. The gateway alone
 * parses and validates `@`-mentions against the local runnable set (C1
 * server authority); this component NEVER scans, resolves, or derives
 * dispatch recipients from the text — the request body is exactly `{text}`.
 * No hidden retry, queue, auto-approval, or fallback: a rejected message
 * (400 atomic mention failure, 409 archived/conflict) is surfaced truthfully.
 */
export function ConversationComposer({
  conversationId,
  token,
  onUnauthorized,
  onAnnounce,
}: {
  conversationId: string;
  token: string;
  onUnauthorized: () => void;
  onAnnounce: (message: string) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateConversationText(text);
    if (!validation.ok) {
      setError("Enter a message first.");
      inputRef.current?.focus();
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await sendConversationMessage(conversationId, toConversationMessageRequest(text).text, token);
      // Quiet success: the durable event + any dispatch run events arrive via
      // the live stream. The composer only clears its input.
      setText("");
    } catch (cause) {
      if (cause instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      onAnnounce(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="conversation-composer" onSubmit={handleSubmit}>
      <h3>Send a message</h3>
      <label htmlFor={`conversation-message-${conversationId}`}>Message</label>
      <textarea
        id={`conversation-message-${conversationId}`}
        ref={inputRef}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Write a message…"
        rows={3}
        disabled={busy}
      />
      <p className="field-help">
        Mentions are resolved by the gateway: <code>@name</code> a locally runnable agent to dispatch
        to it. The browser never reads recipient names from your text.
      </p>
      {error && (
        <p className="error-message" role="status">
          {error}
        </p>
      )}
      <button type="submit" className="button button-primary" disabled={busy}>
        Send
      </button>
    </form>
  );
}
