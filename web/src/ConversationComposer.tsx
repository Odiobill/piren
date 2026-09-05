import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { sendConversationMessage, UnauthorizedError } from "./api";
import {
  clampComposerHeight,
  COMPOSER_MAX_HEIGHT_PX,
  COMPOSER_MIN_HEIGHT_PX,
  shouldSubmitForPolicy,
  submitPolicyAccessibleName,
  submitPolicyTooltip,
  toConversationMessageRequest,
  validateConversationText,
  type ConversationSubmitPolicy,
} from "./conversation-composer";
import {
  COMPOSER_INTERLOCK_CLEARED_ANNOUNCEMENT,
  composerInterlockVisibleText,
  reduceComposerInterlock,
  type ComposerInterlockState,
} from "./composer-interlock";
import {
  applyMentionCompletion,
  filterRunnableCompletions,
  findMentionTrigger,
  nextCompletionIndex,
} from "./conversation-autocomplete";
import { PlusIcon, ReturnKeyIcon } from "./icons";
import { agentDisplayName } from "./agent-display";
import type { ConversationAgentEntry } from "./conversation-agents";

/**
 * U3 + P1 — Discord-like Conversation composer (accepted 0.2.0 UX plan §U3
 * and the P1 submit-shortcut contract).
 *
 * One comfortable composer powers the ACTIVE conversation surface. It
 * auto-grows, carries a clean one-line dock (disabled labelled `+` upload
 * affordance left, textarea middle, compact submit-shortcut icon right), and
 * submits only on the page-local selected policy: Enter to send (Shift+Enter
 * newline) or Ctrl+Enter to send (Enter newline; Ctrl+Enter sends). Any
 * IME/composition state always prevents a premature submit. The submit
 * policy is component state only — it never sends, persists, changes the
 * URL, the gateway, the agent, the Conversation, or browser storage, and a
 * fresh mount resets it.
 *
 * The `@` convenience list offers ONLY locally runnable agents from the
 * current roster (keyboard navigable, text-only insertion). The browser never
 * scans, resolves, or derives dispatch recipients from `@text`: the request
 * body is exactly `{text}`, and the gateway alone parses and validates
 * mentions (C1 server authority), rejecting invalid mentions atomically.
 *
 * Submission is truthful: busy disables the controls, bounded errors stay
 * visible (role=status), and there is no hidden retry/queue/fallback.
 * ADR-0044: the browser-local draft first-message mode is REMOVED — new
 * Conversations start only through the Dashboard's explicit agent-first
 * start; this composer appends follow-up messages to an attached
 * Conversation.
 */
export function ConversationComposer({
  conversationId,
  token,
  agents,
  onUnauthorized,
  onAnnounce,
  onSent,
  interlocked = false,
  interlockReason = "",
}: {
  /** The selected durable conversation (active surface). */
  conversationId: string;
  token: string;
  /** Current locally runnable roster (autocomplete convenience list only). */
  agents: readonly ConversationAgentEntry[];
  onUnauthorized: () => void;
  onAnnounce: (message: string) => void;
  /**
   * P2 active surface only: called after an accepted send so the navigator
   * can refresh the list/selected manifest from existing gateway reads.
   * Never called on a bounded failure or for a mention-completion insertion.
   */
  onSent?: () => void;
  /**
   * U2: whether the selected Conversation currently has authoritative live
   * agent work (an active broker run) or a steward-scoped pending approval.
   * Honest browser reflection of broker state only — never a second lock.
   */
  interlocked?: boolean;
  /** U2: the specific visible interlock reason (aria-describedby target). */
  interlockReason?: string;
}) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  /** P1: page-local submit policy (component state only; resets on mount). */
  const [submitPolicy, setSubmitPolicy] = useState<ConversationSubmitPolicy>("enter");
  /** Explicit popup visibility: Escape dismisses it until the draft changes. */
  const [mentionVisible, setMentionVisible] = useState(false);
  /** U2: the interlock state machine (editable / interlocked-draft). */
  const [interlockState, setInterlockState] = useState<ComposerInterlockState>({ state: "editable" });
  /** U2: the latest live draft (byte-for-byte interlock capture). */
  const textRef = useRef("");
  /** U2: synchronous view of the interlock state for the transition effect. */
  const interlockStateRef = useRef<ComposerInterlockState>({ state: "editable" });
  const wasInterlockedRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const pendingCaretRef = useRef<number | null>(null);
  /** P8 (§1): restore-focus intent set ONLY after an accepted send. */
  const restoreFocusRef = useRef(false);
  /** P8 (§1): the focused element when the send started (deliberate-focus guard). */
  const activeAtSubmitRef = useRef<Element | null>(null);
  const inputId = `conversation-message-${conversationId}`;
  const popupId = `${inputId}-mention-popup`;
  const reasonId = `${inputId}-interlock-reason`;

  // U2: the visible textarea text is derived from the interlock state.
  const visibleText = composerInterlockVisibleText(interlockState, text);

  // Caret-local @ trigger over the current draft text (never a text scan).
  const mention = findMentionTrigger(text, caret);
  const matches = mention.ok ? filterRunnableCompletions(agents, mention.trigger.token) : [];
  // The popup is visible only while a valid trigger exists AND it was not
  // explicitly dismissed (Escape); typing/editing re-syncs it. An interlocked
  // composer never offers the picker (read-only, no recipient derivation).
  const mentionOpen = !interlocked && mentionVisible && mention.ok && matches.length > 0;

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

  // P8 (§1): restore textarea focus after an ACCEPTED send, deferred to
  // the commit that re-enables the textarea (busy -> false). Never fires for a
  // rejected/failed send (no intent) and never over a deliberate user focus
  // move (the activeElement guard). preventScroll keeps the transcript/dock
  // position.
  useEffect(() => {
    if (busy) return;
    if (!restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    const input = inputRef.current;
    if (!input) return;
    const active = document.activeElement;
    const submitTarget = activeAtSubmitRef.current;
    if (active !== document.body && active !== input && active !== submitTarget) return;
    input.focus({ preventScroll: true });
  }, [busy]);

  // U2: keep the synchronous draft/interlock views in sync for the transition
  // effect (byte-for-byte capture and restoration).
  useEffect(() => {
    textRef.current = text;
  }, [text]);
  useEffect(() => {
    interlockStateRef.current = interlockState;
  }, [interlockState]);

  /**
   * U2 — the interlock transition effect. It NEVER moves focus, scrolls,
   * fetches, or mutates anything beyond the interlock state, the draft
   * preserved-draft restoration, and ONE polite announcement per
   * transition (begin/clear; never per event tick).
   */
  useEffect(() => {
    const was = wasInterlockedRef.current;
    wasInterlockedRef.current = interlocked;
    if (interlocked === was) return;
    if (interlocked) {
      if (interlockReason !== "") onAnnounce(interlockReason);
      setInterlockState(reduceComposerInterlock(interlockStateRef.current, { type: "interlock-begin", draft: textRef.current }));
    } else {
      onAnnounce(COMPOSER_INTERLOCK_CLEARED_ANNOUNCEMENT);
      const prev = interlockStateRef.current;
      setInterlockState(reduceComposerInterlock(prev, { type: "interlock-clear" }));
      // VR-1: only an UNSENT preserved draft is restored; a composer cleared
      // by a submitted send stays empty (the durable timeline item is the
      // evidence — no acknowledgement is ever restored).
      if (prev.state === "interlocked-draft" && prev.draft !== "") setText(prev.draft);
    }
  }, [interlocked]);

  // Auto-grow: content height bounded by the composer range; scrolls once
  // capped. Driven by the VISIBLE text so an interlocked preserved draft
  // still grows the box correctly.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    const target = clampComposerHeight(input.scrollHeight, COMPOSER_MIN_HEIGHT_PX, COMPOSER_MAX_HEIGHT_PX);
    input.style.height = `${target}px`;
    input.style.overflowY = input.scrollHeight > COMPOSER_MAX_HEIGHT_PX ? "auto" : "hidden";
  }, [visibleText]);

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
    if (interlocked) return;
    const validation = validateConversationText(text);
    if (!validation.ok) {
      setError("Enter a message first.");
      // P8 (§1): a rejected send never moves focus (the textarea already owns
      // it when the user pressed Enter; the error is announced via role=status).
      return;
    }
    setError(null);
    // P8 (§1): record where focus was when the send started — a deliberate
    // user focus move during the in-flight request always wins.
    activeAtSubmitRef.current = document.activeElement;
    // VR-1: capture the exact outgoing message and clear the composer
    // IMMEDIATELY, before the POST resolves. The durable timeline event of an
    // accepted send is its only evidence; it is never retained for display.
    const raw = toConversationMessageRequest(text).text;
    setText("");
    setCaret(0);
    // Synchronous ref update so a mid-flight interlock captures the already-
    // cleared state deterministically (never the pre-submit draft).
    textRef.current = "";
    setBusy(true);
    try {
      // The browser sends ONLY the existing raw {text} body; the gateway
      // alone parses/validates mentions and rejects invalid ones atomically.
      await sendConversationMessage(conversationId, raw, token);
      // Quiet success: durable events arrive via the live stream / re-gate.
      // Nothing is retained; the P2 navigator refresh is a separate
      // gateway-truth read (onSent), never an optimistic write.
      restoreFocusRef.current = true;
      onSent?.();
    } catch (cause) {
      if (cause instanceof UnauthorizedError) {
        // Preserve the byte-exact failed draft before handing over to the
        // shell so nothing is lost across re-authentication.
        setText(raw);
        textRef.current = raw;
        onUnauthorized();
        return;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      onAnnounce(message);
      if (wasInterlockedRef.current) {
        // VR-1 race rule: the POST failed while a REAL authoritative interlock
        // is active. The exact failed draft is preserved INSIDE that read-only
        // interlock (no editable bypass of active-run/approval protection) and
        // becomes editable only when that interlock clears.
        setInterlockState(reduceComposerInterlock(interlockStateRef.current, { type: "send-failed-interlocked", draft: raw }));
      } else {
        // No interlock: restore the exact draft immediately as editable.
        setText(raw);
        textRef.current = raw;
        setCaret(raw.length);
      }
    } finally {
      setBusy(false);
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (interlocked) return;
    const composing = event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229;
    if (event.key === "Enter" && !composing) {
      // An open picker keeps its Enter-to-choose semantics under either
      // policy; the policy's submit key (Ctrl+Enter in Ctrl+Enter mode)
      // still submits past an open picker.
      if (mentionOpen && !event.ctrlKey && !event.shiftKey && !event.metaKey) {
        event.preventDefault();
        chooseCompletion(matches[Math.min(Math.max(activeIndex, 0), matches.length - 1)] ?? matches[0] ?? "");
        return;
      }
      if (
        shouldSubmitForPolicy(
          { key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, isComposing: composing },
          submitPolicy,
        )
      ) {
        event.preventDefault();
        void handleSubmit();
      }
      // Any other Enter (Shift/Ctrl/Meta newline, or the non-submit key in
      // the active policy) lets the browser insert the newline.
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
          <PlusIcon size={14} />
        </button>
        <div className="composer-input-wrap">
          <label className="sr-only" htmlFor={inputId}>
            Message
          </label>
          <textarea
            id={inputId}
            ref={inputRef}
            value={visibleText}
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
            placeholder="Write a message…"
            rows={1}
            disabled={busy}
            readOnly={interlocked}
            aria-disabled={interlocked ? "true" : undefined}
            aria-describedby={interlocked ? reasonId : undefined}
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
                    @{agentDisplayName(name)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <button
          type="button"
          className="composer-submit-toggle"
          aria-pressed={submitPolicy === "enter"}
          aria-label={submitPolicyAccessibleName(submitPolicy)}
          title={submitPolicyTooltip(submitPolicy)}
          disabled={interlocked}
          onClick={() => setSubmitPolicy((policy) => (policy === "enter" ? "ctrl-enter" : "enter"))}
        >
          <ReturnKeyIcon size={16} />
        </button>
      </div>
      {interlocked && (
        <p id={reasonId} className="composer-interlock-reason">
          {interlockReason}
        </p>
      )}
      {error && (
        <p className="error-message" role="status">
          {error}
        </p>
      )}
    </form>
  );
}
