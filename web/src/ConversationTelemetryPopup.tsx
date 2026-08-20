import { useEffect, useRef } from "react";
import { RefreshIcon, XIcon } from "./icons";
import type { TelemetryPopupViewModel } from "./conversation-context-cards";

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
 * — the explicit Refresh control is the only fetch trigger, wired by the
 * navigator through the preserved T6 generation guard.
 *
 * Accessibility (mirrors the ConversationDetailsModal pattern): opening moves
 * focus to the Refresh control (the popup's primary explicit action);
 * Tab/Shift+Tab trap focus inside; Escape and Close dismiss (Escape is
 * suppressed while a Refresh is in flight so a bounded failure and its
 * message stay visible); dismissal returns focus to the invoking card (the
 * caller owns focus return). The bar is a non-interactive labelled
 * progressbar: aria-valuenow only for a real measured percent (including a
 * truthful 0), neutral otherwise. No animation; reduced-motion safe.
 */
export function ConversationTelemetryPopup({
  viewModel,
  busy,
  error,
  onRefresh,
  onClose,
}: {
  viewModel: TelemetryPopupViewModel;
  busy: boolean;
  error: string | null;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  // Ref mirror so the one-time document keydown listener always sees the
  // current in-flight state (never a stale render's `busy`).
  const busyRef = useRef(busy);
  busyRef.current = busy;

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
        // While a Refresh is in flight, Escape must never dismiss the popup:
        // if the request then fails, the bounded failure must stay visible.
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
            disabled={busy}
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
        <div className="telemetry-popup-actions">
          <button
            type="button"
            ref={refreshRef}
            className="button button-small telemetry-refresh"
            aria-label={viewModel.refreshLabel}
            title={viewModel.refreshLabel}
            disabled={busy}
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
