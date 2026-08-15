import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import type { ConversationRecord } from "./conversations";
import { classifyAudienceMembers } from "./attach";
import type { ConversationAgentEntry } from "./conversation-agents";
import type { ConversationLifecycleAction, LifecycleActionError } from "./conversation-lifecycle";
import { normalizeConversationTitle, type RenameError } from "./conversation-details";
import { XIcon } from "./icons";

/**
 * U2 — Conversation details modal (accepted
 * `conversation-details-rename-contract.md` §U2 UI contract).
 *
 * The routine conversation flow shows only the current title; the modal
 * presents the durable metadata (title, id, status, audience, created/
 * updated) and the existing Archive/Reopen controls with their accepted
 * semantics (archive keeps its explicit confirmation; lifecycle actions keep
 * the fresh re-gate discipline — the browser never sets status itself).
 *
 * The steward can edit the title in a labelled input: Save is disabled until
 * the normalized value differs and while a request is in flight; a success
 * announces the returned title (the navigator re-reads/re-gates); a bounded
 * failure remains visible with an explicit Retry (never a hidden retry).
 *
 * Accessibility: opening moves focus to the title input; focus remains
 * trapped inside; Escape and Close dismiss it; dismissal returns focus to
 * the invoking details button; labels and errors are programmatically
 * associated. The no-selection surface has no selected durable Conversation,
 * so no details control exists for it.
 *
 * The browser never writes or derives titles, events, lock state, or
 * routing — it sends the raw title to the authenticated route, then the
 * navigator re-reads/re-gates; no storage, no WebSocket, no config UI.
 */
export function ConversationDetailsModal({
  conversation,
  agents,
  lifecyclePhase,
  lifecycleError,
  confirmingArchive,
  archiveButtonRef,
  confirmArchiveRef,
  onArchiveRequest,
  onCancelArchive,
  onConfirmArchive,
  onReopen,
  onLifecycleRetry,
  onRename,
  onClose,
}: {
  conversation: ConversationRecord;
  agents: ConversationAgentEntry[];
  lifecyclePhase: "idle" | "busy" | "error";
  lifecycleError: LifecycleActionError | null;
  confirmingArchive: boolean;
  archiveButtonRef: RefObject<HTMLButtonElement | null>;
  confirmArchiveRef: RefObject<HTMLButtonElement | null>;
  onArchiveRequest: () => void;
  onCancelArchive: () => void;
  onConfirmArchive: () => void;
  onReopen: () => void;
  onLifecycleRetry: () => void;
  /** Returns a bounded error on failure, null on success (navigator re-gates). */
  onRename: (title: string) => Promise<RenameError | null>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [titleDraft, setTitleDraft] = useState(conversation.title);
  const [renameState, setRenameState] = useState<
    { phase: "idle" } | { phase: "busy" } | { phase: "error"; error: RenameError }
  >({ phase: "idle" });
  const busy = renameState.phase === "busy";
  // Ref mirror so the one-time document keydown listener always sees the
  // current in-flight state (the listener is registered once per onClose
  // identity and must not close over a stale render's `busy`).
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const normalized = normalizeConversationTitle(titleDraft);
  // Truthful Save gate: the normalized value must differ from the last
  // gateway-authoritative title, and no request may be in flight.
  const saveDisabled = !(normalized.ok && normalized.title !== conversation.title) || busy;

  // Open focus + trap + Escape: opening moves focus to the title input;
  // Tab cycles inside; Escape/Close dismiss (focus return is the caller's).
  useEffect(() => {
    titleInputRef.current?.focus();
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      );
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // While a rename Save is in flight, Escape must never dismiss the
        // modal: if the request then fails, the bounded failure and explicit
        // Retry must stay visible on the mounted modal (U2 correction).
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

  async function handleSave() {
    if (saveDisabled || !normalized.ok) return;
    setRenameState({ phase: "busy" });
    const error = await onRename(normalized.title);
    // On success the navigator closes the modal and re-reads/re-gates (this
    // component unmounts); on failure the bounded error stays visible with
    // an explicit Retry.
    if (error !== null) setRenameState({ phase: "error", error });
  }

  function handleRetry() {
    if (renameState.phase === "error") void handleSave();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void handleSave();
  }

  return (
    <div className="details-modal-backdrop">
      <div
        ref={dialogRef}
        id="conversation-details-dialog"
        className="details-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conversation-details-heading"
        tabIndex={-1}
      >
        <div className="details-modal-header">
          <h2 id="conversation-details-heading">Conversation details</h2>
          <button
            type="button"
            className="button button-small details-close"
            aria-label="Close conversation details"
            onClick={onClose}
            disabled={busy}
          >
            <XIcon size={14} />
          </button>
        </div>

        <form className="details-rename" onSubmit={handleSubmit}>
          <label htmlFor="conversation-title-input">Title</label>
          <input
            id="conversation-title-input"
            ref={titleInputRef}
            type="text"
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            maxLength={CONVERSATION_TITLE_MAX_DISPLAY}
            disabled={busy}
          />
          <p className="field-help">
            The title is durable manifest metadata for the steward. Saving changes only the
            current display title — never the conversation id, members, status, or history.
          </p>
          <div className="details-rename-actions">
            <button type="submit" className="button button-primary" disabled={saveDisabled}>
              Save
            </button>
            <button type="button" className="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </div>
          {renameState.phase === "error" && (
            <div className="details-rename-error" role="alert">
              <p className="error-message">{renameState.error.message}</p>
              <button type="button" className="button button-small" onClick={handleRetry}>
                Retry
              </button>
            </div>
          )}
        </form>

        <dl className="details-meta">
          <div className="details-meta-row">
            <dt>Id</dt>
            <dd>
              <code>{conversation.id}</code>
            </dd>
          </div>
          <div className="details-meta-row">
            <dt>Status</dt>
            <dd>{conversation.status}</dd>
          </div>
          <div className="details-meta-row">
            <dt>Created</dt>
            <dd>
              <code>{conversation.created}</code>
            </dd>
          </div>
          <div className="details-meta-row">
            <dt>Updated</dt>
            <dd>
              <code>{conversation.updated}</code>
            </dd>
          </div>
        </dl>

        <AudienceMembers audience={conversation.audience} agents={agents} />

        <ConversationLifecycleControls
          status={conversation.status}
          phase={lifecyclePhase}
          error={lifecycleError}
          confirmingArchive={confirmingArchive}
          archiveButtonRef={archiveButtonRef}
          confirmArchiveRef={confirmArchiveRef}
          onArchiveRequest={onArchiveRequest}
          onCancelArchive={onCancelArchive}
          onConfirmArchive={onConfirmArchive}
          onReopen={onReopen}
          onRetry={onLifecycleRetry}
        />
      </div>
    </div>
  );
}

/** Client-side bounded mirror (the server rejects anything longer; maxLength keeps the draft honest). */
const CONVERSATION_TITLE_MAX_DISPLAY = 120;

/**
 * U2: truthful runnable-member chips for the modal (moved from the routine
 * conversation flow). "Offline" means not locally runnable on this
 * installation (local policy only, never a live probe).
 */
function AudienceMembers({ audience, agents }: { audience: string[]; agents: ConversationAgentEntry[] }) {
  const members = classifyAudienceMembers(audience, agents);
  if (members.length === 0) {
    return <p className="muted">No members yet — mention a locally runnable agent to add one.</p>;
  }
  return (
    <div className="audience-members">
      <h3>Members</h3>
      <ul className="member-list">
        {members.map((member) => (
          <li key={member.name} className={member.runnable ? "member-chip" : "member-chip member-offline"}>
            <span className="member-name">{member.name}</span>
            {member.runnable ? (
              <span className="member-status status-ok">Runnable</span>
            ) : (
              <span className="member-status status-muted">Offline</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * U2: the L3 minimal lifecycle controls, relocated into the details modal.
 * Archive on every selected open Conversation (active or read-only due to a
 * non-runnable audience) behind an explicit non-modal inline confirmation;
 * Reopen only on selected archived read-only inspection. Semantics unchanged:
 * the browser only sends the fixed action + selected id, then the navigator
 * re-runs the fresh manifest/attach gate before deciding active/read-only.
 */
export function ConversationLifecycleControls({
  status,
  phase,
  error,
  confirmingArchive,
  archiveButtonRef,
  confirmArchiveRef,
  onArchiveRequest,
  onCancelArchive,
  onConfirmArchive,
  onReopen,
  onRetry,
}: {
  status: string;
  phase: "idle" | "busy" | "error";
  error: LifecycleActionError | null;
  confirmingArchive: boolean;
  archiveButtonRef: RefObject<HTMLButtonElement | null>;
  confirmArchiveRef: RefObject<HTMLButtonElement | null>;
  onArchiveRequest: () => void;
  onCancelArchive: () => void;
  onConfirmArchive: () => void;
  onReopen: () => void;
  onRetry: () => void;
}) {
  const busy = phase === "busy";
  if (status === "archived") {
    return (
      <div className="lifecycle-controls">
        <button type="button" className="button" onClick={onReopen} disabled={busy}>
          Reopen
        </button>
        {phase === "error" && error !== null && <LifecycleErrorNotice error={error} onRetry={onRetry} />}
      </div>
    );
  }
  const copy = archiveConfirmationCopy();
  return (
    <div className="lifecycle-controls">
      <button type="button" ref={archiveButtonRef} className="button" onClick={onArchiveRequest} disabled={busy}>
        Archive
      </button>
      {confirmingArchive && (
        <div className="confirmation-card" role="group" aria-label="Confirm archive">
          <p>{copy.intro}</p>
          <div className="confirmation-actions">
            <button type="button" ref={confirmArchiveRef} className="button button-primary" onClick={onConfirmArchive} disabled={busy}>
              {copy.confirm}
            </button>
            <button type="button" className="button" onClick={onCancelArchive} disabled={busy}>
              {copy.cancel}
            </button>
          </div>
        </div>
      )}
      {phase === "error" && error !== null && <LifecycleErrorNotice error={error} onRetry={onRetry} />}
    </div>
  );
}

/** Bounded lifecycle error with an explicit manual Retry (never automatic). */
function LifecycleErrorNotice({ error, onRetry }: { error: LifecycleActionError; onRetry: () => void }) {
  return (
    <div className="lifecycle-error" role="alert">
      <p className="error-message">{error.message}</p>
      <button type="button" className="button button-small" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

/** Bounded copy for the non-modal archive confirmation card (unchanged L3). */
function archiveConfirmationCopy(): { intro: string; confirm: string; cancel: string } {
  return {
    intro: "Archiving this conversation makes it read-only: it stops accepting messages and cannot be attached as active until reopened. Runs already in flight are not aborted.",
    confirm: "Confirm archive",
    cancel: "Cancel",
  };
}

export type { ConversationLifecycleAction };
