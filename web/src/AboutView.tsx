import type { ShellPhase } from "./StatusBadge";

/**
 * Read-only About page (ADR-0041 R3b-2.5). Connection and status
 * information only: gateway host, whether the gateway requires a token,
 * and the current connection phase. There are no form controls and no
 * configuration of any kind here — configuration lives in local
 * installation config and agent config files and is intentionally not
 * shown or edited here.
 */
export function AboutView({ phase, authRequired }: { phase: ShellPhase; authRequired: boolean }) {
  const statusText =
    phase === "ready-local"
      ? "Gateway reachable — no token required."
      : phase === "token-ready"
        ? "Token ready — validated by your first protected request."
        : phase === "token-accepted"
          ? "Token accepted — a protected request succeeded."
          : "Connected.";
  return (
    <section className="card" aria-labelledby="about-heading">
      <h2 id="about-heading">About</h2>
      <dl className="about-list">
        <div className="about-row">
          <dt>Gateway</dt>
          <dd>{window.location.host}</dd>
        </div>
        <div className="about-row">
          <dt>Auth required</dt>
          <dd>{authRequired ? "Yes" : "No"}</dd>
        </div>
        <div className="about-row">
          <dt>Status</dt>
          <dd>{statusText}</dd>
        </div>
        <div className="about-row">
          <dt>Workbench</dt>
          <dd>Piren Workbench — local-first agent collaboration shell</dd>
        </div>
      </dl>
      <p className="muted">
        This page shows connection and status information only. Configuration lives outside the
        workbench — in local installation config and agent config files — and is intentionally <strong>not shown or edited</strong> here.
      </p>
    </section>
  );
}
