import { useEffect, useRef, useState, type FormEvent, type ReactElement, type RefObject } from "react";
import type { ConversationRecord } from "./conversations";
import { classifyAudienceMembers } from "./attach";
import type { ConversationAgentEntry } from "./conversation-agents";
import type { ConversationLifecycleAction, LifecycleActionError } from "./conversation-lifecycle";
import { normalizeConversationTitle, type RenameError } from "./conversation-details";
import { ArchiveIcon, CheckIcon, ReopenIcon, RetryIcon, XIcon } from "./icons";
import {
  fetchConversationWorkflowBudgets,
  updateConversationWorkflowBudget,
  WorkflowBudgetHttpError,
} from "./api";
import {
  buildWorkflowBudgetUpdateRequest,
  isWorkflowBudgetSaveEnabled,
  remainingEdges,
  remainingReworkRounds,
  WORKFLOW_BUDGET_FIXED_DEPTH,
  type ConversationWorkflowBudgetsView,
  type WorkflowBudgetDraft,
  type WorkflowBudgetRootView,
} from "./conversation-workflow-budget";

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
  token,
  onWorkflowBudgetsChanged,
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
  /** B5: in-memory Bearer token for the two bounded workflow-budget routes. */
  token: string;
  /** B5: narrow navigator re-read/re-gate callback after a successful save. */
  onWorkflowBudgetsChanged: (conversationId: string) => void;
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

  // B5: workflow-budget section state (bounded server view + per-root drafts).
  const [budgetView, setBudgetView] = useState<ConversationWorkflowBudgetsView | null>(null);
  const [budgetLoadError, setBudgetLoadError] = useState<string | null>(null);
  const [budgetDrafts, setBudgetDrafts] = useState<Record<string, WorkflowBudgetDraft>>({});
  // B5 correction: the save interlock is MODAL-WIDE — any workflow-budget
  // POST disables every root's controls and the modal Close/Cancel.
  const [savingBudget, setSavingBudget] = useState(false);
  const [budgetRequestError, setBudgetRequestError] = useState<{ rootEventId: string; message: string } | null>(null);
  const [budgetReloadError, setBudgetReloadError] = useState<{ rootEventId: string; message: string } | null>(null);
  // Ref mirror for the keydown listener: a budget save is in flight.
  const budgetBusyRef = useRef(false);
  budgetBusyRef.current = savingBudget;

  useEffect(() => {
    let cancelled = false;
    // B5: ONE explicit bounded fetch on open (never polling, never a retry
    // loop); failures render with explicit Retry.
    const load = async (): Promise<void> => {
      setBudgetLoadError(null);
      try {
        const view = await fetchConversationWorkflowBudgets(conversation.id, token);
        if (cancelled) return;
        setBudgetView(view);
      } catch (cause) {
        if (cancelled) return;
        setBudgetLoadError(
          cause instanceof WorkflowBudgetHttpError
            ? `Workflow budgets unavailable (HTTP ${cause.status}).`
            : "Workflow budgets unavailable. Check the gateway and retry.",
        );
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [conversation.id, token]);
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
        // While a rename Save or a workflow-budget Save is in flight, Escape
        // must never dismiss the modal: if the request then fails, the
        // bounded failure and explicit Retry must stay visible on the
        // mounted modal (U2 correction; B5 same discipline).
        if (busyRef.current || budgetBusyRef.current) return;
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
            disabled={busy || budgetBusyRef.current}
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
            current display title, never the conversation id, members, status, or history.
          </p>
          <div className="details-rename-actions">
            <button type="submit" className="button button-primary" disabled={saveDisabled}>
              <CheckIcon size={14} />
              Save
            </button>
            <button type="button" className="button" onClick={onClose} disabled={busy || budgetBusyRef.current}>
              <XIcon size={14} />
              Cancel
            </button>
          </div>
          {renameState.phase === "error" && (
            <div className="details-rename-error" role="alert">
              <p className="error-message">{renameState.error.message}</p>
              <button type="button" className="button button-small" onClick={handleRetry}>
                <RetryIcon size={14} />
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

        <WorkflowBudgetSection
          conversationId={conversation.id}
          token={token}
          view={budgetView}
          loadError={budgetLoadError}
          drafts={budgetDrafts}
          requestError={budgetRequestError}
          savingBudget={savingBudget}
          reloadError={budgetReloadError}
          onDraftChange={(rootEventId, patch) =>
            setBudgetDrafts((previous) => ({
              ...previous,
              [rootEventId]: { edges: "", reworkRounds: "", ...previous[rootEventId], ...patch },
            }))
          }
          // B5 correction: a post-success RE-READ failure throws to the root's
          // own reload-error state (the section-level loadError is reserved
          // for the OPEN fetch) so the mounted modal keeps its bounded Retry
          // that never replays the accepted POST.
          onReload={async () => {
            setBudgetView(await fetchConversationWorkflowBudgets(conversation.id, token));
            return true;
          }}
          // B5 final correction: the INITIAL-LOAD Retry owns and catches its
          // own fetch failure — it refreshes the bounded error on another
          // failure and clears it only on success, so no rejection ever
          // escapes unhandled, and the state machine stays separate from the
          // post-accepted-POST reload Retry (which must never replay a
          // mutation).
          onReloadInitial={async () => {
            try {
              setBudgetView(await fetchConversationWorkflowBudgets(conversation.id, token));
              setBudgetLoadError(null);
            } catch (cause) {
              setBudgetLoadError(
                cause instanceof WorkflowBudgetHttpError
                  ? `Workflow budgets unavailable (HTTP ${cause.status}).`
                  : "Workflow budgets unavailable. Check the gateway and retry.",
              );
            }
          }}
          onWorkflowBudgetsChanged={onWorkflowBudgetsChanged}
          onSavingChange={(_, busy) => setSavingBudget(busy)}
          onRequestError={(rootEventId, message) =>
            setBudgetRequestError(message === null ? null : { rootEventId, message })
          }
          onReloadError={(rootEventId, message) =>
            setBudgetReloadError(message === null ? null : { rootEventId, message })
          }
        />

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
    return <p className="muted">No members yet. Mention a locally runnable agent to add one.</p>;
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
          <ReopenIcon size={14} />
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
        <ArchiveIcon size={14} />
        Archive
      </button>
      {confirmingArchive && (
        <div className="confirmation-card" role="group" aria-label="Confirm archive">
          <p>{copy.intro}</p>
          <div className="confirmation-actions">
            <button type="button" ref={confirmArchiveRef} className="button button-primary" onClick={onConfirmArchive} disabled={busy}>
              <CheckIcon size={14} />
              {copy.confirm}
            </button>
            <button type="button" className="button" onClick={onCancelArchive} disabled={busy}>
              <XIcon size={14} />
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
        <RetryIcon size={14} />
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

/**
 * B5 — W2 Conversation-level "Workflow budget" section (accepted contract
 * §5). Renders the bounded B4 server view as a distinct root list; Save
 * applies to one explicitly rendered server root only, sends the exact
 * closed B4 CAS body using the last fetched effective values, suppresses
 * Escape/Close while in flight, renders bounded failures as role="alert"
 * with explicit Retry only, and re-reads/re-gates through the navigator
 * callback on success. Zero roots render nothing; there is never a
 * per-agent budget, no storage, no polling, and no auto retry.
 */
function WorkflowBudgetSection({
  conversationId,
  token,
  view,
  loadError,
  drafts,
  savingBudget,
  requestError,
  reloadError,
  onDraftChange,
  onReload,
  onReloadInitial,
  onWorkflowBudgetsChanged,
  onSavingChange,
  onRequestError,
  onReloadError,
}: {
  conversationId: string;
  token: string;
  view: ConversationWorkflowBudgetsView | null;
  loadError: string | null;
  drafts: Record<string, WorkflowBudgetDraft>;
  savingBudget: boolean;
  requestError: { rootEventId: string; message: string } | null;
  reloadError: { rootEventId: string; message: string } | null;
  onDraftChange: (rootEventId: string, patch: Partial<WorkflowBudgetDraft>) => void;
  onReload: () => Promise<boolean>;
  onReloadInitial: () => Promise<void>;
  onWorkflowBudgetsChanged: (conversationId: string) => void;
  onSavingChange: (rootEventId: string, busy: boolean) => void;
  onRequestError: (rootEventId: string, message: string | null) => void;
  onReloadError: (rootEventId: string, message: string | null) => void;
}): ReactElement | null {
  if (loadError !== null) {
    return (
      <div className="workflow-budget" role="alert">
        <h3>Workflow budget</h3>
        <p className="error-message">{loadError}</p>
        {/* B5 final correction: the initial-load Retry uses the self-catching
            owner (never the throwing post-success re-read) so a failed retry
            refreshes the bounded error instead of escaping unhandled, and a
            successful retry clears it and renders the truthful view. */}
        <button type="button" className="button button-small" onClick={() => void onReloadInitial()}>
          <RetryIcon size={14} />
          Retry
        </button>
      </div>
    );
  }
  if (view === null || view.roots.length === 0) {
    // Zero roots: no fabricated budget, list, or control.
    return null;
  }
  return (
    <div className="workflow-budget">
      <h3>Workflow budget</h3>
      <p className="field-help">
        One finite budget per workflow root. This is a workflow coordination
        limit, not Pi context usage, and never a per-agent budget.
      </p>
      {view.roots.map((rootView) => (
        <WorkflowBudgetRoot
          key={rootView.root_event_id}
          conversationId={conversationId}
          token={token}
          root={rootView}
          draft={drafts[rootView.root_event_id] ?? { edges: "", reworkRounds: "" }}
          saving={savingBudget}
          requestError={requestError?.rootEventId === rootView.root_event_id ? requestError.message : null}
          reloadError={reloadError?.rootEventId === rootView.root_event_id ? reloadError.message : null}
          onDraftChange={onDraftChange}
          onReload={onReload}
          onWorkflowBudgetsChanged={onWorkflowBudgetsChanged}
          onSavingChange={onSavingChange}
          onRequestError={onRequestError}
          onReloadError={onReloadError}
        />
      ))}
      {view.omitted > 0 && (
        <p className="field-help">
          Showing the {view.roots.length} most recent of {view.total} workflow roots ({view.omitted} older omitted).
        </p>
      )}
    </div>
  );
}

function WorkflowBudgetRoot({
  conversationId,
  token,
  root,
  draft,
  saving,
  requestError,
  reloadError,
  onDraftChange,
  onReload,
  onWorkflowBudgetsChanged,
  onSavingChange,
  onRequestError,
  onReloadError,
}: {
  conversationId: string;
  token: string;
  root: WorkflowBudgetRootView;
  draft: WorkflowBudgetDraft;
  saving: boolean;
  requestError: string | null;
  reloadError: string | null;
  onDraftChange: (rootEventId: string, patch: Partial<WorkflowBudgetDraft>) => void;
  onReload: () => Promise<boolean>;
  onWorkflowBudgetsChanged: (conversationId: string) => void;
  onSavingChange: (rootEventId: string, busy: boolean) => void;
  onRequestError: (rootEventId: string, message: string | null) => void;
  onReloadError: (rootEventId: string, message: string | null) => void;
}): ReactElement | null {
  const busy = saving;
  const saveEnabled = isWorkflowBudgetSaveEnabled({ draft, effective: root.effective, busy });

  async function handleSave(): Promise<void> {
    const request = buildWorkflowBudgetUpdateRequest({
      rootEventId: root.root_event_id,
      draft,
      effective: root.effective,
      busy,
    });
    if (request === null) return;
    onSavingChange(root.root_event_id, true);
    onRequestError(root.root_event_id, null);
    onReloadError(root.root_event_id, null);
    try {
      await updateConversationWorkflowBudget(conversationId, request, token);
    } catch (cause) {
      // The POST failed: bounded failure with explicit Retry (resends the
      // POST). The accepted mutation was never stored.
      onRequestError(
        root.root_event_id,
        cause instanceof WorkflowBudgetHttpError
          ? cause.message
          : "The workflow budget update failed. Check the gateway and retry.",
      );
      onSavingChange(root.root_event_id, false);
      return;
    }
    // B5 correction: the POST is ACCEPTED. Re-read the bounded view FIRST;
    // only a successful re-read may invoke the navigator re-gate. A failed
    // re-read keeps the modal mounted with its own bounded Retry that NEVER
    // replays the accepted POST.
    let reloaded: boolean;
    try {
      reloaded = await onReload();
    } catch {
      reloaded = false;
    }
    if (reloaded) {
      onWorkflowBudgetsChanged(conversationId);
    } else {
      onReloadError(root.root_event_id, "Workflow budgets could not be re-read. Check the gateway and retry.");
    }
    onSavingChange(root.root_event_id, false);
  }

  /** Retry for a failed RE-READ only: never replays the accepted POST. */
  async function handleRetryReload(): Promise<void> {
    onReloadError(root.root_event_id, null);
    let reloaded: boolean;
    try {
      reloaded = await onReload();
    } catch {
      reloaded = false;
    }
    if (reloaded) onWorkflowBudgetsChanged(conversationId);
    else onReloadError(root.root_event_id, "Workflow budgets could not be re-read. Check the gateway and retry.");
  }

  return (
    <div className="workflow-budget-root">
      <p className="workflow-budget-root-id">
        Root <code>{root.root_event_id}</code>
      </p>
      <dl className="workflow-budget-facts">
        <div className="workflow-budget-fact">
          <dt>Edges</dt>
          <dd>
            consumed {root.consumed.edges} of {root.effective.edges} effective (base {root.base.edges}, remaining{" "}
            {remainingEdges(root)})
          </dd>
        </div>
        <div className="workflow-budget-fact">
          <dt>Rework rounds</dt>
          <dd>
            {root.effective.reworkRounds} effective (base {root.base.reworkRounds}); worst pair has used{" "}
            {root.worstPairOccurrences} of {1 + root.effective.reworkRounds} allowed (remaining{" "}
            {remainingReworkRounds(root)})
          </dd>
        </div>
        <div className="workflow-budget-fact">
          <dt>Depth</dt>
          <dd>Depth: {WORKFLOW_BUDGET_FIXED_DEPTH} (fixed)</dd>
        </div>
      </dl>
      <div className="workflow-budget-edit">
        <label htmlFor={`workflow-budget-edges-${root.root_event_id}`}>New edges limit</label>
        <input
          id={`workflow-budget-edges-${root.root_event_id}`}
          data-root={root.root_event_id}
          data-dimension="edges"
          type="text"
          inputMode="numeric"
          value={draft.edges}
          onChange={(event) => onDraftChange(root.root_event_id, { edges: event.target.value })}
          disabled={busy}
        />
        <label htmlFor={`workflow-budget-rework-${root.root_event_id}`}>New rework rounds limit</label>
        <input
          id={`workflow-budget-rework-${root.root_event_id}`}
          data-root={root.root_event_id}
          data-dimension="rework"
          type="text"
          inputMode="numeric"
          value={draft.reworkRounds}
          onChange={(event) => onDraftChange(root.root_event_id, { reworkRounds: event.target.value })}
          disabled={busy}
        />
        <button
          type="button"
          className="button button-small"
          aria-label={`Save workflow budget for root ${root.root_event_id}`}
          disabled={!saveEnabled}
          onClick={() => void handleSave()}
        >
          <CheckIcon size={14} />
          Save
        </button>
      </div>
      {root.warnings.length > 0 && (
        <ul className="workflow-budget-warnings">
          {root.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
          {root.omittedWarnings > 0 && <li>{root.omittedWarnings} more ignored budget update(s) not shown</li>}
        </ul>
      )}
      {requestError !== null && (
        <div className="workflow-budget-error" role="alert">
          <p className="error-message">{requestError}</p>
          <button type="button" className="button button-small" onClick={() => void handleSave()}>
            <RetryIcon size={14} />
            Retry
          </button>
        </div>
      )}
      {reloadError !== null && (
        <div className="workflow-budget-reload-error" role="alert">
          <p className="error-message">{reloadError}</p>
          <button type="button" className="button button-small" onClick={() => void handleRetryReload()}>
            <RetryIcon size={14} />
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
