import { useCallback, useEffect, useState } from "react";
import { closeStewardAlert, fetchStewardAlert, fetchStewardAlerts, UnauthorizedError } from "./api";
import { SafeMarkdownBody } from "./SafeMarkdown";
import { AlertIcon } from "./icons";
import type { StewardAlertDetail, StewardAlertSummary } from "./steward-alerts";

/**
 * S10 — shared severity pill vocabulary: high/urgent keep their established
 * error presentation; normal/low share the muted pill. Text always carries
 * the severity label, so color never encodes meaning alone.
 */
function severityPillClass(severity: StewardAlertSummary["severity"]): string {
  return severity === "high" || severity === "urgent" ? "wb-pill wb-pill-error" : "wb-pill wb-pill-muted";
}

export function StewardAlerts({
  token,
  onUnauthorized,
  onValidated,
  reloadKey,
  onClosed,
}: {
  token: string;
  onUnauthorized: () => void;
  onValidated: () => void;
  reloadKey: number;
  onClosed: () => void;
}) {
  const [alerts, setAlerts] = useState<StewardAlertSummary[]>([]);
  const [selected, setSelected] = useState<StewardAlertDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await fetchStewardAlerts(token, signal);
      setAlerts(result.alerts);
      setLoading(false);
      onValidated();
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (cause instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(cause instanceof Error ? cause.message : String(cause));
      setLoading(false);
    }
  }, [onUnauthorized, onValidated, token]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void load(controller.signal);
    return () => controller.abort();
  }, [load, reloadKey]);

  async function openAlert(summary: StewardAlertSummary) {
    setError(null);
    try {
      const detail = await fetchStewardAlert(summary.path, token);
      setSelected(detail);
      onValidated();
    } catch (cause) {
      if (cause instanceof UnauthorizedError) onUnauthorized();
      else setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function closeSelected() {
    if (selected === null || selected.status !== "open" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await closeStewardAlert(selected.path, token);
      const refreshed = await fetchStewardAlert(selected.path, token);
      setSelected(refreshed);
      await load();
      onClosed();
      onValidated();
    } catch (cause) {
      if (cause instanceof UnauthorizedError) {
        onUnauthorized();
      } else {
        // A stale close is no-action. Reread the exact selected alert and the
        // bounded list rather than claiming success or retrying the mutation.
        try {
          const refreshed = await fetchStewardAlert(selected.path, token);
          setSelected(refreshed);
          await load();
        } catch {
          // Keep the original bounded close failure visible.
        }
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="steward-alerts" aria-label="Steward Alerts">
      <header className="steward-alerts-header wb-page-header">
        <span className="wb-page-icon" aria-hidden="true">
          <AlertIcon size={18} />
        </span>
        <div className="wb-page-heading">
          <h2>Steward Alerts</h2>
        </div>
        {selected !== null && <button type="button" onClick={() => setSelected(null)}>Back to alerts</button>}
      </header>
      {error !== null && <p className="steward-alerts-error" role="alert">{error}</p>}
      {selected !== null ? (
        <article className="steward-alert-detail wb-surface wb-surface-pad">
          <p className={`steward-alert-severity severity-${selected.severity} ${severityPillClass(selected.severity)}`}>{selected.severity}</p>
          <h3>{selected.title}</h3>
          <time dateTime={selected.created}>{selected.created}</time>
          {selected.status === "open" ? (
            <button type="button" className="button" disabled={busy} onClick={() => void closeSelected()}>
              {busy ? "Closing…" : "Close alert"}
            </button>
          ) : selected.status === "resolved" ? (
            <p role="status" className="steward-alert-terminal steward-alert-terminal-resolved wb-pill wb-pill-muted">
              {selected.resolvedAt === undefined ? "Resolved" : `Resolved ${selected.resolvedAt}`}
            </p>
          ) : (
            <p role="status" className="steward-alert-terminal steward-alert-terminal-closed wb-pill wb-pill-accent">
              Closed {selected.closedAt ?? ""}
            </p>
          )}
          {selected.content !== "" && <SafeMarkdownBody text={selected.content} />}
        </article>
      ) : loading ? <p className="muted">Loading alerts…</p> : alerts.length === 0 ? <p className="muted">No steward alerts.</p> : (
        <ul className="steward-alert-list">
          {alerts.map((alert) => (
            <li key={alert.path}>
              <button type="button" className="wb-row" onClick={() => void openAlert(alert)}>
                <span className={`steward-alert-severity severity-${alert.severity} ${severityPillClass(alert.severity)}`}>{alert.severity}</span>
                <strong>{alert.title}</strong>
                <small>{alert.status} · {alert.created}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
