import { useEffect, useRef, useState, type FormEvent } from "react";
import { ClipboardIcon, RetryIcon, XIcon } from "./icons";
import { agentDisplayName } from "./agent-display";

/**
 * T1 — Dashboard Assign-task modal over the EXISTING authenticated
 * gateway inbox-create route (typed client in api.ts). Accessible dialog: opening moves focus to
 * the subject input; focus stays trapped; Escape/Close/Cancel dismiss while
 * idle (never while a submit is in flight); dismissal returns focus via the
 * caller. The recipient is the exactly-one selected runnable agent and is
 * only displayed — never edited here. Required trimmed Subject and Task
 * details gate submit; one in-flight submit disables resubmission; failures
 * stay visible with an explicit Retry only (never automatic). Success is
 * reported by the caller as creation evidence only.
 *
 * The browser sends only `{to, title, body}` through the typed client;
 * server metadata (from steward, type Task, priority, pending,
 * requires_approval, id/timestamps/path) is never sent or fabricated.
 */
export function AssignTaskModal({
  agent,
  onAssign,
  onClose,
}: {
  /** The exactly-one selected runnable agent (recipient, display only). */
  agent: string;
  /**
   * Performs one explicit authenticated submission. Resolves when the task
   * was created (the caller closes the modal and reports truthful success);
   * rejects with a bounded message that stays visible here.
   */
  onAssign: (title: string, details: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const [subject, setSubject] = useState("");
  const [details, setDetails] = useState("");
  const [phase, setPhase] = useState<"idle" | "busy" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const busy = phase === "busy";
  // Ref mirror so the once-registered keydown listener never closes over a
  // stale render's busy state.
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const subjectTrimmed = subject.trim();
  const detailsTrimmed = details.trim();
  const submitDisabled = busy || subjectTrimmed === "" || detailsTrimmed === "";

  // Open focus + trap + Escape, mirroring the U2 details-modal pattern.
  useEffect(() => {
    subjectRef.current?.focus();
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select, [tabindex]:not([tabindex="-1"])',
        ),
      );
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (busyRef.current) return;
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "Tab") {
        const list = focusables();
        if (list.length === 0) return;
        const firstEl = list[0] as HTMLElement;
        const lastEl = list[list.length - 1] as HTMLElement;
        const active = document.activeElement;
        const onDialog = active === dialog;
        const outside = !dialog.contains(active);
        if (event.shiftKey && (active === firstEl || onDialog || outside)) {
          event.preventDefault();
          lastEl.focus();
        } else if (!event.shiftKey && (active === lastEl || onDialog || outside)) {
          event.preventDefault();
          firstEl.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function handleSubmit() {
    if (submitDisabled) return;
    setPhase("busy");
    setError(null);
    try {
      await onAssign(subjectTrimmed, detailsTrimmed);
      // Success: the caller closes the modal and reports the bounded,
      // truthful creation notice; this component unmounts.
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("error");
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void handleSubmit();
  }

  function handleRetry() {
    if (phase === "error") void handleSubmit();
  }

  return (
    <div className="details-modal-backdrop">
      <div
        ref={dialogRef}
        id="assign-task-dialog"
        className="details-modal assign-task-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="assign-task-heading"
        tabIndex={-1}
      >
        <div className="details-modal-header">
          <h2 id="assign-task-heading">Assign a task</h2>
          <button type="button" className="button button-small details-close" aria-label="Close assign task" onClick={onClose} disabled={busy}>
            <XIcon size={14} />
          </button>
        </div>
        <p className="muted assign-task-recipient">
          Recipient: <strong>{agentDisplayName(agent)}</strong>
        </p>
        <form onSubmit={onSubmit}>
          <label htmlFor="assign-task-subject">Subject</label>
          <input
            id="assign-task-subject"
            ref={subjectRef}
            type="text"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            disabled={busy}
            required
          />
          <label htmlFor="assign-task-details">Task details</label>
          <textarea
            id="assign-task-details"
            rows={6}
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            disabled={busy}
            required
          />
          <p className="field-help">
            Creates one ordinary pending inbox task for {agentDisplayName(agent)} in the vault. It does not contact, wake, or start
            the agent; the task is inspectable through Vault Explorer.
          </p>
          <div className="details-rename-actions">
            <button type="submit" className="button button-primary assign-task-submit" disabled={submitDisabled}>
              <ClipboardIcon size={14} />
              Create task
            </button>
            <button type="button" className="button" onClick={onClose} disabled={busy}>
              <XIcon size={14} />
              Cancel
            </button>
          </div>
          {phase === "error" && error !== null && (
            <div className="details-rename-error" role="alert">
              <p className="error-message">{error}</p>
              <button type="button" className="button button-small" onClick={handleRetry} disabled={busy}>
                <RetryIcon size={12} />
                Retry
              </button>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
