import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createConversation, sendConversationMessage, UnauthorizedError } from "./api";
import {
  clampComposerHeight,
  COMPOSER_MAX_HEIGHT_PX,
  COMPOSER_MIN_HEIGHT_PX,
  shouldSubmitOnEnter,
  toConversationMessageRequest,
  validateConversationText,
} from "./conversation-composer";
import {
  applyMentionCompletion,
  filterRunnableCompletions,
  findMentionTrigger,
  nextCompletionIndex,
} from "./conversation-autocomplete";
import type { ConversationRecord } from "./conversations";
import type { RoomAgentEntry } from "./rooms";

/**
 * U3 — Discord-like Conversation composer (accepted 0.2.0 UX plan §U3).
 *
 * One comfortable composer powers both the ACTIVE conversation surface and
 * the browser-local draft's first-message surface. It auto-grows, submits on
 * a plain Enter (Shift+Enter inserts a newline, and any IME/composition state
 * prevents a premature submit), and carries a genuinely disabled labelled `+`
 * button as a visual future-upload affordance — no file picker or capability
 * behind it.
 *
 * The `@` convenience list offers ONLY locally runnable agents from the
 * current roster (keyboard navigable, text-only insertion). The browser never
 * scans, resolves, or derives dispatch recipients from `@text`: the request
 * body is exactly `{text}`, and the gateway alone parses and validates
 * mentions (C1 server authority), rejecting invalid mentions atomically.
 *
 * Submission is truthful: busy disables the controls, bounded errors stay
 * visible (role=status), and there is no hidden retry/queue/fallback. A draft
 * persists NOTHING until its first raw-text send succeeds.
 */
export function ConversationComposer({
  mode,
  conversationId,
  token,
  agents,
  onUnauthorized,
  onAnnounce,
  onCreated,
}: {
  mode: "draft" | "active";
  /** Active surface only: the selected durable conversation. */
  conversationId?: string;
  token: string;
  /** Current locally runnable roster (autocomplete convenience list only). */
  agents: readonly RoomAgentEntry[];
  onUnauthorized: () => void;
  onAnnounce: (message: string) => void;
  /** Draft mode only: called with the created conversation after its first send. */
  onCreated?: (conversation: ConversationRecord) => void;
}) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  /** Explicit popup visibility: Escape dismisses it until the draft changes. */
  const [mentionVisible, setMentionVisible] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const pendingCaretRef = useRef<number | null>(null);
  const inputId = mode === "draft" ? "conversation-draft-message" : `conversation-message-${conversationId ?? "active"}`;
  const popupId = `${inputId}-mention-popup`;

  // Caret-local @ trigger over the current draft text (never a text scan).
  const mention = findMentionTrigger(text, caret);
  const matches = mention.ok ? filterRunnableCompletions(agents, mention.trigger.token) : [];
  // The popup is visible only while a valid trigger exists AND it was not
  // explicitly dismissed (Escape); typing/editing re-syncs it.
  const mentionOpen = mentionVisible && mention.ok && matches.length > 0;

  // Keep the popup in sync with the trigger: any text/caret edit after an
  // Escape dismissal must resynchronize a still-valid runnable-only picker
  // (the validity booleans alone stay unchanged when the match count does
  // not move, e.g. editing `@d` to `@di` with two matches).
  useEffect(() => {
    setMentionVisible(mention.ok && matches.length > 0);
  }, [mention.ok, matches.length, text, caret]);

  // Reset keyboard selection when the visible list changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [mentionOpen, matches.length]);

  // Auto-grow: content height bounded by the composer range; scrolls once capped.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    const target = clampComposerHeight(input.scrollHeight, COMPOSER_MIN_HEIGHT_PX, COMPOSER_MAX_HEIGHT_PX);
    input.style.height = `${target}px`;
    input.style.overflowY = input.scrollHeight > COMPOSER_MAX_HEIGHT_PX ? "auto" : "hidden";
  }, [text]);

  // After a completion insertion, place the caret where the text lands.
  useEffect(() => {
    const input = inputRef.current;
    if (input && pendingCaretRef.current !== null) {
      input.setSelectionRange(pendingCaretRef.current, pendingCaretRef.current);
      pendingCaretRef.current = null;
    }
  }, [text]);

  function closeMention() {
    setMentionVisible(false);
    setActiveIndex(0);
  }

  /** Text-only insertion of one completion; the gateway remains the authority. */
  function chooseCompletion(name: string) {
    const current = findMentionTrigger(text, caret);
    if (!current.ok) {
      closeMention();
      return;
    }
    const applied = applyMentionCompletion(text, caret, current.trigger.start, name);
    setText(applied.text);
    pendingCaretRef.current = applied.caret;
    setCaret(applied.caret);
    closeMention();
  }

  async function handleSubmit() {
    const validation = validateConversationText(text);
    if (!validation.ok) {
      setError(mode === "draft" ? "Enter the first message to start the conversation." : "Enter a message first.");
      inputRef.current?.focus();
      return;
    }
    setError(null);
    setBusy(true);
    try {
      // The browser sends ONLY the existing raw {text} body; the gateway
      // alone parses/validates mentions and rejects invalid ones atomically.
      const raw = toConversationMessageRequest(text).text;
      if (mode === "active" && conversationId !== undefined) {
        await sendConversationMessage(conversationId, raw, token);
      } else {
        const created = await createConversation(token, raw);
        onCreated?.(created.conversation);
      }
      // Quiet success: durable events arrive via the live stream / re-gate.
      // The composer only clears its input.
      setText("");
      setCaret(0);
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

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const composing = event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229;
    if (event.key === "Enter" && !composing) {
      if (mentionOpen) {
        // Enter inside the open picker selects the active completion instead
        // of submitting (text-only insertion).
        event.preventDefault();
        chooseCompletion(matches[Math.min(Math.max(activeIndex, 0), matches.length - 1)] ?? matches[0] ?? "");
        return;
      }
      if (shouldSubmitOnEnter({ key: event.key, shiftKey: event.shiftKey, isComposing: composing })) {
        event.preventDefault();
        void handleSubmit();
      }
      // Shift+Enter: let the browser insert the newline (never submits).
      return;
    }
    if (mentionOpen && event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => nextCompletionIndex(index, matches.length, 1));
      return;
    }
    if (mentionOpen && event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => nextCompletionIndex(index, matches.length, -1));
      return;
    }
    if (mentionOpen && event.key === "Escape") {
      event.preventDefault();
      closeMention();
      return;
    }
    if (mentionOpen && event.key === "Tab") {
      event.preventDefault();
      chooseCompletion(matches[Math.min(Math.max(activeIndex, 0), matches.length - 1)] ?? matches[0] ?? "");
    }
  }

  function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void handleSubmit();
  }

  const activeName = matches[Math.min(Math.max(activeIndex, 0), matches.length - 1)];

  return (
    <form className="conversation-composer" onSubmit={handleFormSubmit}>
      <div className="composer-controls">
        <button
          type="button"
          className="composer-upload-placeholder"
          disabled
          aria-label="Upload is not available"
          title="Upload is not available"
        >
          +
        </button>
        <div className="composer-input-wrap">
          <label className="sr-only" htmlFor={inputId}>
            {mode === "draft" ? "First message" : "Message"}
          </label>
          <textarea
            id={inputId}
            ref={inputRef}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? text.length)}
            onClick={(event) => setCaret(event.currentTarget.selectionStart ?? text.length)}
            onKeyUp={(event) => setCaret(event.currentTarget.selectionStart ?? text.length)}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            placeholder={mode === "draft" ? "Write the first message…" : "Write a message…"}
            rows={1}
            disabled={busy}
            aria-autocomplete="list"
            aria-expanded={mentionOpen}
            aria-controls={mentionOpen ? popupId : undefined}
            aria-activedescendant={mentionOpen && activeName !== undefined ? `${popupId}-option-${activeIndex}` : undefined}
          />
          {mentionOpen && (
            <div className="mention-popup" id={popupId} role="listbox" aria-label="Mention an agent">
              <ul>
                {matches.map((name, index) => (
                  <li
                    key={name}
                    id={`${popupId}-option-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseCompletion(name)}
                  >
                    @{name}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <button type="submit" className="button button-primary composer-send" disabled={busy}>
          Send
        </button>
      </div>
      <p className="field-help">
        Mentions are resolved by the gateway: <code>@name</code> a locally runnable agent to dispatch
        to it. The browser never reads recipient names from your text.
      </p>
      {error && (
        <p className="error-message" role="status">
          {error}
        </p>
      )}
    </form>
  );
}
