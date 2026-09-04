import { useEffect, useRef, useState } from "react";
import { RefreshIcon, RetryIcon, XIcon } from "./icons";
import { updateConversationWorkflowBudget, WorkflowBudgetHttpError, type ConversationWorkflowStatusSnapshot } from "./api";
import {
  associatedWorkflowBudgetView,
  buildAssociatedWorkflowBudgetUpdateRequest,
} from "./conversation-associated-workflow-budget";
import type { TelemetryPopupViewModel } from "./conversation-context-cards";
import { WORKFLOW_BUDGET_FIXED_DEPTH, type WorkflowBudgetDraft } from "./conversation-workflow-budget";

export interface AssociatedWorkflowBudgetPopupProps {
  conversationId: string;
  token: string;
  snapshot: ConversationWorkflowStatusSnapshot;
  /** Re-read exact workflow statuses after an accepted mutation. */
  onStatusReread: () => Promise<boolean>;
}

/**
 * Telemetry details popup (accepted design
 * `workbench-context-cards-telemetry-details-popup-design.md` §2.5/§2.6).
 *
 * One focus-managed modal dialog for one exact Conversation × agent pair,
 * opened ONLY by explicit card activation. It renders the bounded permitted
 * detail fields as concise short labelled lines (U3 amendment §6.3): agent
 * and truthful state first, then context tokens/window/percent (two-decimal
 * percent; unavailable states never fabricate a number), model, thinking,
 * and auto-compaction from the in-memory T6 entry. It never fetches on open
 * — the explicit Refresh control is the only telemetry fetch trigger, wired
 * by the navigator through the preserved T6 generation guard.
 *
 * W5b adds an adjacent Associated handoff workflow section only when the
 * gateway has already supplied an exact-pair root association. It is a shared
 * workflow-root coordination budget, never Context telemetry or an agent
 * budget. Its update uses the existing CAS route and never chooses a root.
 */
export function ConversationTelemetryPopup({
  viewModel,
  busy,
  error,
  onRefresh,
  onClose,
  workflowBudget,
}: {
  viewModel: TelemetryPopupViewModel;
  busy: boolean;
  error: string | null;
  onRefresh: () => void;
  onClose: () => void;
  workflowBudget?: AssociatedWorkflowBudgetPopupProps;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const [savingBudget, setSavingBudget] = useState(false);
  const popupBusy = busy || savingBudget;
  // Ref mirror so the one-time document keydown listener always sees the
  // current in-flight state (never a stale render's `busy`).
  const busyRef = useRef(popupBusy);
  busyRef.current = popupBusy;

  // Open focus (explicit Refresh control) + trap + Escape.
  useEffect(() => {
    refreshRef.current?.focus();
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
        // While a Refresh or budget Save is in flight, Escape must never
        // dismiss the popup: any bounded failure must remain visible.
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

  const { bar } = viewModel;
  const associatedWorkflow = workflowBudget === undefined ? null : associatedWorkflowBudgetView(workflowBudget.snapshot);
  return (
    <div className="telemetry-popup-backdrop">
      <div
        ref={dialogRef}
        id="telemetry-popup-dialog"
        className="telemetry-popup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="telemetry-popup-heading"
        tabIndex={-1}
      >
        <div className="telemetry-popup-header">
          <h2 id="telemetry-popup-heading">{viewModel.title}</h2>
          <button
            type="button"
            className="button button-small telemetry-popup-close"
            aria-label={viewModel.closeLabel}
            onClick={onClose}
            disabled={popupBusy}
          >
            <XIcon size={14} />
          </button>
        </div>
        <div className="telemetry-popup-meter">
          <span className="context-card-label">Context</span>
          <span
            className={bar.kind === "percent" ? "context-card-bar" : `context-card-bar context-card-bar-${viewModel.stateKey}`}
            role="progressbar"
            aria-label="Context"
            aria-valuemin={0}
            aria-valuemax={100}
            {...(bar.kind === "percent" ? { "aria-valuenow": bar.percent } : {})}
            aria-valuetext={viewModel.stateText}
          >
            <span className="context-card-bar-fill" style={bar.kind === "percent" ? { width: `${bar.percent}%` } : undefined} />
          </span>
        </div>
        {viewModel.fields.length > 0 && (
          <dl className="telemetry-popup-fields">
            {viewModel.fields.map((field) => (
              <div key={field.label} className="telemetry-popup-field">
                <dt>{field.label}</dt>
                <dd>{field.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {associatedWorkflow !== null && workflowBudget !== undefined && (
          <AssociatedWorkflowBudgetSection
            workflowBudget={workflowBudget}
            telemetryBusy={busy}
            onSavingChange={setSavingBudget}
          />
        )}
        <div className="telemetry-popup-actions">
          <button
            type="button"
            ref={refreshRef}
            className="button button-small telemetry-refresh"
            aria-label={viewModel.refreshLabel}
            title={viewModel.refreshLabel}
            disabled={popupBusy}
            onClick={onRefresh}
          >
            <RefreshIcon size={14} />
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        {error !== null && (
          <p className="telemetry-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function AssociatedWorkflowBudgetSection({
  workflowBudget,
  telemetryBusy,
  onSavingChange,
}: {
  workflowBudget: AssociatedWorkflowBudgetPopupProps;
  telemetryBusy: boolean;
  onSavingChange: (saving: boolean) => void;
}) {
  const workflow = associatedWorkflowBudgetView(workflowBudget.snapshot);
  const [draft, setDraft] = useState<WorkflowBudgetDraft>({ edges: "", reworkRounds: "" });
  const [saving, setSaving] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);
  if (workflow === null) return null;

  const busy = telemetryBusy || saving;
  const request = buildAssociatedWorkflowBudgetUpdateRequest({ snapshot: workflowBudget.snapshot, draft, busy });
  const remainingEdges = Math.max(0, workflow.effective.edges - workflow.consumed.edges);
  const remainingReworkRounds = Math.max(0, 1 + workflow.effective.reworkRounds - workflow.worstPairOccurrences);

  async function rereadOnly(): Promise<void> {
    setReloadError(null);
    let reread = false;
    try {
      reread = await workflowBudget.onStatusReread();
    } catch {
      reread = false;
    }
    if (!reread) setReloadError("Workflow budget could not be re-read. Check the gateway and retry.");
  }

  async function save(): Promise<void> {
    if (request === null) return;
    setSaving(true);
    onSavingChange(true);
    setRequestError(null);
    setReloadError(null);
    try {
      await updateConversationWorkflowBudget(workflowBudget.conversationId, request, workflowBudget.token);
    } catch (cause) {
      setRequestError(
        cause instanceof WorkflowBudgetHttpError
          ? cause.message
          : "The workflow budget update failed. Check the gateway and retry.",
      );
      setSaving(false);
      onSavingChange(false);
      return;
    }
    await rereadOnly();
    setSaving(false);
    onSavingChange(false);
  }

  return (
    <section className="associated-workflow-budget" aria-labelledby="associated-workflow-budget-heading">
      <h3 id="associated-workflow-budget-heading">Associated handoff workflow</h3>
      <p className="field-help">Context telemetry is separate from this workflow-root budget. Other agents can share this root.</p>
      <p className="associated-workflow-budget-root">Root <code>{workflow.rootEventId}</code></p>
      <dl className="associated-workflow-budget-facts">
        <div>
          <dt>Edges</dt>
          <dd>consumed {workflow.consumed.edges} of {workflow.effective.edges} effective (base {workflow.base.edges}, remaining {remainingEdges})</dd>
        </div>
        <div>
          <dt>Rework rounds</dt>
          <dd>{workflow.effective.reworkRounds} effective (base {workflow.base.reworkRounds}); worst pair has used {workflow.worstPairOccurrences} of {1 + workflow.effective.reworkRounds} allowed (remaining {remainingReworkRounds})</dd>
        </div>
        <div><dt>Depth</dt><dd>Depth: {WORKFLOW_BUDGET_FIXED_DEPTH} (fixed)</dd></div>
      </dl>
      <div className="associated-workflow-budget-edit">
        <label htmlFor={`associated-workflow-budget-edges-${workflow.rootEventId}`}>New edges limit</label>
        <input
          id={`associated-workflow-budget-edges-${workflow.rootEventId}`}
          type="text"
          inputMode="numeric"
          value={draft.edges}
          disabled={busy}
          onChange={(event) => setDraft((previous) => ({ ...previous, edges: event.target.value }))}
        />
        <label htmlFor={`associated-workflow-budget-rework-${workflow.rootEventId}`}>New rework rounds limit</label>
        <input
          id={`associated-workflow-budget-rework-${workflow.rootEventId}`}
          type="text"
          inputMode="numeric"
          value={draft.reworkRounds}
          disabled={busy}
          onChange={(event) => setDraft((previous) => ({ ...previous, reworkRounds: event.target.value }))}
        />
        <button
          type="button"
          className="button button-small"
          aria-label={`Save workflow budget for associated root ${workflow.rootEventId}`}
          disabled={request === null}
          onClick={() => void save()}
        >
          Save
        </button>
      </div>
      {workflow.warnings.length > 0 && (
        <ul className="associated-workflow-budget-warnings">
          {workflow.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
          {workflow.omittedWarnings > 0 && <li>{workflow.omittedWarnings} more ignored budget update(s) not shown</li>}
        </ul>
      )}
      {requestError !== null && (
        <div className="associated-workflow-budget-error" role="alert">
          <p className="error-message">{requestError}</p>
          <button type="button" className="button button-small" onClick={() => void save()}>
            <RetryIcon size={14} />
            Retry
          </button>
        </div>
      )}
      {reloadError !== null && (
        <div className="associated-workflow-budget-reload-error" role="alert">
          <p className="error-message">{reloadError}</p>
          <button type="button" className="button button-small" onClick={() => void rereadOnly()}>
            <RetryIcon size={14} />
            Retry
          </button>
        </div>
      )}
    </section>
  );
}
