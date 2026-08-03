import { useEffect, useRef, useState, type FormEvent } from "react";
import logoUrl from "./assets/piren-logo.png";
import { buildAuthHeaders, resolveShellAuth } from "./auth";
import { fetchAuthInfo } from "./api";

/**
 * Workbench shell (ADR-0041 R3b-1). This slice ships only the build
 * foundation plus a minimal in-memory Bearer-token entry and a
 * gateway-reachable shell: no room behavior, no timeline, no composer, no
 * approvals/abort, no service worker, no vault browser/graph, and no
 * model/thinking/provider/config/secret controls.
 *
 * Honest auth state: the shell never claims a token is authenticated or
 * validated. It distinguishes a no-token localhost shell ("Gateway
 * reachable") from a token-entered shell ("Token ready"); the token is held
 * in memory only and is validated only when a later authorized slice makes
 * its first protected request.
 */
type ShellState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "token-needed"; token: string }
  | { phase: "ready-local" }
  | { phase: "token-ready"; token: string };

const COMING_NEXT = [
  { label: "Room navigator", bullet: "R3b-2", note: "room list/create/select with immutable participants" },
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
          : state.phase === "ready-local"
            ? "Gateway reachable"
            : "Token ready";
  const tone =
    state.phase === "ready-local" || state.phase === "token-ready"
      ? "ok"
      : state.phase === "error"
        ? "error"
        : state.phase === "token-needed"
          ? "warn"
          : "idle";
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
        setState(resolveShellAuth(info.authRequired, "").status === "ready-local" ? { phase: "ready-local" } : { phase: "token-needed", token: "" });
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

  function handleTokenSubmit(event: FormEvent<HTMLFormElement>) {
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
    setState({ phase: "token-ready", token });
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

        {state.phase === "ready-local" && (
          <section className="card">
            <h2>Gateway reachable</h2>
            <p className="muted">
              This host requires no token, so the shell is ready without one. No authenticated
              request has been made yet: R3b-1 only probes the public auth endpoint, and room,
              chat, or vault APIs are not called in this slice.
            </p>
            <ComingNext />
          </section>
        )}

        {state.phase === "token-ready" && (
          <section className="card">
            <h2>Token ready</h2>
            <p className="muted">
              The token is held in memory for this page only and has <strong>not been validated</strong>: no protected request has been made. Validation happens only
              when a later authorized slice makes its first authenticated request and the
              gateway accepts it. No room, chat, or vault APIs are called in this slice.
            </p>
            <ComingNext />
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

function ComingNext() {
  return (
    <>
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
        Read-only vault/graph navigation is deferred to R4; the service worker is deferred to R3c
        or later.
      </p>
    </>
  );
}
