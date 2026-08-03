import { useEffect, useRef, useState } from "react";
import logoUrl from "./assets/piren-logo.png";
import { buildAuthHeaders } from "./auth";
import { fetchAuthInfo } from "./api";

/**
 * Authenticated workbench shell (ADR-0041 R3b-1). This slice ships only the
 * build foundation plus a minimal in-memory Bearer-token entry and an
 * authenticated shell: no room behavior, no timeline, no composer, no
 * approvals/abort, no service worker, no vault browser/graph, and no
 * model/thinking/provider/config/secret controls.
 */
type ShellState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "token-needed"; token: string }
  | { phase: "ready"; token: string };

const COMING_NEXT = [
  { label: "Room navigator", bullet: "R3b-2", note: "authenticated room list/create/select with immutable participants" },
  { label: "Room timeline", bullet: "R3b-3", note: "historic events plus live SSE, immutable rendering, reconnect re-read" },
  { label: "Structured dispatch", bullet: "R3b-4", note: "the video-ready \u201cPiren building itself\u201d demonstration" },
  { label: "Approval + abort controls", bullet: "R3b-5", note: "scoped approval cards and room-agent abort" },
  { label: "Accessibility completion", bullet: "R3b-6", note: "focused WCAG 2.2 AA verification" },
] as const;

function StatusBadge({ state }: { state: ShellState }) {
  const text =
    state.phase === "loading"
      ? "Connecting…"
      : state.phase === "error"
        ? "Connection error"
        : state.phase === "token-needed"
          ? "Token required"
          : "Authenticated";
  const tone =
    state.phase === "ready" ? "ok" : state.phase === "error" ? "error" : state.phase === "token-needed" ? "warn" : "idle";
  return (
    <span className={`status-badge status-${tone}`} role="status" aria-live="polite">
      {text}
    </span>
  );
}

export default function App() {
  const [state, setState] = useState<ShellState>({ phase: "loading" });
  const [retryKey, setRetryKey] = useState(0);
  const tokenInputRef = useRef<HTMLInputElement>(null);
  const [tokenHint, setTokenHint] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const info = await fetchAuthInfo(controller.signal);
        if (cancelled) return;
        setState(info.authRequired ? { phase: "token-needed", token: "" } : { phase: "ready", token: "" });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({
          phase: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [retryKey]);

  useEffect(() => {
    if (state.phase === "token-needed") tokenInputRef.current?.focus();
  }, [state.phase]);

  function handleTokenSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.phase !== "token-needed") return;
    const token = state.token.trim();
    if (token === "") {
      setTokenHint("Enter the gateway token to continue.");
      tokenInputRef.current?.focus();
      return;
    }
    setTokenHint(null);
    // In-memory only: the token lives in React state for this page load and
    // is dropped on reload. Nothing is sent yet in R3b-1; later bullets use
    // buildAuthHeaders(token) on their requests.
    setState({ phase: "ready", token });
  }

  function handleRetry() {
    setState({ phase: "loading" });
    setRetryKey((k) => k + 1);
  }

  return (
    <div className="shell">
      <header className="shell-header">
        <img src={logoUrl} alt="Piren logo" className="shell-logo" width={48} height={48} />
        <div className="shell-heading">
          <h1>Piren Workbench</h1>
          <p className="shell-subtitle">Local-first agent collaboration shell (R3b-1)</p>
        </div>
        <StatusBadge state={state} />
      </header>

      <main className="shell-main">
        {state.phase === "loading" && (
          <section className="card" aria-live="polite">
            <h2>Checking gateway authentication…</h2>
            <p>Probing the public <code>GET /api/auth/info</code> endpoint.</p>
          </section>
        )}

        {state.phase === "error" && (
          <section className="card card-error" role="alert">
            <h2>Could not reach the gateway</h2>
            <p className="error-message">
              The auth endpoint returned a failure: <code>{state.message}</code>
            </p>
            <p>
              Start the gateway with <code>piren gateway</code> and reload this page.
            </p>
            <button type="button" className="button button-primary" onClick={handleRetry}>
              Retry
            </button>
          </section>
        )}

        {state.phase === "token-needed" && (
          <section className="card">
            <h2>Gateway token required</h2>
            <p className="muted">
              This gateway host requires a bearer token. The token is kept in memory only for this
              page and is never written to storage or disk.
            </p>
            <form className="token-form" onSubmit={handleTokenSubmit}>
              <label htmlFor="token-input">Gateway token</label>
              <div className="token-row">
                <input
                  id="token-input"
                  ref={tokenInputRef}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={state.token}
                  onChange={(event) => setState({ phase: "token-needed", token: event.target.value })}
                  placeholder="Paste the gateway bearer token"
                  aria-describedby={tokenHint ? "token-hint" : undefined}
                />
                <button type="submit" className="button button-primary">
                  Connect
                </button>
              </div>
              {tokenHint ? (
                <p id="token-hint" className="error-message" role="status">
                  {tokenHint}
                </p>
              ) : (
                <p className="field-help" id="token-help">
                  Tip: run <code>piren gateway</code> with <code>--token</code> or <code>PIREN_TOKEN</code> to
                  control the token, or find it in <code>~/.config/piren/gateway-token</code>.
                </p>
              )}
            </form>
          </section>
        )}

        {state.phase === "ready" && (
          <section className="card">
            <h2>Workbench shell ready</h2>
            <p className="muted">
              This is the R3b-1 build foundation: an authenticated shell with no room behavior yet.
              No room, chat, or vault APIs have been called; the token (when provided) stays in
              memory for this page only.
            </p>
            <h3>Coming next (each separately steward-gated)</h3>
            <ul className="coming-next">
              {COMING_NEXT.map((item) => (
                <li key={item.bullet}>
                  <span className="coming-label">
                    {item.label} <code>{item.bullet}</code>
                  </span>
                  <span className="coming-note">{item.note}</span>
                </li>
              ))}
            </ul>
            <p className="muted">
              Read-only vault/graph navigation is deferred to R4; the service worker is deferred to
              R3c or later.
            </p>
          </section>
        )}
      </main>

      <footer className="shell-footer">
        <p>
          Piren — the browser is an untrusted UI client; Pi owns live sessions and the vault owns
          durable knowledge.
        </p>
      </footer>
    </div>
  );
}
